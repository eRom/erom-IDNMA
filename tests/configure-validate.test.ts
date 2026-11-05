import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EngineIssueCode, engineIssues } from "../src/config/engine-rules.ts";
import { loadAgentEngine } from "../src/config/network.ts";
import { ConfigDocument } from "../src/configure/document.ts";
import type { IssueView } from "../src/configure/types.ts";
import { collectIssues } from "../src/configure/validate.ts";
import { buildView } from "../src/configure/view.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");
const example = readFileSync(join(import.meta.dir, "..", ".idnma.example.yml"), "utf-8");

const savedConfigDir = process.env.IDNMA_CONFIG_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = savedConfigDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function issuesOf(text: string): IssueView[] {
  return collectIssues(ConfigDocument.parse(text));
}

function errorsOf(text: string): IssueView[] {
  return issuesOf(text).filter((issue) => issue.severity === "error");
}

/** Pose le texte dans un dossier de config temporaire, comme le fait un Save, pour `loadAgentEngine`. */
function useConfig(text: string): void {
  const dir = mkdtempSync("/tmp/idnma-t-");
  tempDirs.push(dir);
  writeFileSync(join(dir, ".idnma.yml"), text);
  process.env.IDNMA_CONFIG_DIR = dir;
}

/** Fichier à un agent `x` dont le corps de l'engine `default` est donné tel quel (indenté de 8). */
function oneEngine(body: string, extra = ""): string {
  return `agents:\n  x:\n    label: X\n    engines:\n      default:\n${body}${extra}`;
}

describe("configure validation", () => {
  test("the real files are clean", () => {
    for (const text of [romain, linked, example]) {
      expect(issuesOf(text).filter((issue) => issue.severity === "error")).toEqual([]);
    }
  });

  test("a new file and a file with a syntax error report nothing", () => {
    expect(collectIssues(ConfigDocument.parse(undefined))).toEqual([]);
    const broken = ConfigDocument.parse("agents:\n  a: [unclosed\n");
    expect(broken.parseError).toBeDefined();
    expect(collectIssues(broken)).toEqual([]);
  });

  test("buildView carries the issues of the document", () => {
    const text = oneEngine("        harness: foo\n");
    const view = buildView(ConfigDocument.parse(text), "/tmp/.idnma.yml", false);
    expect(view.issues).toEqual(issuesOf(text));
    expect(view.issues).toHaveLength(1);
  });

  test("a number in a provider is one quotable issue", () => {
    const text = `presets:
  lmstudio: &lmstudio
    ANTHROPIC_BASE_URL: "http://localhost:1234"
    CLAUDE_CODE_ATTRIBUTION_HEADER: 0
agents:
  oss20:
    label: GPT OSS 20B
    engines:
      default:
        harness: claude
        model: openai/gpt-oss-20b
        env:
          <<: *lmstudio
`;
    const issues = issuesOf(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "error",
      code: "not-text",
      preset: "lmstudio",
      field: "env.CLAUDE_CODE_ATTRIBUTION_HEADER",
      fix: "quote",
      message: 'A number. Values must be text: write it as "0".',
    });
    expect(issues[0]?.agent).toBeUndefined();

    const config = ConfigDocument.parse(text);
    config.apply({ op: "quoteValue", path: ["presets", "lmstudio", "CLAUDE_CODE_ATTRIBUTION_HEADER"] });
    expect(collectIssues(config)).toEqual([]);
    useConfig(config.toText());
    expect(() => loadAgentEngine("oss20")).not.toThrow();
  });

  test("a number written in the engine itself is reported on the engine, with its text as written", () => {
    const text = oneEngine("        harness: claude\n        env:\n          PRICE: 3.80\n          FLAG: true\n");
    const issues = issuesOf(text);
    expect(issues.map((issue) => [issue.code, issue.agent, issue.engine, issue.field, issue.fix])).toEqual([
      ["not-text", "x", "default", "env.PRICE", "quote"],
      ["not-text", "x", "default", "env.FLAG", "quote"],
    ]);
    expect(issues[0]?.message).toBe('A number. Values must be text: write it as "3.80".');
    expect(issues[1]?.message).toBe('A boolean. Values must be text: write it as "true".');
  });

  test("a number in an option list is one issue on the list item", () => {
    const own = errorsOf(oneEngine("        harness: claude\n        options: [--effort, 5]\n"));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ code: "not-text", agent: "x", engine: "default", field: "options.1", fix: "quote" });

    const viaPreset = errorsOf(`presets:\n  fast: &fast [--effort, 5]\n${oneEngine("        harness: claude\n        options: *fast\n")}`);
    expect(viaPreset).toHaveLength(1);
    expect(viaPreset[0]).toMatchObject({ code: "not-text", preset: "fast", field: "options.1", fix: "quote" });
    expect(viaPreset[0]?.agent).toBeUndefined();
  });

  test("an empty provider variable is a shape warning on the preset, and the engine that merges it is refused", () => {
    const text = `presets:\n  p: &p\n    K:\n${oneEngine("        harness: claude\n        env:\n          <<: *p\n")}`;
    const issues = issuesOf(text);
    expect(issues.find((issue) => issue.code === "preset-shape")).toMatchObject({ severity: "warning", preset: "p", message: "Neither a provider nor an option set." });
    const refused = issues.filter((issue) => issue.severity === "error");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ code: "schema", agent: "x", engine: "default", field: "env.K", message: "Must be text." });
    useConfig(text);
    expect(() => loadAgentEngine("x")).toThrow();
  });

  test("a preset that is neither a table of texts nor a list is a warning, never an error", () => {
    const issues = issuesOf(`presets:\n  odd: &odd {A: {B: c}}\n  word: plain\n${oneEngine("        harness: claude\n")}`);
    expect(issues.map((issue) => [issue.severity, issue.code, issue.preset])).toEqual([
      ["warning", "preset-shape", "odd"],
      ["warning", "preset-shape", "word"],
    ]);
  });
});

