import { describe, expect, test } from "bun:test";
import type { Engine, Harness } from "../src/config/network.ts";
import { CODEX_EMBEDDED_REASON, DST_MODEL_REASON, engineIssues, OPENCODE_STANDALONE_REASON, opencodeArgvIssues } from "../src/config/engine-rules.ts";
import { dstRefusal } from "../src/run/dst-argv.ts";
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
