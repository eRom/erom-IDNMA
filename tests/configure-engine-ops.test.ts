import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNode, parseDocument, visit } from "yaml";
import { ConfigDocument } from "../src/configure/document.ts";
import type { EditOp } from "../src/configure/types.ts";
import { buildView } from "../src/configure/view.ts";
import { changedLines, edit, refusal } from "./helpers/configure-edit.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");

/** Lecture du texte avec fusion résolue : ce que `idnma run` voit. */
function read(text: string): any {
  return parseDocument(text, { merge: true }).toJS();
}

function anchorNames(text: string): string[] {
  const names: string[] = [];
  visit(parseDocument(text, { merge: true }), (_key, node) => {
    if (isNode(node) && node.anchor) names.push(node.anchor);
  });
  return names;
}

function engineView(config: ConfigDocument, agent: string, engine: string) {
  const found = buildView(config, "/tmp/.idnma.yml", false)
    .agents.find((a) => a.key === agent)
    ?.engines.find((e) => e.name === engine);
  if (!found) throw new Error(`engine introuvable : ${agent}/${engine}`);
  return found;
}

/** Un fichier minimal : un preset provider, un preset d'options, un engine non claude qui fusionne le provider. */
const OPENCODE_MERGE = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
    ANTHROPIC_API_KEY: ""

agents:
  a:
    label: A
    engines:
      default:
        harness: opencode
        env:
          <<: *ollama
          X: "1"
      bare:
        harness: opencode
        env:
          <<: *ollama
