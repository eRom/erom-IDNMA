import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlias, isNode, parseDocument, visit } from "yaml";
import { ConfigDocument, EditRefused } from "../src/configure/document.ts";
import type { EditOp } from "../src/configure/types.ts";
import { buildView } from "../src/configure/view.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");

/** Diff ligne à ligne (plus longue sous-suite commune) : les lignes retirées et les lignes ajoutées. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      removed.push(a[i] as string);
      i++;
    } else {
      added.push(b[j] as string);
      j++;
    }
  }
  return { removed, added };
}

/** Applique des opérations à une copie du texte et rend le texte obtenu. */
function edit(text: string | undefined, ...ops: EditOp[]): { config: ConfigDocument; text: string } {
  const config = ConfigDocument.parse(text);
  for (const op of ops) config.apply(op);
  return { config, text: config.toText() };
}

function refusal(config: ConfigDocument, op: EditOp): string {
  try {
    config.apply(op);
  } catch (e) {
    if (e instanceof EditRefused) return e.message;
    throw e;
  }
  throw new Error(`l'opération ${op.op} aurait dû être refusée`);
}

function agentKeys(config: ConfigDocument): string[] {
  return buildView(config, "/tmp/.idnma.yml", false).agents.map((agent) => agent.key);
}

function anchorNames(text: string): string[] {
  const names: string[] = [];
  visit(parseDocument(text, { merge: true }), (_key, node) => {
    if (isNode(node) && node.anchor) names.push(node.anchor);
  });
  return names;
}

