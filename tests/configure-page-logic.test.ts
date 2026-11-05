import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigDocument } from "../src/configure/document.ts";
import {
  type AddInput,
  addOps,
  type FieldInput,
  opForField,
  PendingInputs,
  readToken,
  remapId,
  renameEffect,
  reorderOptions,
  toolbarState,
  TOKEN_KEY,
} from "../src/configure/page/logic.ts";
import type { ConfigView, EditOp } from "../src/configure/types.ts";
import { buildView } from "../src/configure/view.ts";

const romain = readFileSync(join(import.meta.dir, "fixtures", "configure", "romain.yml"), "utf-8");
const romainView = (): ConfigView => buildView(ConfigDocument.parse(romain), "/tmp/.idnma.yml", false);

describe("configure page token", () => {
  function env(search: string, hash = "", stored?: string) {
    const calls: unknown[][] = [];
    const store = new Map<string, string>(stored === undefined ? [] : [[TOKEN_KEY, stored]]);
    return {
      calls,
      store,
      location: { search, pathname: "/", hash },
      history: { replaceState: (...args: unknown[]) => void calls.push(args) },
      storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) },
    };
  }

  test("reads the token from the address, keeps it for a reload, and removes it from the address bar", () => {
    const e = env("?token=abc123", "#x");
    expect(readToken(e.location, e.history, e.storage)).toBe("abc123");
    expect(e.store.get(TOKEN_KEY)).toBe("abc123");
    expect(e.calls).toEqual([[null, "", "/#x"]]);
  });

  test("keeps the other parameters of the address", () => {
    const e = env("?a=1&token=abc&b=2");
    readToken(e.location, e.history, e.storage);
    expect(e.calls).toEqual([[null, "", "/?a=1&b=2"]]);
  });

  test("falls back to the stored token after a reload, without touching the address", () => {
    const e = env("", "", "kept");
    expect(readToken(e.location, e.history, e.storage)).toBe("kept");
    expect(e.calls).toEqual([]);
  });

  test("a new token in the address wins over the stored one", () => {
    const e = env("?token=fresh", "", "old");
    expect(readToken(e.location, e.history, e.storage)).toBe("fresh");
    expect(e.store.get(TOKEN_KEY)).toBe("fresh");
  });

  test("gives nothing when there is no token anywhere", () => {
    const e = env("");
    expect(readToken(e.location, e.history, e.storage)).toBeUndefined();
    expect(e.calls).toEqual([]);
  });
});

describe("configure page renames", () => {
  test("a renamed agent remaps every focus id under its key and moves the selection", () => {
    const effect = renameEffect({ op: "renameAgent", key: "ds", newKey: "ds-flash" });
    expect(remapId(effect.remaps, "agent:ds:avatar")).toBe("agent:ds-flash:avatar");
    expect(remapId(effect.remaps, "agent:ds:engine:dst:env:A:value")).toBe("agent:ds-flash:engine:dst:env:A:value");
    // Une clé qui commence pareil n'est pas l'agent renommé.
    expect(remapId(effect.remaps, "agent:ds2:avatar")).toBe("agent:ds2:avatar");
    expect(effect.selected).toEqual({ from: "ds", to: "ds-flash" });
  });

  test("a renamed engine, variable and preset remap their own identifiers only", () => {
    const engine = renameEffect({ op: "renameEngine", agent: "a", engine: "dst", newName: "dst2" });
    expect(remapId(engine.remaps, "agent:a:engine:dst:model")).toBe("agent:a:engine:dst2:model");
    expect(remapId(engine.remaps, "agent:a:engine:other:model")).toBe("agent:a:engine:other:model");

    const variable = renameEffect({ op: "setEnvVar", agent: "a", engine: "default", name: "NEW", value: "1", previousName: "OLD" });
    expect(remapId(variable.remaps, "agent:a:engine:default:env:OLD:value")).toBe("agent:a:engine:default:env:NEW:value");

    const presetVar = renameEffect({ op: "setPresetVar", name: "p", varName: "NEW", value: "", previousName: "OLD" });
    expect(remapId(presetVar.remaps, "preset:p:var:OLD:name")).toBe("preset:p:var:NEW:name");

    const preset = renameEffect({ op: "renamePreset", name: "p", newName: "q" });
    expect(remapId(preset.remaps, "preset:p:var:A:value")).toBe("preset:q:var:A:value");
    expect(preset.selected).toEqual({ from: "p", to: "q" });
  });

  test("operations that rename nothing leave identifiers alone", () => {
    const ops: EditOp[] = [
      { op: "setEnvVar", agent: "a", engine: "default", name: "A", value: "1" },
      { op: "setModel", agent: "a", engine: "default", value: null },
      { op: "deleteAgent", key: "a" },
    ];
    for (const op of ops) expect(renameEffect(op)).toEqual({ remaps: [] });
    expect(remapId([], "agent:a:key")).toBe("agent:a:key");
  });
});

