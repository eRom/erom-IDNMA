import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { YAMLMap } from "yaml";
import { BUILTIN_PRESET_NAMES, builtinPresetText, NEW_FILE_TEMPLATE } from "../src/configure/builtins.ts";
import { ConfigDocument, isMergePair } from "../src/configure/document.ts";
import type { AgentView, ConfigView, EngineView } from "../src/configure/types.ts";
import { buildView } from "../src/configure/view.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");
const example = readFileSync(join(import.meta.dir, "..", ".idnma.example.yml"), "utf-8");

function viewOf(text: string | undefined): ConfigView {
  return buildView(ConfigDocument.parse(text), "/tmp/.idnma.yml", false);
}

function agentOf(view: ConfigView, key: string): AgentView {
  const agent = view.agents.find((a) => a.key === key);
  if (!agent) throw new Error(`agent ${key} absent de la vue`);
  return agent;
}

function engineOf(view: ConfigView, key: string, name: string): EngineView {
  const engine = agentOf(view, key).engines.find((e) => e.name === name);
  if (!engine) throw new Error(`engine ${key}/${name} absent de la vue`);
  return engine;
}

/** Fichier minimal à un agent claude, dont on fait varier le corps de l'engine. */
function withEngine(body: string, presets = ""): string {
  return `${presets}agents:\n  a:\n    label: A\n    engines:\n      default:\n${body}`;
}