`;

describe("configure engine operations", () => {
  test("changing a model touches one line", () => {
    const { text } = edit(romain, { op: "setModel", agent: "deepseek-flash", engine: "opencode", value: "ollama-cloud/deepseek-v4.2" });
    expect(changedLines(romain, text)).toEqual({
      removed: ["        model: ollama-cloud/deepseek-v4.1-flash"],
      added: ["        model: ollama-cloud/deepseek-v4.2"],
    });
  });

  test("typed values read back as the same strings", () => {
    for (const v of ["4.7", "0", "yes", "null", "~", "#x", "a: b", "*x", "&x", "- x"]) {
      const { text } = edit(
        romain,
        { op: "setModel", agent: "opus", engine: "default", value: v },
        { op: "setEnvVar", agent: "opus", engine: "default", name: "X", value: v },
        { op: "setOptions", agent: "opus", engine: "default", options: { kind: "custom", values: [v] } },
      );
      const engine = read(text).agents.opus.engines.default;
      expect(engine.model).toBe(v);
      expect(engine.env.X).toBe(v);
      expect(engine.options[0]).toBe(v);
      expect(text.split("\n").find((line) => line.trim().startsWith("X:"))).toMatch(/^\s+X: "/);
    }
  });

  test("an empty model removes the key like null", () => {
    const { text } = edit(romain, { op: "setModel", agent: "opus", engine: "default", value: "" });
    expect(changedLines(romain, text)).toEqual({ removed: ["        model: opus"], added: [] });
  });

  test("a model added to an engine without one goes after the harness", () => {
    const { text } = edit(linked, { op: "setModel", agent: "codex", engine: "default", value: "gpt-6" });
    expect(changedLines(linked, text)).toEqual({ removed: [], added: ["        model: gpt-6"] });
    expect(text).toContain("        harness: codex\n        model: gpt-6\n        options:");
  });

  test("picking another provider swaps the alias", () => {
    const { text } = edit(romain, { op: "setProvider", agent: "qwen-max", engine: "default", provider: { kind: "preset", name: "ollama" } });
    expect(changedLines(romain, text)).toEqual({ removed: ["          <<: *openrouter"], added: ["          <<: *ollama"] });
  });

  test("a provider on an engine without env creates a real merge key", () => {
    const { config, text } = edit(romain, { op: "setProvider", agent: "opus", engine: "default", provider: { kind: "preset", name: "ollama" } });
    expect(changedLines(romain, text)).toEqual({ removed: [], added: ["        env:", "          <<: *ollama"] });
    expect(text).not.toContain('"<<"');
    expect(engineView(config, "opus", "default").provider).toEqual({ kind: "preset", name: "ollama" });
    expect(read(text).agents.opus.engines.default.env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  });

  test("anthropic removes the merge and an empty env", () => {
    const { text } = edit(romain, { op: "setProvider", agent: "mistral", engine: "default", provider: { kind: "anthropic" } });
    expect(changedLines(romain, text)).toEqual({ removed: ["        env:", "          <<: *ollama"], added: [] });
    expect(read(text).agents.mistral.engines.default).not.toHaveProperty("env");
  });

  test("custom env copies the preset values", () => {
    const before = read(romain);
    const { text } = edit(romain, { op: "setProvider", agent: "muse", engine: "default", provider: { kind: "custom" } });
    const museBlock = text.slice(text.indexOf("  muse:"), text.indexOf("  grok:"));
    expect(museBlock).not.toContain("<<");
    expect(read(text).agents.muse.engines.default.env).toEqual(before.presets.openrouter);
    // Les trois clés sont en clair, valeurs entre guillemets doubles.
    expect(museBlock.match(/^ {10}ANTHROPIC_\w+: ".*"$/gm)?.length).toBe(3);
    expect(museBlock.split("\n").some((line) => line.startsWith('          ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY"'))).toBe(true);
  });

  test("custom env keeps the engine's own override and the effective env", () => {
    const source = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
    ANTHROPIC_API_KEY: ""

agents:
  a:
    label: A
    engines:
      default:
        harness: claude
        env:
          <<: *ollama
          ANTHROPIC_API_KEY: "mine"
`;
    const { text } = edit(source, { op: "setProvider", agent: "a", engine: "default", provider: { kind: "custom" } });
    expect(read(text).agents.a.engines.default.env).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_API_KEY: "mine" });
    expect(text).not.toContain("<<");
  });

  test("custom on an engine without a provider changes nothing", () => {
    const { text } = edit(romain, { op: "setProvider", agent: "opus", engine: "default", provider: { kind: "custom" } });
    expect(text).toBe(romain);
  });

  test("a provider only applies to claude engines", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setProvider", agent: "grok", engine: "default", provider: { kind: "preset", name: "ollama" } })).toMatch(/claude/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("a provider must be a preset of the file that holds variables", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setProvider", agent: "opus", engine: "default", provider: { kind: "preset", name: "ghost" } })).toMatch(/ghost/);
    expect(refusal(config, { op: "setProvider", agent: "opus", engine: "default", provider: { kind: "preset", name: "claude-max" } })).toMatch(/claude-max/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("a built-in preset missing from the file is refused by name until it can be written", () => {
    const config = ConfigDocument.parse(linked);
    expect(refusal(config, { op: "setProvider", agent: "claude", engine: "default", provider: { kind: "preset", name: "lmstudio" } })).toMatch(/lmstudio/);
  });

  test("custom options copy the preset values in the file's list style", () => {
    const values = ["--effort", "max", "--remote-control"];
    const inline = edit(romain, { op: "setOptions", agent: "glm", engine: "default", options: { kind: "custom", values } });
    expect(changedLines(romain, inline.text)).toEqual({
      removed: ["        options: *claude-max"],
      added: ["        options: [--effort, max, --remote-control]"],
    });
    const block = edit(linked, { op: "setOptions", agent: "glm", engine: "default", options: { kind: "custom", values } });
    expect(changedLines(linked, block.text)).toEqual({
      removed: ["        options: *claude-max"],
      added: ["        options:", "          - --effort", "          - max", "          - --remote-control"],
    });
  });

  test("editing a custom list keeps its own style", () => {
    const inline = edit(romain, { op: "setOptions", agent: "opus", engine: "default", options: { kind: "custom", values: ["--effort", "high"] } });
    expect(changedLines(romain, inline.text)).toEqual({
      removed: ["        options: [--effort, medium, --dangerously-skip-permissions, --remote-control]"],
      added: ["        options: [--effort, high]"],
    });
    const block = edit(linked, { op: "setOptions", agent: "claude", engine: "default", options: { kind: "custom", values: ["--effort", "high"] } });
    expect(read(block.text).agents.claude.engines.default.options).toEqual(["--effort", "high"]);
    expect(block.text).toContain("          - --effort\n          - high\n  glm:");
  });

  test("a list added to an engine without one goes between the harness and the env", () => {
    const { text } = edit(romain, { op: "setOptions", agent: "deepseek-flash", engine: "dst", options: { kind: "custom", values: ["--x"] } });
    expect(text).toContain('        harness: dst\n        options: [--x]\n        env:\n          DSH_PERMISSION_MODE: "danger-full-access"');
  });

  test("an option set is picked by alias and none removes the key", () => {
    const picked = edit(romain, { op: "setOptions", agent: "opus", engine: "default", options: { kind: "preset", name: "claude-max" } });
    expect(changedLines(romain, picked.text)).toEqual({
      removed: ["        options: [--effort, medium, --dangerously-skip-permissions, --remote-control]"],
      added: ["        options: *claude-max"],
    });
    expect(read(picked.text).agents.opus.engines.default.options).toEqual(["--effort", "max", "--dangerously-skip-permissions"]);

    const none = edit(romain, { op: "setOptions", agent: "glm", engine: "default", options: { kind: "none" } });
    expect(changedLines(romain, none.text)).toEqual({ removed: ["        options: *claude-max"], added: [] });
    const emptyList = edit(romain, { op: "setOptions", agent: "glm", engine: "default", options: { kind: "custom", values: [] } });
    expect(emptyList.text).toBe(none.text);
  });

  test("an option set must be a list preset of the file", () => {
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "setOptions", agent: "opus", engine: "default", options: { kind: "preset", name: "ollama" } })).toMatch(/ollama/);
    expect(refusal(config, { op: "setOptions", agent: "opus", engine: "default", options: { kind: "preset", name: "ghost" } })).toMatch(/ghost/);
  });

  test("changing harness drops what the new one cannot use", () => {
    const toOpencode = edit(romain, { op: "setHarness", agent: "deepseek-flash", engine: "default", harness: "opencode" });
    expect(changedLines(romain, toOpencode.text)).toEqual({
      removed: ["        harness: claude", "        options: *claude-max", "        env:", "          <<: *ollama"],
      added: ["        harness: opencode"],
    });
    expect(read(toOpencode.text).agents["deepseek-flash"].engines.default.model).toBe("deepseek-v4.1-flash:cloud[1m]");

    const toDst = edit(romain, { op: "setHarness", agent: "deepseek-flash", engine: "default", harness: "dst" });
    expect(changedLines(romain, toDst.text)).toEqual({
      removed: ["        harness: claude", "        model: deepseek-v4.1-flash:cloud[1m]", "        options: *claude-max", "        env:", "          <<: *ollama"],
      added: ["        harness: dst"],
    });
  });

  test("changing harness keeps the engine's own env keys", () => {
    const { text } = edit(romain, { op: "setHarness", agent: "deepseek-flash", engine: "dst", harness: "codex" });
    expect(changedLines(romain, text)).toEqual({ removed: ["        harness: dst"], added: ["        harness: codex"] });

    const withOwn = edit(
      romain,
      { op: "setEnvVar", agent: "glm", engine: "default", name: "OWN", value: "1" },
      { op: "setHarness", agent: "glm", engine: "default", harness: "codex" },
    );
    expect(read(withOwn.text).agents.glm.engines.default.env).toEqual({ OWN: "1" });
    expect(withOwn.text).not.toContain("<<: *ollama\n          OWN");
  });

  test("changing harness between two non-claude harnesses keeps a merge the engine carries", () => {
    const { text } = edit(OPENCODE_MERGE, { op: "setHarness", agent: "a", engine: "default", harness: "codex" });
    expect(changedLines(OPENCODE_MERGE, text)).toEqual({ removed: ["        harness: opencode"], added: ["        harness: codex"] });
  });

  test("changing harness is refused while a dropped value is shared", () => {
    const config = ConfigDocument.parse(linked);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setHarness", agent: "deepseek", engine: "default", harness: "dst" })).toMatch(/&deepseek-flash/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("removeMerge on a non-claude engine removes only the merge pair", () => {
    const { text } = edit(OPENCODE_MERGE, { op: "removeMerge", agent: "a", engine: "default" });
    expect(changedLines(OPENCODE_MERGE, text)).toEqual({ removed: ["          <<: *ollama"], added: [] });
    const bare = edit(OPENCODE_MERGE, { op: "removeMerge", agent: "a", engine: "bare" });
    expect(changedLines(OPENCODE_MERGE, bare.text)).toEqual({ removed: ["        env:", "          <<: *ollama"], added: [] });
  });

  test("env variables are added, renamed, changed and deleted in place", () => {
    const added = edit(romain, { op: "setEnvVar", agent: "glm", engine: "default", name: "CLAUDE_CODE_EFFORT_LEVEL", value: "max" });
    expect(changedLines(romain, added.text)).toEqual({ removed: [], added: ['          CLAUDE_CODE_EFFORT_LEVEL: "max"'] });

    const changed = edit(added.config.toText(), { op: "setEnvVar", agent: "glm", engine: "default", name: "CLAUDE_CODE_EFFORT_LEVEL", value: "high" });
    expect(changedLines(added.text, changed.text)).toEqual({
      removed: ['          CLAUDE_CODE_EFFORT_LEVEL: "max"'],
      added: ['          CLAUDE_CODE_EFFORT_LEVEL: "high"'],
    });

    const renamed = edit(changed.text, {
      op: "setEnvVar",
      agent: "glm",
      engine: "default",
      name: "CLAUDE_CODE_EFFORT",
      previousName: "CLAUDE_CODE_EFFORT_LEVEL",
      value: "high",
    });
    expect(changedLines(changed.text, renamed.text)).toEqual({
      removed: ['          CLAUDE_CODE_EFFORT_LEVEL: "high"'],
      added: ['          CLAUDE_CODE_EFFORT: "high"'],
    });

    const deleted = edit(renamed.text, { op: "deleteEnvVar", agent: "glm", engine: "default", name: "CLAUDE_CODE_EFFORT" });
    expect(deleted.text).toBe(romain);
  });

  test("deleting the last own variable removes the env key", () => {
    const { text } = edit(romain, { op: "deleteEnvVar", agent: "deepseek-flash", engine: "dst", name: "DSH_PERMISSION_MODE" });
    expect(changedLines(romain, text)).toEqual({ removed: ["        env:", '          DSH_PERMISSION_MODE: "danger-full-access"'], added: [] });
  });

  test("refuses a bad env variable name, a clash and a missing variable", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setEnvVar", agent: "opus", engine: "default", name: "<<", value: "x" })).toMatch(/<</);
    expect(refusal(config, { op: "setEnvVar", agent: "opus", engine: "default", name: "A B", value: "x" })).toMatch(/A B/);
    expect(refusal(config, { op: "setEnvVar", agent: "deepseek-flash", engine: "dst", name: "NEW", previousName: "GHOST", value: "x" })).toMatch(/GHOST/);
    expect(refusal(config, { op: "deleteEnvVar", agent: "deepseek-flash", engine: "dst", name: "GHOST" })).toMatch(/GHOST/);
    expect(config.doc.toString()).toBe(treeBefore);

    const twoVars = ConfigDocument.parse(linked);
    expect(
      refusal(twoVars, {
        op: "setEnvVar",
        agent: "glm",
        engine: "default",
        name: "ANTHROPIC_MODEL",
        previousName: "CLAUDE_CODE_EFFORT_LEVEL",
        value: "x",
      }),
    ).toMatch(/ANTHROPIC_MODEL/);
  });

  test("unlink replaces an alias by its text and drops an unused anchor", () => {
    const op: EditOp = { op: "unlink", path: ["agents", "glm", "engines", "default", "env", "ANTHROPIC_DEFAULT_OPUS_MODEL"] };
    const { text } = edit(linked, op);
    expect(changedLines(linked, text)).toEqual({
      removed: ["          ANTHROPIC_DEFAULT_FABLE_MODEL: &glm glm-5.3:cloud[1m]", "          ANTHROPIC_DEFAULT_OPUS_MODEL: *glm"],
      added: ["          ANTHROPIC_DEFAULT_FABLE_MODEL: glm-5.3:cloud[1m]", "          ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.3:cloud[1m]"],
    });
    expect(anchorNames(text)).not.toContain("glm");
    expect(read(text)).toEqual(read(linked));
  });

  test("unlink keeps an anchor that other aliases still use", () => {
    const { text } = edit(linked, { op: "unlink", path: ["agents", "glm", "engines", "default", "env", "ANTHROPIC_DEFAULT_SONNET_MODEL"] });
    expect(changedLines(linked, text)).toEqual({
      removed: ["          ANTHROPIC_DEFAULT_SONNET_MODEL: *glm-flash"],
      added: ["          ANTHROPIC_DEFAULT_SONNET_MODEL: glm-5.3-flash:cloud[1m]"],
    });
    expect(anchorNames(text)).toContain("glm-flash");
    expect(read(text)).toEqual(read(linked));
  });

  test("unlink on the field that defines an anchor hands it to the next place", () => {
    const { text } = edit(linked, { op: "unlink", path: ["agents", "glm", "engines", "default", "model"] });
    expect(changedLines(linked, text)).toEqual({
      removed: ["        model: &glm-flash glm-5.3-flash:cloud[1m]", "          ANTHROPIC_MODEL: *glm-flash"],
      added: ["        model: glm-5.3-flash:cloud[1m]", "          ANTHROPIC_MODEL: &glm-flash glm-5.3-flash:cloud[1m]"],
    });
    expect(read(text)).toEqual(read(linked));
  });

  test("unlink on an anchor nobody uses just drops the anchor", () => {
    const source = "agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        model: &lonely x\n";
    const { text } = edit(source, { op: "unlink", path: ["agents", "a", "engines", "default", "model"] });
    expect(text).toBe(source.replace("&lonely ", ""));
  });

  test("unlink turns a shared option set alias into its own list", () => {
    const { text } = edit(linked, { op: "unlink", path: ["agents", "glm", "engines", "default", "options"] });
    expect(read(text).agents.glm.engines.default.options).toEqual(["--effort", "max", "--dangerously-skip-permissions"]);
    expect(anchorNames(text)).toContain("claude-max");
    expect(read(text)).toEqual(read(linked));
  });

  test("unlink never touches a preset and refuses a path that does not exist", () => {
    const config = ConfigDocument.parse(linked);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "unlink", path: ["presets", "claude-max"] })).toMatch(/claude-max/);
    expect(refusal(config, { op: "unlink", path: ["agents", "ghost", "label"] })).toMatch(/ghost/);
    expect(refusal(config, { op: "unlink", path: ["agents", "glm", "engines", "default", "env", "<<"] })).toMatch(/<</);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("quoteValue turns a number into text", () => {
    const source = "presets:\n  lmstudio: &lmstudio\n    CLAUDE_CODE_ATTRIBUTION_HEADER: 0\n";
    const { text } = edit(source, { op: "quoteValue", path: ["presets", "lmstudio", "CLAUDE_CODE_ATTRIBUTION_HEADER"] });
    expect(text).toBe('presets:\n  lmstudio: &lmstudio\n    CLAUDE_CODE_ATTRIBUTION_HEADER: "0"\n');
    expect(read(text).presets.lmstudio.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
  });

  test("quoteValue leaves a text alone and refuses a table", () => {
    expect(edit(romain, { op: "quoteValue", path: ["agents", "opus", "label"] }).text).toBe(romain);
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "quoteValue", path: ["agents", "opus", "engines"] })).toMatch(/agents\.opus\.engines/);
  });

  test("editing an anchored value keeps the anchor", () => {
    const config = ConfigDocument.parse(linked);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setModel", agent: "glm", engine: "default", value: "other" })).toMatch(/unlink/);
    expect(refusal(config, { op: "setEnvVar", agent: "glm", engine: "default", name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "x" })).toMatch(/unlink/);
    expect(refusal(config, { op: "setModel", agent: "glm", engine: "default", value: null })).toMatch(/&glm-flash/);
    expect(config.doc.toString()).toBe(treeBefore);
    expect(config.toText()).toBe(linked);
  });

  test("an operation that changes nothing leaves a CRLF file byte for byte", () => {
    const crlf = "agents:\r\n  a:\r\n    label: A\r\n    engines:\r\n      default:\r\n        harness: claude\r\n        model: m\r\n";
    const ops: EditOp[] = [
      { op: "setModel", agent: "a", engine: "default", value: "m" },
      { op: "setHarness", agent: "a", engine: "default", harness: "claude" },
      { op: "setOptions", agent: "a", engine: "default", options: { kind: "none" } },
      { op: "setProvider", agent: "a", engine: "default", provider: { kind: "anthropic" } },
      { op: "removeMerge", agent: "a", engine: "default" },
    ];
    for (const op of ops) expect(edit(crlf, op).text).toBe(crlf);
  });

  test("refuses an operation on a missing agent or engine", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    const ops: EditOp[] = [
      { op: "setHarness", agent: "ghost", engine: "default", harness: "claude" },
      { op: "setModel", agent: "opus", engine: "ghost", value: "x" },
      { op: "setProvider", agent: "ghost", engine: "default", provider: { kind: "anthropic" } },
      { op: "setOptions", agent: "opus", engine: "ghost", options: { kind: "none" } },
      { op: "setEnvVar", agent: "ghost", engine: "default", name: "X", value: "1" },
      { op: "deleteEnvVar", agent: "opus", engine: "ghost", name: "X" },
      { op: "removeMerge", agent: "ghost", engine: "default" },
    ];
    for (const op of ops) expect(refusal(config, op)).toMatch(/ghost/);
    expect(config.doc.toString()).toBe(treeBefore);
  });
});