describe("configure page fields", () => {
  const field = (dataset: Record<string, string>, value: string, extra: Partial<FieldInput> = {}): FieldInput => ({ dataset, value, ...extra });
  const base = { agent: "a", engine: "default" };

  test("an agent field sends text, and an empty value sends null", () => {
    expect(opForField(field({ action: "setAgentField", agent: "a", field: "label" }, "  Luna "))).toEqual({ op: "setAgentField", key: "a", field: "label", value: "Luna" });
    expect(opForField(field({ action: "setAgentField", agent: "a", field: "avatar" }, ""))).toEqual({ op: "setAgentField", key: "a", field: "avatar", value: null });
  });

  test("a rename sends nothing when the trimmed name did not change", () => {
    expect(opForField(field({ action: "renameAgent", agent: "a" }, "a "))).toBeUndefined();
    expect(opForField(field({ action: "renameAgent", agent: "a" }, " b "))).toEqual({ op: "renameAgent", key: "a", newKey: "b" });
    expect(opForField(field({ action: "renameEngine", ...base }, "dst"))).toEqual({ op: "renameEngine", agent: "a", engine: "default", newName: "dst" });
    expect(opForField(field({ action: "renameEngine", ...base }, "default"))).toBeUndefined();
    expect(opForField(field({ action: "renamePreset", preset: "p" }, "q"))).toEqual({ op: "renamePreset", name: "p", newName: "q" });
  });

  test("harness and model", () => {
    expect(opForField(field({ action: "setHarness", ...base }, "codex"))).toEqual({ op: "setHarness", agent: "a", engine: "default", harness: "codex" });
    expect(opForField(field({ action: "setModel", ...base }, " m "))).toEqual({ op: "setModel", agent: "a", engine: "default", value: "m" });
    expect(opForField(field({ action: "setModel", ...base }, ""))).toEqual({ op: "setModel", agent: "a", engine: "default", value: null });
  });

  test("editing a variable value keeps its name, renaming keeps the neighbour value and names the old name", () => {
    const set = { action: "setEnvVar", ...base, name: "KEY" };
    expect(opForField(field({ ...set, field: "value" }, " as typed "))).toEqual({ op: "setEnvVar", agent: "a", engine: "default", name: "KEY", value: " as typed " });
    expect(opForField(field({ ...set, field: "name" }, "KEY2", { sibling: "kept" }))).toEqual({
      op: "setEnvVar",
      agent: "a",
      engine: "default",
      name: "KEY2",
      value: "kept",
      previousName: "KEY",
    });
    expect(opForField(field({ ...set, field: "name" }, "KEY ", { sibling: "kept" }))).toBeUndefined();
    // Un champ de valeur ne porte jamais previousName.
    expect(opForField(field({ ...set, field: "value" }, "x"))).not.toHaveProperty("previousName");

    const preset = { action: "setPresetVar", preset: "p", name: "KEY" };
    expect(opForField(field({ ...preset, field: "value" }, "v"))).toEqual({ op: "setPresetVar", name: "p", varName: "KEY", value: "v" });
    expect(opForField(field({ ...preset, field: "name" }, "K2", { sibling: "v" }))).toEqual({ op: "setPresetVar", name: "p", varName: "K2", value: "v", previousName: "KEY" });
  });

  test("option tokens send the non empty values of their group, in order", () => {
    const token = { action: "setOptions", ...base, index: "1" };
    const group = { dataset: { agent: "a", engine: "default" }, values: ["--a", " ", " --b ", ""] };
    expect(opForField(field(token, "--b", { group }))).toEqual({ op: "setOptions", agent: "a", engine: "default", options: { kind: "custom", values: ["--a", "--b"] } });
    const preset = { dataset: { preset: "p" }, values: ["--a", "--b"] };
    expect(opForField(field({ action: "setPresetOptions", preset: "p", index: "0" }, "--a", { group: preset }))).toEqual({ op: "setPresetOptions", name: "p", values: ["--a", "--b"] });
    // Sans groupe, un jeton ne sait pas quoi envoyer.
    expect(opForField(field(token, "--b"))).toBeUndefined();
  });

  test("a control without action sends nothing", () => {
    expect(opForField(field({}, "x"))).toBeUndefined();
    expect(opForField(field({ action: "copy" }, "x"))).toBeUndefined();
  });
});