describe("configure view", () => {
  test("round-trips the real files byte for byte", () => {
    // `yaml` ne garde pas des espaces seuls après le dernier saut de ligne (l'exemple du dépôt en porte
    // deux, sans conséquence) : seule cette queue-là est tolérée, tout le reste doit ressortir à l'octet.
    for (const text of [romain, linked, example]) {
      expect(ConfigDocument.parse(text).toText()).toBe(text.replace(/\n[ \t]+$/, "\n"));
    }
  });

  test("new file starts from the template", () => {
    const doc = ConfigDocument.parse(undefined);
    expect(doc.isNew).toBe(true);
    expect(doc.toText()).toBe(NEW_FILE_TEMPLATE);
    expect(ConfigDocument.parse("agents:\n").isNew).toBe(false);
  });

  test("lists agents in file order with their commands", () => {
    const view = viewOf(romain);
    expect(view.agents.length).toBe(18);
    expect(view.agents[0]?.key).toBe("opus");
    const deepseek = agentOf(view, "deepseek-flash");
    expect(deepseek.engines.length).toBe(3);
    expect(deepseek.engines.map((e) => e.command)).toEqual([
      "idnma run deepseek-flash",
      "idnma run deepseek-flash --engine dst",
      "idnma run deepseek-flash --engine opencode",
    ]);
    const main = engineOf(view, "deepseek-flash", "default");
    expect(main.isDefault).toBe(true);
    expect(main.provider).toEqual({ kind: "preset", name: "ollama" });
    expect(main.options).toEqual({
      kind: "preset",
      name: "claude-max",
      values: ["--effort", "max", "--dangerously-skip-permissions"],
    });
    expect(engineOf(view, "deepseek-flash", "dst").env).toEqual([
      { name: "DSH_PERMISSION_MODE", value: "danger-full-access" },
    ]);
    expect(engineOf(view, "deepseek-flash", "dst").isDefault).toBe(false);
  });

  test("classifies presets by shape", () => {
    const view = viewOf(romain);
    const byName = (name: string) => view.presets.find((p) => p.name === name);
    for (const name of ["ollama", "lmstudio", "openrouter"]) {
      expect(byName(name)).toMatchObject({ kind: "provider", builtIn: true, inFile: true });
    }
    expect(byName("claude-max")).toMatchObject({
      kind: "options",
      builtIn: true,
      inFile: true,
      options: ["--effort", "max", "--dangerously-skip-permissions"],
    });
    expect(byName("ollama")?.vars.map((v) => v.name)).toContain("ANTHROPIC_BASE_URL");

    // Un built-in absent du fichier reste proposé, marqué non écrit.
    const partial = viewOf("presets:\n  ollama: &ollama\n    ANTHROPIC_BASE_URL: \"http://x\"\nagents:\n");
    const lmstudio = partial.presets.find((p) => p.name === "lmstudio");
    expect(lmstudio).toMatchObject({ kind: "provider", builtIn: true, inFile: false });
    expect(lmstudio?.vars.find((v) => v.name === "ANTHROPIC_BASE_URL")?.value).toBe("http://localhost:1234");
    expect(partial.presets.find((p) => p.name === "ollama")?.inFile).toBe(true);
  });

  test("keeps a file preset of another shape apart and read-only", () => {
    const view = viewOf("presets:\n  odd: &odd 42\n  mine: &mine\n    K: v\nagents:\n");
    expect(view.presets.find((p) => p.name === "odd")).toMatchObject({ kind: "other", builtIn: false, inFile: true });
    expect(view.presets.find((p) => p.name === "mine")).toMatchObject({ kind: "provider", builtIn: false });
  });

  test("lists who uses a preset as commands", () => {
    const view = viewOf(romain);
    const openrouter = view.presets.find((p) => p.name === "openrouter");
    expect(openrouter?.usedBy).toContain("idnma run argon --engine claude");
    expect(view.presets.find((p) => p.name === "claude-max")?.usedBy).toContain("idnma run deepseek-flash");
  });

  test("reads anthropic and custom providers", () => {
    const anthropic = viewOf(withEngine("        harness: claude\n"));
    expect(engineOf(anthropic, "a", "default").provider).toEqual({ kind: "anthropic" });

    const custom = viewOf(withEngine('        harness: claude\n        env:\n          ANTHROPIC_BASE_URL: "x"\n'));
    expect(engineOf(custom, "a", "default").provider).toEqual({ kind: "custom" });

    const presets = 'presets:\n  ollama: &ollama\n    ANTHROPIC_BASE_URL: "http://localhost:11434"\n';
    const foreign = viewOf(withEngine("        harness: opencode\n        env:\n          <<: *ollama\n", presets));
    const engine = engineOf(foreign, "a", "default");
    expect(engine.provider.kind).toBe("none");
    expect(engine.mergedPreset).toBe("ollama");
  });

  test("shows own variables next to a merged preset", () => {
    const view = viewOf(romain);
    const engine = engineOf(view, "mistral", "default");
    expect(engine.provider).toEqual({ kind: "preset", name: "ollama" });
    expect(engine.mergedPreset).toBe("ollama");
    expect(engine.env).toEqual([]);
  });

  test("marks linked values", () => {
    const view = viewOf(linked);
    const engine = engineOf(view, "glm", "default");
    expect(engine.model).toBe("glm-5.3-flash:cloud[1m]");
    expect(engine.modelLinked?.anchor).toBe("glm-flash");
    expect(engine.modelLinked?.sharedWith).toContain("agents.glm.engines.default.env.ANTHROPIC_MODEL");
    expect(engine.modelLinked?.sharedWith).not.toContain("agents.glm.engines.default.model");
    const opus = engine.env.find((v) => v.name === "ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(opus?.linked?.anchor).toBe("glm");
    expect(opus?.linked?.sharedWith).toEqual(["agents.glm.engines.default.env.ANTHROPIC_DEFAULT_FABLE_MODEL"]);
    expect(opus?.value).toBe("glm-5.3:cloud[1m]");
    // Une valeur sans ancre ni alias n'est pas liée.
    expect(engine.env.find((v) => v.name === "CLAUDE_CODE_EFFORT_LEVEL")?.linked).toBeUndefined();
  });

  test("keeps multi-merge engines read-only", () => {
    const presets = "presets:\n  ollama: &ollama\n    A: a\n  openrouter: &openrouter\n    B: b\n";
    const view = viewOf(withEngine("        harness: claude\n        env:\n          <<: [*ollama, *openrouter]\n", presets));
    const engine = engineOf(view, "a", "default");
    expect(engine.readOnly).toBeTruthy();
    expect(view.presets.find((p) => p.name === "ollama")?.usedBy).toEqual(["idnma run a"]);
    expect(view.presets.find((p) => p.name === "openrouter")?.usedBy).toEqual(["idnma run a"]);
  });

  test("reads inline, preset and empty options", () => {
    const presets = "presets:\n  fast: &fast [--a, --b]\n";
    const inline = engineOf(viewOf(withEngine("        harness: claude\n        options: [--x, y]\n", presets)), "a", "default");
    expect(inline.options).toEqual({ kind: "custom", values: ["--x", "y"] });
    const shared = engineOf(viewOf(withEngine("        harness: claude\n        options: *fast\n", presets)), "a", "default");
    expect(shared.options).toEqual({ kind: "preset", name: "fast", values: ["--a", "--b"] });
    const none = engineOf(viewOf(withEngine("        harness: claude\n")), "a", "default");
    expect(none.options).toEqual({ kind: "none" });
  });

  test("reads label, info and avatar of an agent", () => {
    const view = viewOf(linked);
    expect(agentOf(view, "agy")).toMatchObject({ label: "AGY Agent", info: "3.8", avatar: "gemini.png" });
    expect(agentOf(view, "claude").avatar).toBeUndefined();
  });

  test("reports a syntax error with its position", () => {
    const doc = ConfigDocument.parse("agents:\n  a: [\n");
    expect(typeof doc.parseError?.line).toBe("number");
    expect(typeof doc.parseError?.col).toBe("number");
    expect(doc.parseError?.message).toBeTruthy();
    const view = buildView(doc, "/tmp/.idnma.yml", true);
    expect(view.agents).toEqual([]);
    expect(view.parseError).toEqual(doc.parseError);
    expect(view.dirty).toBe(true);
  });

  test("reports an unresolved alias as a parse error", () => {
    const missing = "agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        env:\n          <<: *nope\n";
    const error = ConfigDocument.parse(missing).parseError;
    expect(error?.message).toContain("nope");
    expect(error?.line).toBe(8);
    expect(error?.col).toBe(15);

    const early = "agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        model: *late\n        env:\n          K: &late v\n";
    const late = ConfigDocument.parse(early).parseError;
    expect(late?.message).toContain("late");
    expect(late?.line).toBe(7);
    expect(buildView(ConfigDocument.parse(early), "/x", false).agents).toEqual([]);
  });

  test("rebuilds the template from the built-in blocks", () => {
    const blocks = BUILTIN_PRESET_NAMES.map((name) =>
      builtinPresetText(name)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    expect(`presets:\n${blocks.join("\n")}\n\nagents:\n`).toBe(NEW_FILE_TEMPLATE);
  });

  test("lists alias users as readable paths", () => {
    const doc = ConfigDocument.parse(linked);
    expect(doc.aliasUsers("ollama")).toContain("agents.glm.engines.default.env");
    expect(doc.aliasUsers("claude-max")).toContain("agents.glm.engines.default.options");
    expect(doc.aliasUsers("glm")).toEqual(["agents.glm.engines.default.env.ANTHROPIC_DEFAULT_OPUS_MODEL"]);
    expect(doc.aliasUsers("unknown")).toEqual([]);
  });

  test("treats only a plain << key as a merge", () => {
    const merge = ConfigDocument.parse("p: &p {a: b}\nx:\n  <<: *p\n  \"<<\": *p\n");
    const pairs = (merge.doc.get("x", true) as YAMLMap).items;
    expect(pairs.map((pair) => isMergePair(pair))).toEqual([true, false]);
  });

  test("survives an empty or comment-only file", () => {
    for (const text of ["", "# rien\n", "agents:\n"]) {
      const view = viewOf(text);
      expect(view.agents).toEqual([]);
      expect(view.parseError).toBeUndefined();
      expect(ConfigDocument.parse(text).toText()).toBe(text);
    }
  });
});