describe("engine rules match idnma run", () => {
  const rows: { name: string; body: string; code: EngineIssueCode; field: string }[] = [
    { name: "codex embedded flag", body: "        harness: codex\n        options: [-c, a=b]\n", code: "codex-embedded-flag", field: "options" },
    { name: "opencode refused flag", body: "        harness: opencode\n        options: [--standalone]\n", code: "opencode-refused-flag", field: "options" },
    { name: "opencode session form", body: "        harness: opencode\n        options: [-s, abc]\n", code: "opencode-session-form", field: "options" },
    { name: "opencode model form", body: "        harness: opencode\n        model: big-pickle\n", code: "opencode-model-form", field: "model" },
    { name: "opencode -m form", body: "        harness: opencode\n        options: [-m, bad]\n", code: "opencode-model-form", field: "options" },
    { name: "dst model", body: "        harness: dst\n        model: x\n", code: "dst-model", field: "model" },
    { name: "dst refused flag", body: "        harness: dst\n        options: [--backend, codex]\n", code: "dst-refused-flag", field: "options" },
  ];

  test.each(rows)("$name is reported where it is fixed and refused by idnma run", ({ body, code, field }) => {
    const text = oneEngine(body);
    const issues = issuesOf(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code, agent: "x", engine: "default", field });

    // `idnma run` applique les mêmes contrôles à l'engine chargé, avec le même code.
    useConfig(text);
    const { engine } = loadAgentEngine("x");
    expect(engineIssues(engine, "x").map((issue) => issue.code)).toEqual([code]);
  });

  test("the messages read as the table says", () => {
    const message = (body: string): string | undefined => errorsOf(oneEngine(body))[0]?.message;
    expect(message("        harness: codex\n        options: [-c, a=b]\n")).toBe(
      "--config starts Codex outside its shared server: idnma could not deliver bus messages.",
    );
    expect(message("        harness: opencode\n        options: [--standalone]\n")).toBe(
      "--standalone starts opencode outside its shared service: idnma could not deliver bus messages.",
    );
    expect(message("        harness: opencode\n        options: [-s, abc]\n")).toBe('An opencode session id starts with "ses".');
    expect(message("        harness: opencode\n        model: big-pickle\n")).toBe("The model must read <provider>/<model>.");
    expect(message("        harness: dst\n        model: x\n")).toBe("dst takes no model at launch: pick it with /model inside dst.");
    expect(message("        harness: dst\n        options: [--backend, codex]\n")).toBe("This option has no place in a bus pane for dst.");
  });

  test("a valid engine of each harness raises nothing", () => {
    const bodies = [
      "        harness: claude\n        model: opus\n        options: [--effort, max]\n",
      "        harness: codex\n        model: gpt-5\n",
      "        harness: grok\n",
      "        harness: agy\n",
      "        harness: opencode\n        model: openrouter/qwen\n        options: [-s, ses_1]\n",
      "        harness: dst\n",
    ];
    for (const body of bodies) expect(issuesOf(oneEngine(body))).toEqual([]);
  });

  test("the engine rules are checked on the engines other than default too", () => {
    const text = oneEngine("        harness: claude\n", "      codex:\n        harness: codex\n        options: [--search]\n");
    const issues = issuesOf(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "codex-embedded-flag", agent: "x", engine: "codex", field: "options" });
  });
});