describe("configure page creation", () => {
  const input = (add: string, values: Record<string, string>, dataset: Record<string, string> = {}): AddInput => ({ add, dataset, values });

  test("asks for the name before anything else", () => {
    expect(addOps(input("addAgent", { key: "", label: "x" }), undefined)).toEqual({ ok: false, message: "Enter a name.", field: "add:key" });
    expect(addOps(input("addEngine", { name: "" }, { agent: "a" }), undefined)).toEqual({ ok: false, message: "Enter a name.", field: "add:name" });
    expect(addOps(input("addOption", { option: "" }, { preset: "p" }), undefined)).toEqual({ ok: false, message: "Enter an option.", field: "add:option" });
  });

  test("an agent is created with its default engine, the label defaulting to the key", () => {
    const result = addOps(input("addAgent", { key: "zed", label: "", harness: "codex" }), undefined);
    expect(result).toEqual({
      ok: true,
      ops: [
        { op: "addAgent", key: "zed", label: "zed" },
        { op: "addEngine", agent: "zed", name: "default", harness: "codex" },
      ],
      select: "zed",
      focus: "agent:zed:engine:default:model",
    });
  });

  test("the operations of a new agent give a file that validates, on the chosen harness", () => {
    const doc = ConfigDocument.parse(undefined);
    const result = addOps(input("addAgent", { key: "zed", label: "Zed", harness: "codex" }), undefined);
    if (!result.ok) throw new Error(result.message);
    for (const op of result.ops) doc.apply(op);
    const view = buildView(doc, "/tmp/.idnma.yml", true);
    expect(view.agents.map((a) => [a.key, a.engines.map((e) => [e.name, e.harness, e.isDefault])])).toEqual([["zed", [["default", "codex", true]]]]);
    expect(view.issues).toEqual([]);
  });

  test("an engine, a preset and an option", () => {
    expect(addOps(input("addEngine", { name: "dst", harness: "dst" }, { agent: "a" }), undefined)).toEqual({
      ok: true,
      ops: [{ op: "addEngine", agent: "a", name: "dst", harness: "dst" }],
      focus: "agent:a:engine:dst:harness",
    });
    expect(addOps(input("addPreset", { name: "fast" }, { kind: "options" }), undefined)).toEqual({ ok: true, ops: [{ op: "addPreset", name: "fast", kind: "options" }], select: "fast" });
    expect(addOps(input("addPreset", { name: "x" }, {}), undefined)).toMatchObject({ ops: [{ op: "addPreset", name: "x", kind: "provider" }] });
    const view = romainView();
    const count = view.presets.find((p) => p.name === "claude-max")?.options.length ?? 0;
    const option = addOps(input("addOption", { option: "--new" }, { preset: "claude-max" }), view);
    expect(option).toMatchObject({ ok: true, focus: `preset:claude-max:option:${count}` });
    if (option.ok) expect(option.ops).toEqual([{ op: "setPresetOptions", name: "claude-max", values: [...(view.presets.find((p) => p.name === "claude-max")?.options ?? []), "--new"] }]);
  });

  test("a new variable is created empty with the create flag, and focuses its value", () => {
    expect(addOps(input("addEnvVar", { name: "FRESH" }, { agent: "deepseek-flash", engine: "dst" }), romainView())).toEqual({
      ok: true,
      ops: [{ op: "setEnvVar", agent: "deepseek-flash", engine: "dst", name: "FRESH", value: "", create: true }],
      focus: "agent:deepseek-flash:engine:dst:env:FRESH:value",
    });
    expect(addOps(input("addPresetVar", { name: "FRESH" }, { preset: "ollama" }), romainView())).toEqual({
      ok: true,
      ops: [{ op: "setPresetVar", name: "ollama", varName: "FRESH", value: "", create: true }],
      focus: "preset:ollama:var:FRESH:value",
    });
  });

  test("a variable name that already exists is refused in the form and points at the existing field", () => {
    expect(addOps(input("addEnvVar", { name: "DSH_PERMISSION_MODE" }, { agent: "deepseek-flash", engine: "dst" }), romainView())).toEqual({
      ok: false,
      message: "Variable DSH_PERMISSION_MODE already exists.",
      field: "add:name",
      focus: "agent:deepseek-flash:engine:dst:env:DSH_PERMISSION_MODE:value",
    });
    expect(addOps(input("addPresetVar", { name: "ANTHROPIC_AUTH_TOKEN" }, { preset: "ollama" }), romainView())).toMatchObject({
      ok: false,
      message: "Variable ANTHROPIC_AUTH_TOKEN already exists.",
      focus: "preset:ollama:var:ANTHROPIC_AUTH_TOKEN:value",
    });
  });

  test("the operations of a creation never rewrite an existing variable, even when the form check is skipped", () => {
    // Sans la vue (page pas encore chargée), le drapeau `create` du document tient la ligne.
    const doc = ConfigDocument.parse(romain);
    const result = addOps(input("addEnvVar", { name: "DSH_PERMISSION_MODE" }, { agent: "deepseek-flash", engine: "dst" }), undefined);
    if (!result.ok) throw new Error(result.message);
    expect(() => doc.apply(result.ops[0] as EditOp)).toThrow(/already exists/);
  });
});