describe("configure agent and engine operations", () => {
  test("renaming an engine touches one line", () => {
    const { config, text } = edit(romain, { op: "renameEngine", agent: "deepseek-flash", engine: "opencode", newName: "oc" });
    expect(changedLines(romain, text)).toEqual({ removed: ["      opencode:"], added: ["      oc:"] });
    const engines = buildView(config, "/tmp/.idnma.yml", false).agents.find((a) => a.key === "deepseek-flash")?.engines;
    expect(engines?.map((e) => e.command)).toContain("idnma run deepseek-flash --engine oc");
  });

  test("renaming an agent keeps its place", () => {
    const before = agentKeys(ConfigDocument.parse(romain));
    const { config, text } = edit(romain, { op: "renameAgent", key: "glm", newKey: "glm-53" });
    expect(changedLines(romain, text)).toEqual({ removed: ["  glm:"], added: ["  glm-53:"] });
    expect(agentKeys(config)).toEqual(before.map((key) => (key === "glm" ? "glm-53" : key)));
  });

  test("renaming keeps the comment above the key", () => {
    const source = "agents:\n  a:\n    label: A\n\n  # the b agent\n  b:\n    label: B\n";
    const { text } = edit(source, { op: "renameAgent", key: "b", newKey: "c" });
    expect(changedLines(source, text)).toEqual({ removed: ["  b:"], added: ["  c:"] });
    expect(text).toContain("\n\n  # the b agent\n  c:\n");
  });

  test("adds an agent at the end in block style", () => {
    const { text } = edit(
      undefined,
      { op: "addAgent", key: "opus", label: "Opus" },
      { op: "addEngine", agent: "opus", name: "default", harness: "claude" },
    );
    expect(text.endsWith("agents:\n  opus:\n    label: Opus\n    engines:\n      default:\n        harness: claude\n")).toBe(true);
    expect(text.startsWith("presets:\n  ollama: &ollama\n")).toBe(true);
  });

  test("adds an agent after the existing ones", () => {
    const { config, text } = edit(romain, { op: "addAgent", key: "fresh", label: "Fresh" });
    expect(changedLines(romain, text)).toEqual({ removed: [], added: ["  fresh:", "    label: Fresh"] });
    expect(agentKeys(config).at(-1)).toBe("fresh");
  });

  test("creates the root map and the agents map in an empty or comment-only file", () => {
    for (const source of ["", "# nothing yet\n", "agents:\n", "agents: {}\n"]) {
      const { text } = edit(source, { op: "addAgent", key: "a", label: "A" });
      const parsed = parseDocument(text, { merge: true });
      expect(parsed.errors).toEqual([]);
      expect(parsed.toJS()).toEqual({ agents: { a: { label: "A" } } });
      expect(text).toContain("agents:\n  a:\n    label: A\n");
      if (source.startsWith("#")) expect(text).toContain("# nothing yet");
    }
  });

  test("adds an engine to an agent that has none", () => {
    const { text } = edit("agents:\n  a:\n    label: A\n", { op: "addEngine", agent: "a", name: "default", harness: "codex" });
    expect(text).toBe("agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: codex\n");
  });

  test("duplicate copies engines and avatar, not info nor cell", () => {
    const { config, text } = edit(linked, { op: "duplicateAgent", key: "agy" });
    const js = parseDocument(text, { merge: true }).toJS() as { agents: Record<string, Record<string, unknown>> };
    expect(Object.keys(js.agents).at(-1)).toBe("agy-copy");
    expect(agentKeys(config).at(-1)).toBe("agy-copy");
    const copy = js.agents["agy-copy"] as Record<string, unknown>;
    expect(copy.label).toBe(`${js.agents.agy?.label} copy`);
    expect(copy.label).toBe("AGY Agent copy");
    expect(copy.avatar).toBe("gemini.png");
    expect(copy.engines).toEqual(js.agents.agy?.engines);
    expect(copy).not.toHaveProperty("info");
    expect(copy).not.toHaveProperty("cell");
    expect(js.agents.agy).toHaveProperty("info", 3.8);
  });

  test("duplicate picks a free key when the copy already exists", () => {
    const { config } = edit(romain, { op: "duplicateAgent", key: "opus" }, { op: "duplicateAgent", key: "opus" });
    const keys = agentKeys(config);
    expect(keys.slice(-2)).toEqual(["opus-copy", "opus-copy-2"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("duplicate unlinks anchored values in the copy", () => {
    const { text } = edit(linked, { op: "duplicateAgent", key: "glm" });
    const doc = parseDocument(text, { merge: true });
    expect(doc.errors).toEqual([]);

    // La copie ne porte ni ancre, ni alias vers une ancre interne ; seuls les alias de presets (externes) restent.
    const copy = doc.getIn(["agents", "glm-copy"], true);
    const copyAnchors: string[] = [];
    const copyAliases: string[] = [];
    visit(copy as never, (_key, node) => {
      if (isAlias(node)) copyAliases.push(node.source);
      else if (isNode(node) && node.anchor) copyAnchors.push(node.anchor);
    });
    expect(copyAnchors).toEqual([]);
    expect(copyAliases.sort()).toEqual(["claude-max", "ollama"]);

    // L'original garde ses ancres, et chaque ancre du document reste unique.
    const original = doc.getIn(["agents", "glm"], true);
    const originalAnchors: string[] = [];
    visit(original as never, (_key, node) => {
      if (isNode(node) && node.anchor) originalAnchors.push(node.anchor);
    });
    expect(originalAnchors.sort()).toEqual(["glm", "glm-flash"]);
    const all = anchorNames(text);
    expect(new Set(all).size).toBe(all.length);

    // Les valeurs résolues de la copie sont celles de l'original.
    const js = doc.toJS() as { agents: Record<string, { engines: unknown; label: string }> };
    expect(js.agents["glm-copy"]?.engines).toEqual(js.agents.glm?.engines);
    expect(js.agents["glm-copy"]?.label).toBe("GLM Agent copy");
  });

  test("duplicate resolves a chain of anchors that refer to each other", () => {
    const source =
      "agents:\n  a:\n    label: A\n    info: &first one\n    cell: &second [*first, two]\n    engines:\n      default:\n        harness: claude\n        options: *second\n";
    const { text } = edit(source, { op: "duplicateAgent", key: "a" });
    const doc = parseDocument(text, { merge: true });
    expect(doc.errors).toEqual([]);
    const js = doc.toJS() as { agents: { "a-copy": { engines: { default: { options: string[] } } } } };
    expect(js.agents["a-copy"].engines.default.options).toEqual(["one", "two"]);
    const copyText = text.slice(text.indexOf("  a-copy:"));
    expect(copyText).not.toMatch(/[&*]/);
    const all = anchorNames(text);
    expect(new Set(all).size).toBe(all.length);
  });

  test("make default swaps engine names", () => {
    const { config, text } = edit(romain, { op: "makeDefault", agent: "argon", engine: "claude" });
    expect(changedLines(romain, text)).toEqual({
      removed: ["      default:", "      claude:"],
      added: ["      claude:", "      default:"],
    });
    const js = parseDocument(text, { merge: true }).toJS() as {
      agents: { argon: { engines: Record<string, { harness: string }> } };
    };
    expect(js.agents.argon.engines.default?.harness).toBe("claude");
    expect(js.agents.argon.engines.claude?.harness).toBe("agy");
    const view = buildView(config, "/tmp/.idnma.yml", false).agents.find((a) => a.key === "argon");
    expect(view?.engines.filter((e) => e.isDefault).map((e) => e.harness)).toEqual(["claude"]);
  });

  test("make default renames the engine when the agent has no default", () => {
    const { text } = edit("agents:\n  a:\n    engines:\n      main:\n        harness: claude\n", {
      op: "makeDefault",
      agent: "a",
      engine: "main",
    });
    expect(text).toBe("agents:\n  a:\n    engines:\n      default:\n        harness: claude\n");
  });

  test("refuses to make the default engine default again", () => {
    const config = ConfigDocument.parse(romain);
    expect(refusal(config, { op: "makeDefault", agent: "argon", engine: "default" })).toMatch(/already/);
  });

  const shared =
    "agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        model: &shared m/x\n  b:\n    label: B\n    engines:\n      default:\n        harness: claude\n        model: *shared\n";

  test("refuses to delete an anchor used elsewhere", () => {
    for (const op of [
      { op: "deleteAgent", key: "a" },
      { op: "deleteEngine", agent: "a", engine: "default" },
    ] satisfies EditOp[]) {
      const config = ConfigDocument.parse(shared);
      const treeBefore = config.doc.toString();
      const message = refusal(config, op);
      expect(message).toContain("agents.b.engines.default.model");
      expect(message).toContain("&shared");
      expect(config.toText()).toBe(shared);
      expect(config.doc.toString()).toBe(treeBefore);
    }
  });

  test("allows deleting the user of an anchor, then its definition", () => {
    const { text } = edit(shared, { op: "deleteAgent", key: "b" }, { op: "deleteAgent", key: "a" });
    expect(parseDocument(text).errors).toEqual([]);
  });

  test("an anchor used only inside the deleted agent does not block it", () => {
    const { text } = edit(linked, { op: "deleteAgent", key: "glm" });
    const doc = parseDocument(text, { merge: true });
    expect(doc.errors).toEqual([]);
    const js = doc.toJS() as { agents: Record<string, unknown> };
    expect(js.agents).not.toHaveProperty("glm");
    expect(js.agents).toHaveProperty("deepseek");
  });

  test("deletes an engine and leaves the others", () => {
    const { text } = edit(romain, { op: "deleteEngine", agent: "deepseek-flash", engine: "dst" });
    const { removed, added } = changedLines(romain, text);
    expect(added).toEqual([]);
    expect(removed).toEqual(["      dst:", "        harness: dst", "        env:", '          DSH_PERMISSION_MODE: "danger-full-access"']);
  });

  test("refuses duplicate or malformed keys", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    expect(refusal(config, { op: "renameAgent", key: "opus", newKey: "sonnet" })).toMatch(/sonnet/);
    expect(refusal(config, { op: "addAgent", key: "-x", label: "X" })).toMatch(/-x/);
    expect(refusal(config, { op: "addAgent", key: "opus", label: "Again" })).toMatch(/opus/);
    expect(refusal(config, { op: "addAgent", key: "", label: "Empty" })).toMatch(/key/i);
    expect(refusal(config, { op: "renameEngine", agent: "deepseek-flash", engine: "dst", newName: "a b" })).toMatch(/a b/);
    expect(refusal(config, { op: "renameEngine", agent: "deepseek-flash", engine: "dst", newName: "opencode" })).toMatch(/opencode/);
    expect(refusal(config, { op: "addEngine", agent: "deepseek-flash", name: "dst", harness: "dst" })).toMatch(/dst/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("refuses an operation on a missing agent or engine", () => {
    const config = ConfigDocument.parse(romain);
    const treeBefore = config.doc.toString();
    const ops: EditOp[] = [
      { op: "deleteAgent", key: "ghost" },
      { op: "duplicateAgent", key: "ghost" },
      { op: "renameAgent", key: "ghost", newKey: "x" },
      { op: "setAgentField", key: "ghost", field: "label", value: "x" },
      { op: "addEngine", agent: "ghost", name: "x", harness: "claude" },
      { op: "deleteEngine", agent: "opus", engine: "ghost" },
      { op: "renameEngine", agent: "opus", engine: "ghost", newName: "x" },
      { op: "makeDefault", agent: "opus", engine: "ghost" },
    ];
    for (const op of ops) expect(refusal(config, op)).toMatch(/ghost/);
    expect(config.doc.toString()).toBe(treeBefore);
  });

  test("setting the label writes it in place", () => {
    const { text } = edit(romain, { op: "setAgentField", key: "opus", field: "label", value: "Opus Prime" });
    expect(changedLines(romain, text)).toEqual({ removed: ["    label: Opus"], added: ["    label: Opus Prime"] });
  });

  test("setting the avatar to null removes the key", () => {
    const { text } = edit(romain, { op: "setAgentField", key: "opus", field: "avatar", value: null });
    expect(changedLines(romain, text)).toEqual({ removed: ["    avatar: claude"], added: [] });
  });

  test("setting a missing avatar inserts it before the engines", () => {
    const { text } = edit(linked, { op: "setAgentField", key: "claude", field: "avatar", value: "claude.png" });
    expect(changedLines(linked, text)).toEqual({ removed: [], added: ["    avatar: claude.png"] });
    expect(text).toContain("    cell: 1\n    avatar: claude.png\n    engines:");
  });

  test("setting a label that needs quoting stays a string", () => {
    const { text } = edit(romain, { op: "setAgentField", key: "opus", field: "label", value: "12" });
    const js = parseDocument(text).toJS() as { agents: { opus: { label: unknown } } };
    expect(js.agents.opus.label).toBe("12");
  });

  test("refuses every operation while the file does not parse", () => {
    const config = ConfigDocument.parse("agents:\n  a: [unclosed\n");
    expect(config.parseError).toBeDefined();
    expect(refusal(config, { op: "addAgent", key: "b", label: "B" })).toBe("Fix the syntax error first.");
    expect(config.toText()).toBe("agents:\n  a: [unclosed\n");
  });

  test("an operation that changes nothing leaves a CRLF file byte for byte", () => {
    const crlf = "agents:\r\n  a:\r\n    label: A\r\n    engines:\r\n      default:\r\n        harness: claude\r\n";
    const { text } = edit(crlf, { op: "setAgentField", key: "a", field: "avatar", value: null });
    expect(text).toBe(crlf);
  });
});
