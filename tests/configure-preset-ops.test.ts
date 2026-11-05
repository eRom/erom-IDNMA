import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { builtinPresetText } from "../src/configure/builtins.ts";
import { ConfigDocument } from "../src/configure/document.ts";
import { buildView } from "../src/configure/view.ts";
import { changedLines, edit, refusal } from "./helpers/configure-edit.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");

/** Le bloc d'un built-in tel qu'il s'écrit dans `presets:` (indenté de deux espaces). */
function indentedBuiltin(name: "ollama" | "lmstudio" | "openrouter" | "claude-max"): string {
  return builtinPresetText(name)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

const withOllamaOnly = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"

agents:
`;

/** Un agent claude vide dont on fait varier le corps de l'engine, dans un fichier à `presets:` choisi. */
function fileWith(presets: string, engineBody = ""): string {
  return `${presets}agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n${engineBody}`;
}

function resolvedAgents(text: string): unknown {
  return parseDocument(text, { merge: true }).toJS().agents;
}

describe("built-in presets written on first use", () => {
  test("using an absent built-in writes it first, after the existing presets and before agents", () => {
    const result = edit(
      withOllamaOnly,
      { op: "addAgent", key: "t", label: "T" },
      { op: "addEngine", agent: "t", name: "default", harness: "claude" },
      { op: "setProvider", agent: "t", engine: "default", provider: { kind: "preset", name: "lmstudio" } },
    );
    expect(result.text).toBe(
      `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
${indentedBuiltin("lmstudio")}

agents:
  t:
    label: T
    engines:
      default:
        harness: claude
        env:
          <<: *lmstudio
`,
    );
    const env = (resolvedAgents(result.text) as Record<string, any>).t.engines.default.env;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:1234");
  });

  test("a file without a presets section gets one at the top, before agents", () => {
    const result = edit(
      "agents:\n",
      { op: "addAgent", key: "t", label: "T" },
      { op: "addEngine", agent: "t", name: "default", harness: "claude" },
      { op: "setProvider", agent: "t", engine: "default", provider: { kind: "preset", name: "lmstudio" } },
    );
    expect(result.text).toBe(
      `presets:
${indentedBuiltin("lmstudio")}

agents:
  t:
    label: T
    engines:
      default:
        harness: claude
        env:
          <<: *lmstudio
`,
    );
  });

  test("an empty file gets presets and agents", () => {
    const result = edit(
      "",
      { op: "addAgent", key: "t", label: "T" },
      { op: "addEngine", agent: "t", name: "default", harness: "claude" },
      { op: "setOptions", agent: "t", engine: "default", options: { kind: "preset", name: "claude-max" } },
    );
    expect(result.text).toContain(indentedBuiltin("claude-max"));
    expect(result.text).toContain("options: *claude-max");
    expect(result.text.startsWith("agents:") || result.text.startsWith("presets:")).toBe(true);
    expect((resolvedAgents(result.text) as Record<string, any>).t.engines.default.options).toEqual(["--effort", "max", "--dangerously-skip-permissions"]);
  });

  test("an empty presets section is filled in place", () => {
    for (const empty of ["presets:\n", "presets: {}\n"]) {
      const result = edit(
        `${empty}\nagents:\n  a:\n    engines:\n      default:\n        harness: claude\n`,
        { op: "setProvider", agent: "a", engine: "default", provider: { kind: "preset", name: "ollama" } },
      );
      expect(result.text).toContain(`presets:\n${indentedBuiltin("ollama")}\n`);
      expect(result.text).toContain("<<: *ollama");
    }
  });

  test("an option set is written as a built-in too", () => {
    const text = fileWith(withOllamaOnly.replace("\nagents:\n", ""));
    const result = edit(text, { op: "setOptions", agent: "a", engine: "default", options: { kind: "preset", name: "claude-max" } });
    expect(changedLines(text, result.text).added).toContain(indentedBuiltin("claude-max"));
    expect(result.text).toContain("options: *claude-max");
  });

  test("a preset that carries a built-in anchor under another key counts as that built-in", () => {
    const text = fileWith(`presets:\n  local: &ollama\n    ANTHROPIC_BASE_URL: "http://x"\n\n`);
    const result = edit(text, { op: "setProvider", agent: "a", engine: "default", provider: { kind: "preset", name: "ollama" } });
    expect(result.text.match(/&ollama/g)).toHaveLength(1);
    expect(changedLines(text, result.text)).toEqual({ removed: [], added: ["        env:", "          <<: *ollama"] });
  });

  test("a built-in whose anchor name is taken by a non-preset value is refused", () => {
    const text = fileWith(withOllamaOnly.replace("\nagents:\n", ""), "        model: &lmstudio some-model\n");
    const config = ConfigDocument.parse(text);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "setProvider", agent: "a", engine: "default", provider: { kind: "preset", name: "lmstudio" } })).toMatch(/&lmstudio/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("a refused operation never leaves the built-in behind", () => {
    const base = withOllamaOnly.replace("\nagents:\n", "");
    // claude-max est une liste : refusé comme provider, sans rien écrire.
    const plain = ConfigDocument.parse(fileWith(base));
    const plainBefore = plain.doc.toString();
    expect(refusal(plain, { op: "setProvider", agent: "a", engine: "default", provider: { kind: "preset", name: "claude-max" } })).toMatch(/claude-max/);
    expect(plain.doc.toString()).toBe(plainBefore);

    // lmstudio est une table : refusé comme option set.
    expect(refusal(plain, { op: "setOptions", agent: "a", engine: "default", options: { kind: "preset", name: "lmstudio" } })).toMatch(/lmstudio/);
    expect(plain.doc.toString()).toBe(plainBefore);

    // Un `<<` vers plusieurs presets : refusé avant d'écrire le built-in.
    const several = ConfigDocument.parse(
      fileWith(`${base}  openrouter: &openrouter\n    A: "b"\n`, "        env:\n          <<: [*ollama, *openrouter]\n"),
    );
    const severalBefore = several.doc.toString();
    expect(refusal(several, { op: "setProvider", agent: "a", engine: "default", provider: { kind: "preset", name: "lmstudio" } })).toMatch(/several presets/);
    expect(several.doc.toString()).toBe(severalBefore);

    // Des options ancrées reprises ailleurs : leur remplacement est refusé avant d'écrire le built-in.
    const shared = ConfigDocument.parse(`${base}agents:
  a:
    engines:
      default:
        harness: claude
        options: &own [--a]
  b:
    engines:
      default:
        harness: claude
        options: *own
`);
    const sharedBefore = shared.doc.toString();
    expect(refusal(shared, { op: "setOptions", agent: "a", engine: "default", options: { kind: "preset", name: "claude-max" } })).toMatch(/&own/);
    expect(shared.doc.toString()).toBe(sharedBefore);
  });
});

describe("adding and renaming presets", () => {
  test("renaming a preset renames its anchor and every alias", () => {
    const result = edit(romain, { op: "renamePreset", name: "ollama", newName: "ollama-cloud" });
    const { removed, added } = changedLines(romain, result.text);
    expect(removed).toHaveLength(8);
    expect(added).toHaveLength(8);
    expect(added).toContain("  ollama-cloud: &ollama-cloud");
    expect(added.filter((line) => line.trim() === "<<: *ollama-cloud")).toHaveLength(7);
    expect(result.text).not.toMatch(/(?<![\w-])ollama: |&ollama(?![\w-])|\*ollama(?![\w-])/);
    // Les valeurs résolues de chaque engine n'ont pas bougé.
    expect(resolvedAgents(result.text)).toEqual(resolvedAgents(romain));
  });

  test("renaming a preset keeps its position and the rest of the file byte for byte", () => {
    const result = edit(romain, { op: "renamePreset", name: "claude-max", newName: "max" });
    const lines = result.text.split("\n");
    expect(lines.indexOf("  claude-max: &claude-max [--effort, max, --dangerously-skip-permissions]")).toBe(-1);
    expect(lines).toContain("  max: &max [--effort, max, --dangerously-skip-permissions]");
    expect(lines.indexOf("  max: &max [--effort, max, --dangerously-skip-permissions]")).toBe(
      romain.split("\n").indexOf("  claude-max: &claude-max [--effort, max, --dangerously-skip-permissions]"),
    );
    expect(resolvedAgents(result.text)).toEqual(resolvedAgents(romain));
  });

  test("renaming follows the anchor, not the key", () => {
    const text = fileWith(`presets:\n  local: &ollama\n    A: "b"\n\n`, "        env:\n          <<: *ollama\n");
    const result = edit(text, { op: "renamePreset", name: "local", newName: "home" });
    expect(changedLines(text, result.text)).toEqual({
      removed: ["  local: &ollama", "          <<: *ollama"],
      added: ["  home: &home", "          <<: *home"],
    });
  });

  test("renaming to the same name is a no-op that leaves the text untouched", () => {
    expect(edit(romain, { op: "renamePreset", name: "ollama", newName: "ollama" }).text).toBe(romain);
  });

  test("renaming only touches the aliases of this very preset when the anchor name is reused", () => {
    const text = `presets:
  a: &shared
    X: "1"
  b: &other
    Y: "2"
agents:
  one:
    engines:
      default:
        harness: claude
        env:
          <<: *shared
          Z: &shared "z"
  two:
    engines:
      default:
        harness: claude
        env:
          <<: *other
          W: *shared
`;
    const result = edit(text, { op: "renamePreset", name: "a", newName: "c" });
    expect(changedLines(text, result.text)).toEqual({
      removed: ["  a: &shared", "          <<: *shared"],
      added: ["  c: &c", "          <<: *c"],
    });
  });

  test("refuses an anchor name already taken", () => {
    const config = ConfigDocument.parse(linked);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "renamePreset", name: "ollama", newName: "glm" })).toMatch(/&glm/);
    expect(refusal(config, { op: "addPreset", name: "glm", kind: "provider" })).toMatch(/&glm/);
    expect(config.doc.toString()).toBe(treeBefore);
    expect(config.toText()).toBe(linked);
  });

  test("refuses a built-in name whose built-in kind differs", () => {
    const text = "agents:\n  a:\n    label: A\n";
    const config = ConfigDocument.parse(text);
    expect(refusal(config, { op: "addPreset", name: "claude-max", kind: "provider" })).toMatch(/claude-max.*option set/);
    expect(refusal(config, { op: "addPreset", name: "ollama", kind: "options" })).toMatch(/ollama.*provider/);
    expect(config.toText()).toBe(text);
  });

  test("refuses a key already used and names that are not valid", () => {
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "renamePreset", name: "ollama", newName: "openrouter" })).toMatch(/openrouter/);
    expect(refusal(config, { op: "addPreset", name: "ollama", kind: "provider" })).toMatch(/ollama/);
    expect(refusal(config, { op: "addPreset", name: "two words", kind: "provider" })).toMatch(/two words/);
    expect(refusal(config, { op: "renamePreset", name: "ollama", newName: "a,b" })).toMatch(/a,b/);
    expect(refusal(config, { op: "renamePreset", name: "ghost", newName: "x" })).toMatch(/ghost/);
    expect(config.toText()).toBe(romain);
  });

  test("a new provider goes at the end of presets with the anchor of its name, then fills up", () => {
    const result = edit(
      romain,
      { op: "addPreset", name: "mine", kind: "provider" },
      { op: "setPresetVar", name: "mine", varName: "ANTHROPIC_BASE_URL", value: "http://localhost:9" },
      { op: "setProvider", agent: "mistral", engine: "default", provider: { kind: "preset", name: "mine" } },
    );
    const { added, removed } = changedLines(romain, result.text);
    expect(added).toEqual(['  mine: &mine', '    ANTHROPIC_BASE_URL: "http://localhost:9"', "          <<: *mine"]);
    expect(removed).toEqual(["          <<: *ollama"]);
    // Il s'est glissé juste avant la ligne vide qui précède `agents:`.
    const lines = result.text.split("\n");
    expect(lines[lines.indexOf("agents:") - 1]).toBe("");
    expect(lines[lines.indexOf("agents:") - 2]).toBe('    ANTHROPIC_BASE_URL: "http://localhost:9"');
  });

  test("a new option set takes the file's list style", () => {
    const inline = edit(romain, { op: "addPreset", name: "mine", kind: "options" }, { op: "setPresetOptions", name: "mine", values: ["--a", "b"] });
    expect(changedLines(romain, inline.text).added).toEqual(["  mine: &mine [--a, b]"]);
    const block = edit(linked, { op: "addPreset", name: "mine", kind: "options" }, { op: "setPresetOptions", name: "mine", values: ["--a", "b"] });
    expect(changedLines(linked, block.text).added).toEqual(["  mine: &mine", "    - --a", "    - b"]);
  });

  test("a preset can be added to a file without a presets section", () => {
    const result = edit("agents:\n  a:\n    label: A\n", { op: "addPreset", name: "mine", kind: "provider" });
    expect(result.text).toBe("presets:\n  mine: &mine {}\n\nagents:\n  a:\n    label: A\n");
  });
});

describe("deleting presets", () => {
  test("refuses to delete a preset in use, naming a command", () => {
    const config = ConfigDocument.parse(romain);
    const message = refusal(config, { op: "deletePreset", name: "claude-max" });
    expect(message).toMatch(/idnma run glm\b/);
    expect(message).toMatch(/claude-max/);
    expect(config.toText()).toBe(romain);
  });

  test("names the engine flag when the user is not a default engine", () => {
    const text = `presets:
  ollama: &ollama
    A: "b"

agents:
  x:
    engines:
      default:
        harness: grok
      alt:
        harness: claude
        env:
          <<: *ollama
`;
    expect(refusal(ConfigDocument.parse(text), { op: "deletePreset", name: "ollama" })).toMatch(/idnma run x --engine alt/);
  });

  test("an unused preset is deleted and nothing else changes", () => {
    const text = `presets:
  keep: &keep
    A: "b"
  unused: &unused
    C: "d"
  other: &other [--x]

agents:
  x:
    engines:
      default:
        harness: claude
        env:
          <<: *keep
        options: *other
`;
    const result = edit(text, { op: "deletePreset", name: "unused" });
    expect(changedLines(text, result.text)).toEqual({ removed: ["  unused: &unused", '    C: "d"'], added: [] });
  });

  test("a preset becomes deletable once its users let go", () => {
    const config = ConfigDocument.parse(`presets:
  p: &p
    A: "b"

agents:
  x:
    engines:
      default:
        harness: claude
        env:
          <<: *p
`);
    expect(() => config.apply({ op: "deletePreset", name: "p" })).toThrow(/idnma run x/);
    config.apply({ op: "removeMerge", agent: "x", engine: "default" });
    config.apply({ op: "deletePreset", name: "p" });
    expect(config.toText()).not.toContain("&p");
  });

  test("refuses to delete a preset that holds an anchor used elsewhere", () => {
    const text = `presets:
  p: &p
    A: &shared "b"

agents:
  x:
    label: *shared
`;
    const config = ConfigDocument.parse(text);
    expect(refusal(config, { op: "deletePreset", name: "p" })).toMatch(/&shared/);
    expect(config.toText()).toBe(text);
  });

  test("refuses to delete a preset that does not exist", () => {
    expect(refusal(ConfigDocument.parse(romain), { op: "deletePreset", name: "ghost" })).toMatch(/ghost/);
  });
});

describe("editing preset contents", () => {
  test("editing a preset variable changes every user", () => {
    const result = edit(romain, { op: "setPresetVar", name: "openrouter", varName: "ANTHROPIC_BASE_URL", value: "https://x" });
    expect(changedLines(romain, result.text)).toEqual({
      removed: ['    ANTHROPIC_BASE_URL: "https://openrouter.ai/api"'],
      added: ['    ANTHROPIC_BASE_URL: "https://x"'],
    });
    const agents = resolvedAgents(result.text) as Record<string, any>;
    for (const key of ["qwen-flash", "qwen-max", "muse"]) {
      expect(agents[key].engines.default.env.ANTHROPIC_BASE_URL).toBe("https://x");
    }
  });

  test("a variable is added at the end, renamed in place, and deleted", () => {
    const added = edit(romain, { op: "setPresetVar", name: "ollama", varName: "EXTRA", value: "1" });
    expect(changedLines(romain, added.text).added).toEqual(['    EXTRA: "1"']);
    const renamed = edit(romain, { op: "setPresetVar", name: "ollama", varName: "ANTHROPIC_KEY", previousName: "ANTHROPIC_API_KEY", value: "" });
    expect(changedLines(romain, renamed.text)).toEqual({ removed: ['    ANTHROPIC_API_KEY: ""'], added: ['    ANTHROPIC_KEY: ""'] });
    const deleted = edit(romain, { op: "deletePresetVar", name: "ollama", varName: "ANTHROPIC_API_KEY" });
    expect(changedLines(romain, deleted.text)).toEqual({ removed: ['    ANTHROPIC_API_KEY: ""'], added: [] });
  });

  test("setting a variable to its current value changes nothing", () => {
    const result = edit(romain, { op: "setPresetVar", name: "ollama", varName: "ANTHROPIC_API_KEY", value: "" });
    expect(result.text).toBe(romain);
  });

  test("setting an unquoted variable to its current value keeps it unquoted", () => {
    const text = "presets:\n  mine: &mine\n    A: b\nagents:\n  a:\n    label: A\n";
    const result = edit(text, { op: "setPresetVar", name: "mine", varName: "A", value: "b" });
    expect(result.text).toBe(text);
    // Le texte rendu est celui reçu même après re-sérialisation : l'arbre n'a pas bougé non plus.
    expect(result.config.doc.toString({ flowCollectionPadding: false })).toBe(text);
  });

  test("refuses bad variable edits and leaves the file as it was", () => {
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "setPresetVar", name: "ollama", varName: "1BAD", value: "x" })).toMatch(/1BAD/);
    expect(refusal(config, { op: "setPresetVar", name: "ollama", varName: "ANTHROPIC_BASE_URL", previousName: "NOPE", value: "x" })).toMatch(/NOPE/);
    expect(refusal(config, { op: "setPresetVar", name: "ollama", varName: "ANTHROPIC_API_KEY", previousName: "ANTHROPIC_BASE_URL", value: "x" })).toMatch(/ANTHROPIC_API_KEY/);
    expect(refusal(config, { op: "setPresetVar", name: "claude-max", varName: "A", value: "x" })).toMatch(/claude-max/);
    expect(refusal(config, { op: "setPresetVar", name: "ghost", varName: "A", value: "x" })).toMatch(/ghost/);
    expect(refusal(config, { op: "deletePresetVar", name: "ollama", varName: "NOPE" })).toMatch(/NOPE/);
    expect(config.toText()).toBe(romain);
  });

  test("editing a built-in absent from the file writes it with the edit applied", () => {
    const result = edit(linked, { op: "setPresetVar", name: "lmstudio", varName: "ANTHROPIC_BASE_URL", value: "http://localhost:5555" });
    const { added, removed } = changedLines(linked, result.text);
    expect(removed).toEqual([]);
    expect(added).toContain("  lmstudio: &lmstudio");
    expect(added).toContain('    ANTHROPIC_BASE_URL: "http://localhost:5555"');
    expect(added).not.toContain('    ANTHROPIC_BASE_URL: "http://localhost:1234"');
  });

  test("a refused edit of an absent built-in does not write it", () => {
    const config = ConfigDocument.parse(linked);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "deletePresetVar", name: "lmstudio", varName: "NOPE" })).toMatch(/NOPE/);
    expect(refusal(config, { op: "setPresetVar", name: "lmstudio", varName: "1BAD", value: "x" })).toMatch(/1BAD/);
    expect(config.doc.toString()).toBe(treeBefore);
    expect(config.toText()).toBe(linked);
  });

  test("an edit that changes nothing on an absent built-in does not write it", () => {
    const result = edit(linked, { op: "setPresetVar", name: "lmstudio", varName: "ANTHROPIC_API_KEY", value: "" });
    expect(result.text).toBe(linked);
  });

  test("option set values are edited in place and keep their style", () => {
    const inline = edit(romain, { op: "setPresetOptions", name: "claude-max", values: ["--effort", "high", "--remote-control"] });
    expect(changedLines(romain, inline.text)).toEqual({
      removed: ["  claude-max: &claude-max [--effort, max, --dangerously-skip-permissions]"],
      added: ["  claude-max: &claude-max [--effort, high, --remote-control]"],
    });
    const block = edit(linked, { op: "setPresetOptions", name: "claude-max", values: ["--effort", "high"] });
    expect(changedLines(linked, block.text)).toEqual({
      removed: ["    - max", "    - --dangerously-skip-permissions"],
      added: ["    - high"],
    });
    // Les engines qui reprennent la liste la voient changer.
    const agents = resolvedAgents(inline.text) as Record<string, any>;
    expect(agents.glm.engines.default.options).toEqual(["--effort", "high", "--remote-control"]);
  });

  test("the same option values change nothing", () => {
    const result = edit(romain, { op: "setPresetOptions", name: "claude-max", values: ["--effort", "max", "--dangerously-skip-permissions"] });
    expect(result.text).toBe(romain);
  });

  test("refuses option edits on the wrong kind of preset and on anchored items", () => {
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "setPresetOptions", name: "ollama", values: ["--a"] })).toMatch(/ollama/);
    expect(refusal(config, { op: "setPresetOptions", name: "ghost", values: ["--a"] })).toMatch(/ghost/);
    expect(config.toText()).toBe(romain);

    const text = `presets:
  opts: &opts [--a, &flag --b]

agents:
  x:
    label: *flag
`;
    const anchored = ConfigDocument.parse(text);
    expect(refusal(anchored, { op: "setPresetOptions", name: "opts", values: ["--c"] })).toMatch(/&flag/);
    expect(anchored.toText()).toBe(text);
  });

  test("editing an absent built-in option set writes it with the edit applied", () => {
    const text = fileWith("presets:\n  ollama: &ollama\n    A: \"b\"\n\n");
    const result = edit(text, { op: "setPresetOptions", name: "claude-max", values: ["--x"] });
    expect(changedLines(text, result.text).added).toEqual(["  claude-max: &claude-max [--x]"]);
  });
});

describe("preset usage in the view", () => {
  test("usedBy follows the anchor: a preset keyed local carrying &ollama lists the engines using *ollama", () => {
    const text = `presets:
  local: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"

agents:
  glm:
    engines:
      default:
        harness: claude
        env:
          <<: *ollama
`;
    const view = buildView(ConfigDocument.parse(text), "/tmp/.idnma.yml", false);
    const local = view.presets.find((p) => p.name === "local");
    expect(local?.usedBy).toEqual(["idnma run glm"]);
    expect(local?.builtIn).toBe(true);
  });

  test("a preset renamed through the operation keeps its users in the view", () => {
    const result = edit(romain, { op: "renamePreset", name: "ollama", newName: "ollama-cloud" });
    const view = buildView(ConfigDocument.parse(result.text), "/tmp/.idnma.yml", false);
    const renamed = view.presets.find((p) => p.name === "ollama-cloud");
    expect(renamed?.usedBy).toContain("idnma run glm");
    expect(renamed?.usedBy).toHaveLength(7);
  });
});