describe("configure page option lists", () => {
  const list = ["--a", "--b", "--c"];

  test("removes the option at an index", () => {
    expect(reorderOptions(list, "removeOption", 1)).toEqual({ values: ["--a", "--c"], target: 1 });
    expect(reorderOptions(list, "removeOption", 2)).toEqual({ values: ["--a", "--b"], target: 2 });
  });

  test("moves an option up or down by one place and reports where it landed", () => {
    expect(reorderOptions(list, "moveOption", 1, -1)).toEqual({ values: ["--b", "--a", "--c"], target: 0 });
    expect(reorderOptions(list, "moveOption", 1, 1)).toEqual({ values: ["--a", "--c", "--b"], target: 2 });
  });

  test("refuses what cannot happen and leaves the list untouched", () => {
    expect(reorderOptions(list, "moveOption", 0, -1)).toBeUndefined();
    expect(reorderOptions(list, "moveOption", 2, 1)).toBeUndefined();
    expect(reorderOptions(list, "removeOption", 3)).toBeUndefined();
    expect(reorderOptions(list, "removeOption", -1)).toBeUndefined();
    expect(reorderOptions(list, "removeOption", Number.NaN)).toBeUndefined();
    expect(list).toEqual(["--a", "--b", "--c"]);
  });
});

describe("configure page pending input", () => {
  test("a field with typed text counts until its change goes out", () => {
    const pending = new PendingInputs();
    expect(pending.any).toBe(false);
    pending.input("agent:a:label");
    pending.input("agent:a:label");
    expect(pending.any).toBe(true);
    pending.commit("agent:a:label");
    expect(pending.any).toBe(false);
  });

  test("tracks several fields independently, and a render clears them all", () => {
    const pending = new PendingInputs();
    pending.input("a");
    pending.input("b");
    pending.commit("a");
    expect(pending.any).toBe(true);
    pending.commit("a");
    expect(pending.any).toBe(true);
    pending.clear();
    expect(pending.any).toBe(false);
    // Valider un champ qui n'a rien en attente est sans effet.
    pending.commit("never-typed");
    expect(pending.any).toBe(false);
  });

  test("a pending input makes a clean file saveable and revertable, the view alone does not", () => {
    const clean = { dirty: false, canRevert: false };
    expect(toolbarState(clean, false)).toEqual({ canSave: false, canRevert: false });
    expect(toolbarState(clean, true)).toEqual({ canSave: true, canRevert: true });
  });

  test("the revert rule stays the view's own once nothing is pending", () => {
    // Fichier neuf intact : Create est possible, Revert n'a rien à défaire.
    expect(toolbarState({ dirty: true, canRevert: false }, false)).toEqual({ canSave: true, canRevert: false });
    expect(toolbarState({ dirty: true, canRevert: true }, false)).toEqual({ canSave: true, canRevert: true });
  });

  test("a file that does not parse is never saveable, whatever is typed", () => {
    const broken = { dirty: false, canRevert: false, parseError: { message: "x", line: 1, col: 1 } };
    expect(toolbarState(broken, true)).toEqual({ canSave: false, canRevert: false });
  });
});
