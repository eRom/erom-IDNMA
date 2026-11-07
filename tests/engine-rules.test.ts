import { describe, expect, test } from "bun:test";
import type { Engine, Harness } from "../src/config/network.ts";
import { CODEX_EMBEDDED_REASON, DST_MODEL_REASON, engineIssues, OPENCODE_STANDALONE_REASON, opencodeArgvIssues } from "../src/config/engine-rules.ts";
import { dstRefusal } from "../src/run/dst-argv.ts";
import { PI_SUBCOMMANDS, piRefusal } from "../src/run/pi-argv.ts";
import { parseOpencodeArgv } from "../src/run/opencode-argv.ts";

const source = ".idnma.yml (agents.x.engines.y)";

function engine(harness: Harness, extra: { model?: string; options?: string[] } = {}): Engine {
  return { harness, options: extra.options ?? [], env: {}, ...(extra.model === undefined ? {} : { model: extra.model }) };
}

describe("engineIssues", () => {
  test("flags a codex option that leaves the shared server", () => {
    expect(engineIssues(engine("codex", { options: ["-c", "a=b"] }), source)).toEqual([
      { code: "codex-embedded-flag", field: "options", error: "config", token: "--config", message: `${source} : --config ${CODEX_EMBEDDED_REASON}` },
    ]);
  });

  test("flags an opencode option that leaves the shared service", () => {
    expect(engineIssues(engine("opencode", { options: ["--standalone"] }), source)).toEqual([
      { code: "opencode-refused-flag", field: "options", error: "config", token: "--standalone", message: `${source} : --standalone ${OPENCODE_STANDALONE_REASON}` },
    ]);
  });

  test("flags a malformed opencode session id as a usage error", () => {
    expect(engineIssues(engine("opencode", { options: ["-s", "abc"] }), source)).toEqual([
      { code: "opencode-session-form", field: "options", error: "usage", token: "abc", message: "-s : un id de session opencode commence par ses." },
    ]);
  });

  test("flags an opencode engine model without a provider", () => {
    expect(engineIssues(engine("opencode", { model: "big-pickle" }), source)).toEqual([
      {
        code: "opencode-model-form",
        field: "model",
        error: "config",
        token: "big-pickle",
        message: `${source} : model « big-pickle » n'a pas la forme <fournisseur>/<modèle>.`,
      },
    ]);
  });

  test("lets a valid -m in the options win over a malformed model", () => {
    expect(engineIssues(engine("opencode", { model: "bad", options: ["-m", "a/b"] }), source)).toEqual([]);
  });

  test("flags a malformed -m in the options as a usage error", () => {
    expect(engineIssues(engine("opencode", { options: ["-m", "bad"] }), source)).toEqual([
      { code: "opencode-model-form", field: "options", error: "usage", token: "bad", message: "--model : « bad » n'a pas la forme <fournisseur>/<modèle>." },
    ]);
  });

  test("flags a dst model", () => {
    expect(engineIssues(engine("dst", { model: "x" }), source)).toEqual([
      { code: "dst-model", field: "model", error: "config", token: "x", message: `${source} : ${DST_MODEL_REASON}.` },
    ]);
  });

  test("flags a refused dst option", () => {
    const options = ["--backend", "codex"];
    const issues = engineIssues(engine("dst", { options }), source);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "dst-refused-flag", field: "options", error: "config", message: `${source} : ${dstRefusal(options)}` });
  });

  test("reports the dst model before a refused dst option", () => {
    const codes = engineIssues(engine("dst", { model: "x", options: ["--backend", "codex"] }), source).map((issue) => issue.code);
    expect(codes).toEqual(["dst-model", "dst-refused-flag"]);
  });

  test("flags a pi option that takes pi out of its terminal UI", () => {
    const options = ["--thinking", "high", "-p"];
    expect(engineIssues(engine("pi", { model: "ollama/deepseek-v4.1-flash:cloud", options }), source)).toEqual([
      { code: "pi-refused-flag", field: "options", error: "config", message: `${source} : ${piRefusal(options)}` },
    ]);
  });

  test("accepts a pi engine with a provider/model and interactive options", () => {
    expect(engineIssues(engine("pi", { model: "ollama/deepseek-v4.1-flash:cloud", options: ["--thinking", "high", "-ne", "--no-session"] }), source)).toEqual([]);
  });

  test.each(["claude", "grok", "agy"] as const)("accepts any options for %s", (harness) => {
    expect(engineIssues(engine(harness, { model: "x", options: ["--config", "a=b", "--standalone", "-s", "abc", "--backend", "codex"] }), source)).toEqual([]);
  });
});

describe("opencodeArgvIssues", () => {
  test("reports a malformed session before a malformed model", () => {
    const parsed = parseOpencodeArgv(["-s", "abc", "-m", "bad"]);
    expect(opencodeArgvIssues(parsed, undefined, source).map((issue) => issue.code)).toEqual(["opencode-session-form", "opencode-model-form"]);
  });

  test("checks the engine model only when no -m is given", () => {
    expect(opencodeArgvIssues(parseOpencodeArgv([]), "bad", source).map((issue) => issue.field)).toEqual(["model"]);
    expect(opencodeArgvIssues(parseOpencodeArgv(["-m", "a/b"]), "bad", source)).toEqual([]);
  });

  test("accepts a session id and a model with a variant", () => {
    expect(opencodeArgvIssues(parseOpencodeArgv(["-s", "ses_1", "-m", "a/b#fast"]), undefined, source)).toEqual([]);
  });
});

describe("piRefusal", () => {
  test.each(["-p", "--print", "--mode", "--mode=json", "--export", "--list-models", "-h", "--help", "-v", "--version"])("refuses %s, which leaves the terminal UI", (flag) => {
    const refusal = piRefusal(["--model", "ollama/x", flag]);
    expect(refusal).toBeDefined();
    expect(refusal).toContain(flag.split("=", 1)[0]!);
  });

  test("refuses a pi subcommand typed as the first positional only", () => {
    for (const command of PI_SUBCOMMANDS) {
      expect(piRefusal([command])).toContain(command);
      expect(piRefusal(["--model", "ollama/x", command])).toContain(command);
      expect(piRefusal(["--", command])).toContain(command);
    }
    // Plus loin, c'est un message pour le premier tour, pas une sous-commande.
    expect(piRefusal(["explique", "install"])).toBeUndefined();
  });

  test("the value of a value flag is never a positional, attached or not", () => {
    expect(piRefusal(["--model", "list"])).toBeUndefined();
    expect(piRefusal(["-n", "update", "--session", "config"])).toBeUndefined();
    expect(piRefusal(["--append-system-prompt", "auth", "-e", "mcp"])).toBeUndefined();
    expect(piRefusal(["--model=ollama/x", "list"])).toContain("list");
  });

  test("accepts the flags that keep pi interactive", () => {
    expect(piRefusal(["--thinking", "high", "-c", "-ne", "-nt", "-xt", "bash", "--no-session", "--offline", "fix the bug"])).toBeUndefined();
  });
});