describe("app rules", () => {
  test("a missing label is an error on the agent", () => {
    const issues = issuesOf("agents:\n  x:\n    engines:\n      default:\n        harness: claude\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "label-missing", agent: "x", field: "label", message: "Label is required." });
  });

  test("an empty or blank label is missing too", () => {
    for (const label of ['""', "'   '", "~"]) {
      const text = `agents:\n  x:\n    label: ${label}\n    engines:\n      default:\n        harness: claude\n`;
      expect(issuesOf(text).map((issue) => issue.code)).toEqual(["label-missing"]);
    }
  });

  test("an agent key starting with a dash, or with a forbidden character, is an error", () => {
    for (const key of ["-x", "a b", "a/b"]) {
      const text = `agents:\n  "${key}":\n    label: X\n    engines:\n      default:\n        harness: claude\n`;
      const issues = issuesOf(text);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: "error",
        code: "key-form",
        agent: key,
        message: "Use letters, digits, dot, dash or underscore, without a leading dash.",
      });
      expect(issues[0]?.engine).toBeUndefined();
    }
  });

  test("an engine name follows the same form", () => {
    const issues = issuesOf("agents:\n  x:\n    label: X\n    engines:\n      default:\n        harness: claude\n      -fast:\n        harness: claude\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "key-form", agent: "x", engine: "-fast" });
  });

  test("an agent without engines is one no-engine error, with no schema noise", () => {
    for (const body of ["    label: X\n", "    label: X\n    engines:\n", "    label: X\n    engines: {}\n", "    label: X\n    engines: [a]\n"]) {
      const issues = issuesOf(`agents:\n  x:\n${body}`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: "error", code: "no-engine", agent: "x", message: "Add at least one engine." });
    }
  });

  test("an agent without a default engine is an error naming the command", () => {
    const issues = issuesOf("agents:\n  x:\n    label: X\n    engines:\n      dst:\n        harness: dst\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "error",
      code: "no-default-engine",
      agent: "x",
      message: "No default engine: idnma run x would fail.",
    });
  });

  test("a variable name that is not a shell name is an error on the variable", () => {
    const issues = issuesOf(oneEngine('        harness: claude\n        env:\n          MY VAR: "1"\n'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "env-name-form", agent: "x", engine: "default", field: "env.MY VAR", message: "Not a valid variable name." });
  });

  test("a variable name in a preset is checked on the preset", () => {
    const issues = issuesOf(`presets:\n  p: &p\n    "MY VAR": "1"\n${oneEngine("        harness: claude\n        env:\n          <<: *p\n")}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "env-name-form", preset: "p", field: "env.MY VAR" });
    expect(issues[0]?.agent).toBeUndefined();
  });

  test("an unknown harness is a schema error on the harness field", () => {
    for (const body of ["        harness: foo\n", "        model: opus\n"]) {
      const issues = issuesOf(oneEngine(body));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: "error",
        code: "schema",
        agent: "x",
        engine: "default",
        field: "harness",
        message: "Harness must be one of claude, codex, grok, agy, opencode, dst.",
      });
    }
  });

  test("an unknown key is a schema error naming the key", () => {
    const issues = issuesOf(oneEngine("        harness: claude\n        option: [--x]\n"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "schema", agent: "x", engine: "default", field: "option", message: 'Unknown key "option".' });
  });

  test("a model that is not text is a schema error, and the wrong shapes read as such", () => {
    const model = issuesOf(oneEngine("        harness: claude\n        model: 5\n"));
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ code: "schema", field: "model", message: "Must be text." });

    const options = issuesOf(oneEngine("        harness: claude\n        options: --x\n"));
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ code: "schema", field: "options", message: "Must be a list." });

    const engine = issuesOf("agents:\n  x:\n    label: X\n    engines:\n      default: nope\n");
    expect(engine).toHaveLength(1);
    expect(engine[0]).toMatchObject({ code: "schema", agent: "x", engine: "default", message: "Must be a table." });
  });

  test("the schema is checked engine by engine: a broken engine does not hide the next agent", () => {
    const text = `agents:
  a:
    label: A
    engines:
      default:
        harness: foo
  b:
    label: B
    engines:
      default:
        harness: dst
        model: x
`;
    expect(issuesOf(text).map((issue) => [issue.agent, issue.code])).toEqual([
      ["a", "schema"],
      ["b", "dst-model"],
    ]);
  });

  test("an engine that fails the schema gets no rule check on top", () => {
    const issues = issuesOf(oneEngine("        harness: dst\n        model: x\n        option: [--x]\n"));
    expect(issues.map((issue) => issue.code)).toEqual(["schema"]);
  });

  test("duplicate labels warn on both agents and block nothing", () => {
    const text = `agents:
  luna:
    label: Luna
    engines:
      default:
        harness: claude
  luna2:
    label: Luna
    engines:
      default:
        harness: claude
`;
    const issues = issuesOf(text);
    expect(issues.map((issue) => [issue.severity, issue.code, issue.agent, issue.field, issue.message])).toEqual([
      ["warning", "label-duplicate", "luna", "label", "Same label as luna2."],
      ["warning", "label-duplicate", "luna2", "label", "Same label as luna."],
    ]);
  });

  test("one fault is one issue", () => {
    // Un nombre qui vient d'un preset ne se répète pas sur chacun des engines qui le fusionnent.
    const text = `presets:
  p: &p
    N: 1
agents:
  a:
    label: A
    engines:
      default:
        harness: claude
        env:
          <<: *p
  b:
    label: B
    engines:
      default:
        harness: claude
        env:
          <<: *p
`;
    expect(issuesOf(text).map((issue) => [issue.code, issue.preset, issue.agent])).toEqual([["not-text", "p", undefined]]);
  });
});
