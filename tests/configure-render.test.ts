import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigDocument } from "../src/configure/document.ts";
import { compareNames, escapeHtml, renderApp, shownKeys, type UiState } from "../src/configure/page/render.ts";
import type { ConfigView } from "../src/configure/types.ts";
import { buildView } from "../src/configure/view.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "configure");
const romain = readFileSync(join(FIXTURES, "romain.yml"), "utf-8");
const linked = readFileSync(join(FIXTURES, "linked-values.yml"), "utf-8");

/** Fichier AC-6 : un nombre dans un preset provider, utilisé par un engine claude. */
const ac6 = `presets:
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

function viewOf(text: string | undefined, dirty = false): ConfigView {
  return buildView(ConfigDocument.parse(text), "/tmp/.idnma.yml", dirty);
}

const agentsTab = (selected?: string): UiState => (selected === undefined ? { tab: "agents" } : { tab: "agents", selected });

/** Texte visible d'un fragment : balises retirées, entités laissées telles quelles. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

/** Le bloc `<section class="eng">` d'un engine, repéré par son identifiant de focus de nom ou de commande. */
function engineBlocks(html: string): string[] {
  return html.split('<section class="eng"').slice(1);
}

describe("configure render", () => {
  test("escapes file-provided text", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const view = viewOf(`agents:\n  a:\n    label: "${hostile}"\n    engines:\n      default:\n        harness: claude\n`);
    const html = renderApp(view, agentsTab("a"));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  test("keeps attribute values from breaking out of the attribute", () => {
    const hostile = '" autofocus onfocus="alert(1)';
    const view = viewOf(
      `agents:\n  a:\n    label: 'x'\n    engines:\n      default:\n        harness: claude\n        model: '${hostile.replaceAll("'", "''")}'\n`,
    );
    const html = renderApp(view, agentsTab("a"));
    expect(html).not.toContain('" autofocus');
    expect(html).toContain("&quot; autofocus");
  });

  test("heads each engine with its command", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const blocks = engineBlocks(html);
    expect(blocks.length).toBe(3);
    const commands = ["idnma run deepseek-flash", "idnma run deepseek-flash --engine dst", "idnma run deepseek-flash --engine opencode"];
    const copies = [...html.matchAll(/data-action="copy" data-text="([^"]*)"/g)].map((m) => m[1]);
    expect(copies).toEqual(commands);
    // Chaque bloc porte sa commande, dans l'ordre du fichier.
    blocks.forEach((block, i) => expect(block).toContain(`data-text="${commands[i]}"`));
    // Le nom d'un engine se modifie dans la ligne ; « default » est une mention.
    expect(blocks[1]).toContain('data-action="renameEngine"');
    expect(blocks[0]).not.toContain('data-action="renameEngine"');
    expect(textOf(blocks[0] ?? "")).toContain("default");
    expect(blocks[0]).not.toContain('data-action="makeDefault"');
    expect(blocks[1]).toContain('data-action="makeDefault"');
  });

  test("shows the dst model sentence instead of a model field", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const [claude, dst, opencode] = engineBlocks(html);
    expect(dst).toContain("Model is chosen inside dst with /model");
    expect(dst).not.toContain('data-action="setModel"');
    expect(claude).toContain('data-action="setModel"');
    expect(claude).not.toContain("Model is chosen inside dst");
    expect(opencode).toContain('data-action="setModel"');
    // L'env propre au dst se montre, avec sa valeur.
    expect(dst).toContain("DSH_PERMISSION_MODE");
    expect(dst).toContain("danger-full-access");
  });

  test("shows the provider menu only for claude engines", () => {
    const view = viewOf(romain);
    const [claude, dst, opencode] = engineBlocks(renderApp(view, agentsTab("deepseek-flash")));
    expect(claude).toContain('data-kind="provider"');
    expect(dst).not.toContain('data-kind="provider"');
    expect(opencode).not.toContain('data-kind="provider"');
    expect(dst).not.toContain("Provider");

    // Fermé, aucune liste ; ouvert, la liste des providers avec « Custom env… » et « Edit providers… ».
    const closed = renderApp(view, agentsTab("deepseek-flash"));
    expect(closed).not.toContain('role="menu"');
    const open = renderApp(view, { ...agentsTab("deepseek-flash"), menu: { agent: "deepseek-flash", engine: "default", kind: "provider" } });
    const menu = open.slice(open.indexOf('role="menu"'));
    expect(menu).toContain("Anthropic");
    expect(menu).toContain("no proxy");
    expect(menu).toContain('data-provider-kind="preset" data-preset="ollama"');
    expect(menu).toContain("Custom env…");
    expect(menu).toContain("Edit providers…");
    // Le menu n'appartient qu'à l'engine désigné.
    expect(open.split('role="menu"').length).toBe(2);
    expect(engineBlocks(open)[0]).toContain('role="menu"');
  });

  test("lists the option sets and offers a custom list from the options menu", () => {
    const view = viewOf(romain);
    const html = renderApp(view, { ...agentsTab("deepseek-flash"), menu: { agent: "deepseek-flash", engine: "default", kind: "options" } });
    const menu = html.slice(html.indexOf('role="menu"'));
    expect(menu).toContain('data-options-kind="none"');
    expect(menu).toContain('data-options-kind="preset" data-preset="claude-max"');
    expect(menu).toContain('data-options-kind="custom"');
  });

  test("marks errors where they are fixed", () => {
    const view = viewOf(ac6);
    const html = renderApp(view, { tab: "providers", selected: "lmstudio" });
    expect(html).toContain("Quote it");
    expect(html).toContain('data-action="quote" data-path="[&quot;presets&quot;,&quot;lmstudio&quot;,&quot;CLAUDE_CODE_ATTRIBUTION_HEADER&quot;]"');
    expect(textOf(html)).toContain("1 issue");
    expect(textOf(html)).not.toContain("1 issues");
    // Point rouge sur la rangée du preset, anneau rouge sur le champ fautif.
    const row = html.split('<button').find((b) => b.includes('data-key="lmstudio"')) ?? "";
    expect(row).toContain("dot err");
    const field = html.split("<input").find((i) => i.includes('value="0"')) ?? "";
    expect(field).toContain('aria-invalid="true"');
    // Le message est sous la ligne fautive.
    expect(html.indexOf("Values must be text")).toBeGreaterThan(html.indexOf('value="0"'));
    // L'agent qui dépend du preset ne porte pas l'erreur.
    const agents = renderApp(view, { tab: "agents" });
    const agentRow = agents.split("<button").find((b) => b.includes('data-key="oss20"')) ?? "";
    expect(agentRow).not.toContain("dot err");
    // « Used by » donne l'agent qui dépend du preset, en badge.
    expect(html).toContain('data-action="openAgent" data-key="oss20" data-harness="claude"');
  });

  test("builds the quote path of an engine variable and of an option item", () => {
    const text = `agents:
  x:
    label: X
    engines:
      default:
        harness: claude
        options: [--effort, 5]
        env:
          PRICE: 3.80
`;
    const html = renderApp(viewOf(text), agentsTab("x"));
    expect(html).toContain('data-path="[&quot;agents&quot;,&quot;x&quot;,&quot;engines&quot;,&quot;default&quot;,&quot;env&quot;,&quot;PRICE&quot;]"');
    expect(html).toContain('data-path="[&quot;agents&quot;,&quot;x&quot;,&quot;engines&quot;,&quot;default&quot;,&quot;options&quot;,1]"');
    expect(textOf(html)).toContain("2 issues");
  });

  test("new file toolbar", () => {
    const html = renderApp(viewOf(undefined, true), { tab: "providers" });
    expect(html).toContain("New file");
    expect(html).toContain("Create");
    expect(html).not.toContain(">Save");
    // Les quatre built-ins sont proposés dans les onglets Providers et Options.
    for (const name of ["ollama", "lmstudio", "openrouter"]) expect(html).toContain(`data-key="${name}"`);
    expect(html).toContain("Built-in");
    expect(renderApp(viewOf(undefined, true), { tab: "options" })).toContain('data-key="claude-max"');
  });

  test("save and revert follow the dirty flag, with one primary action", () => {
    const clean = renderApp(viewOf(romain, false), agentsTab());
    const doc = ConfigDocument.parse(romain);
    doc.apply({ op: "setAgentField", key: "opus", field: "label", value: "Opus 2" });
    const dirty = renderApp(buildView(doc, "/tmp/.idnma.yml", true), agentsTab());
    expect(clean).toMatch(/data-action="save"[^>]*disabled/);
    expect(clean).toMatch(/data-action="revert"[^>]*disabled/);
    expect(dirty).not.toMatch(/data-action="save"[^>]*disabled/);
    expect(dirty).not.toMatch(/data-action="revert"[^>]*disabled/);
    expect(dirty.match(/btn pri/g)?.length).toBe(1);
    expect(dirty).toContain("⌘S");
  });

  test("Revert stays disabled on an untouched new file, whose Create is enabled", () => {
    const html = renderApp(viewOf(undefined, true), agentsTab());
    expect(html).toMatch(/data-action="revert"[^>]*disabled/);
    expect(html).not.toMatch(/data-action="save"[^>]*disabled/);
  });

  test("shows the display path, with ~ for the home directory, in the toolbar", () => {
    const view = buildView(ConfigDocument.parse(romain), join(homedir(), ".idnma.yml"), false);
    const html = renderApp(view, agentsTab());
    expect(html).toContain('<span class="path">~/.idnma.yml</span>');
    expect(html).not.toContain(homedir());
  });

  test("gives a file without agent a first-agent screen with its own primary action", () => {
    const html = renderApp(viewOf(undefined, true), agentsTab());
    expect(textOf(html)).toContain("Add your first agent");
    expect(textOf(html)).toContain("An agent is a model: give it a key, then choose how it runs.");
    expect(html).not.toContain("No agents yet");
    const form = html.slice(html.indexOf('<form class="addrow first"'), html.indexOf("</form>"));
    expect(form).toContain('data-add="addAgent"');
    for (const id of ["add:key", "add:label", "add:harness"]) expect(form).toContain(`id="${id}"`);
    expect(form).toContain('class="btn pri">Add agent</button>');
    // Une seule ligne de création d'agent à l'écran, même si la barre latérale en demande une.
    const asked = renderApp(viewOf(undefined, true), { ...agentsTab(), adding: { action: "addAgent" } });
    expect(asked.split('data-add="addAgent"').length).toBe(2);
    expect(asked.split(' id="add:key"').length).toBe(2);
    // Avec des agents, l'écran d'accueil n'apparaît pas.
    expect(textOf(renderApp(viewOf(romain), agentsTab()))).not.toContain("Add your first agent");
  });

  test("gives the Harness select the same chevron as the menu triggers", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const selects = [...html.matchAll(/<span class="sel"><select[^>]*>.*?<\/select><span class="cv" aria-hidden="true">⌄<\/span><\/span>/g)];
    expect(selects.length).toBe(3);
  });

  test("parse error screen", () => {
    const doc = ConfigDocument.parse("agents:\n  a: [unclosed\n");
    const view = buildView(doc, "/tmp/.idnma.yml", false);
    expect(view.parseError).toBeDefined();
    const html = renderApp(view, agentsTab());
    expect(html).toContain(escapeHtml(view.parseError?.message ?? "?"));
    expect(textOf(html)).toContain(`Line ${view.parseError?.line}`);
    expect(textOf(html)).toContain(`column ${view.parseError?.col}`);
    expect(html).toContain('data-action="reload"');
    expect(html).toContain("Reload");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('data-action="save"');
  });

  test("renders the agent view of the validated mock-up", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const text = textOf(html);
    expect(text).toContain("Agents 18");
    expect(text).toContain("Valid · 18 agents");
    expect(text).toContain("+ Add agent");
    expect(text).toContain("+ Add engine");
    expect(text).toContain("Duplicate");
    expect(text).toContain("Delete");
    // L'info est un sous-titre, jamais un champ ; `cell` n'apparaît pas.
    expect(html).not.toContain('data-field="info"');
    expect(html).not.toContain('data-field="cell"');
    // Le YAML n'est jamais montré.
    expect(html).not.toContain("engines:");
    // Rangée sélectionnée avec le harnais de default et +N.
    const row = html.split("<button").find((b) => b.includes('data-key="deepseek-flash"')) ?? "";
    expect(row).toContain('class="row sel"');
    expect(textOf(row)).toContain("claude +2");
    // Aucun style en ligne : tout passe par la feuille de style.
    expect(html).not.toMatch(/ style=/);
  });

  test("selects the first displayed row when nothing valid is selected", () => {
    const html = renderApp(viewOf(romain), agentsTab("does-not-exist"));
    // La première rangée est la première dans l'ordre alphabétique affiché, plus celle du fichier (opus).
    const first = [...html.matchAll(/data-action="select" data-key="([^"]*)"/g)][0]?.[1] ?? "";
    expect(first).not.toBe("opus");
    expect(html).toContain(`data-action="duplicateAgent" data-agent="${first}"`);
    expect(html).toContain(`class="row sel" aria-current="true" data-action="select" data-key="${first}"`);
  });

  test("shows linked values read only, with Unlink and the other places", () => {
    const view = viewOf(linked);
    const modelLinked = view.agents.flatMap((a) => a.engines.map((e) => ({ a, e }))).find(({ e }) => e.modelLinked);
    expect(modelLinked).toBeDefined();
    const html = renderApp(view, agentsTab(modelLinked?.a.key));
    const block = engineBlocks(html).find((b) => b.includes(`data-text="${modelLinked?.e.command}"`)) ?? "";
    expect(block).toContain('data-action="unlink"');
    expect(block).toContain(`data-path="[&quot;agents&quot;,&quot;${modelLinked?.a.key}&quot;,&quot;engines&quot;,&quot;${modelLinked?.e.name}&quot;,&quot;model&quot;]"`);
    expect(block).toMatch(/<input[^>]*readonly[^>]*value="/);
    expect(block).toContain(escapeHtml(modelLinked?.e.modelLinked?.sharedWith[0] ?? "?"));
  });

  test("shows the merged preset at the head of the env of a non claude engine", () => {
    const text = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
agents:
  a:
    label: A
    engines:
      default:
        harness: codex
        env:
          <<: *ollama
          FLAG: "1"
`;
    const html = renderApp(viewOf(text), agentsTab("a"));
    expect(html).toContain("&lt;&lt; ollama");
    expect(html).toContain('data-action="removeMerge"');
    expect(html).toContain('value="FLAG"');
  });

  test("lists custom options as editable tokens and a preset as read only tokens", () => {
    const text = `presets:
  fast: &fast [--effort, low]
agents:
  a:
    label: A
    engines:
      default:
        harness: claude
        options: [--verbose]
      other:
        harness: codex
        options: *fast
`;
    const [custom, preset] = engineBlocks(renderApp(viewOf(text), agentsTab("a")));
    expect(custom).toMatch(/<input[^>]*data-action="setOptions"[^>]*value="--verbose"/);
    expect(preset).not.toMatch(/<input[^>]*data-action="setOptions"/);
    expect(textOf(preset ?? "")).toContain("--effort");
  });

  test("shows an option set with its tokens, moves and Used by", () => {
    const html = renderApp(viewOf(romain), { tab: "options", selected: "claude-max" });
    expect(html).toContain('data-action="moveOption"');
    expect(html).toContain('data-action="addOption"');
    expect(html).toContain('value="--effort"');
    expect(textOf(html)).toContain("Used by");
    expect(html).toContain('data-action="openAgent"');
    expect(html).not.toContain('data-action="copy"');
  });

  test("gives every field a stable, unique focus id", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const ids = [...html.matchAll(/<(?:input|select|button)[^>]*data-focus-id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("agent:deepseek-flash:label");
    expect(ids).toContain("agent:deepseek-flash:engine:opencode:model");
    for (const field of html.matchAll(/<(?:input|select)\b[^>]*>/g)) expect(field[0]).toContain("data-focus-id=");
    expect(renderApp(viewOf(romain), agentsTab("deepseek-flash"))).toBe(html);
  });

  test("rings the name input for a bad variable name and the value input for a non text value", () => {
    const text = `agents:
  a:
    label: A
    engines:
      default:
        harness: codex
        env:
          "bad name": "x"
          PRICE: 0
`;
    const inputOf = (html: string, field: string, name: string): string =>
      [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`data-field="${field}"`) && tag.includes(`data-name="${name}"`)) ?? "";
    const html = renderApp(viewOf(text), agentsTab("a"));
    expect(inputOf(html, "name", "bad name")).toContain('aria-invalid="true"');
    expect(inputOf(html, "value", "bad name")).not.toContain("aria-invalid");
    expect(inputOf(html, "value", "PRICE")).toContain('aria-invalid="true"');
    expect(inputOf(html, "name", "PRICE")).not.toContain("aria-invalid");
    // Même règle pour les variables d'un provider.
    const preset = renderApp(viewOf(`presets:\n  p:\n    "bad name": "x"\n    PRICE: 0\n`), { tab: "providers", selected: "p" });
    expect(inputOf(preset, "name", "bad name")).toContain('aria-invalid="true"');
    expect(inputOf(preset, "value", "PRICE")).toContain('aria-invalid="true"');
    expect(inputOf(preset, "name", "PRICE")).not.toContain("aria-invalid");
  });
});

/** Les éléments et attributs que le rendu a le droit de produire ; tout le reste vient d'une valeur du fichier. */
const ALLOWED_TAGS = new Set(["div", "header", "span", "button", "nav", "main", "h2", "p", "i", "label", "input", "select", "option", "code", "section", "form"]);
const ALLOWED_ATTRIBUTES = new Set([
  "class", "type", "id", "value", "role", "disabled", "readonly", "placeholder", "spellcheck", "autocomplete", "for", "selected", "novalidate",
]);

interface Structure {
  tags: Set<string>;
  attributes: Set<string>;
  ariaLabels: string[];
  /** Éléments de bloc rencontrés sous un `span` ou un `button`. */
  blockInInline: string[];
}

/** Parcourt le HTML avec le `HTMLRewriter` de Bun : la structure que le navigateur verrait, pas une regex. */
async function structureOf(html: string): Promise<Structure> {
  const result: Structure = { tags: new Set(), attributes: new Set(), ariaLabels: [], blockInInline: [] };
  const open: string[] = [];
  const block = new Set(["div", "main", "nav", "header", "section", "form", "p", "h2"]);
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        result.tags.add(el.tagName);
        for (const [name, value] of el.attributes) {
          result.attributes.add(name);
          if (name === "aria-label") result.ariaLabels.push(value);
        }
        if (block.has(el.tagName) && (open.includes("span") || open.includes("button"))) result.blockInInline.push(el.tagName);
        // Un élément vide (`input`) n'a pas de balise fermante.
        if (el.tagName !== "input") {
          open.push(el.tagName);
          el.onEndTag(() => void open.pop());
        }
      },
    })
    .transform(new Response(html))
    .text();
  return result;
}

const unexpected = (s: Structure): { tags: string[]; attributes: string[] } => ({
  tags: [...s.tags].filter((t) => !ALLOWED_TAGS.has(t)),
  attributes: [...s.attributes].filter((a) => !ALLOWED_ATTRIBUTES.has(a) && !/^(data|aria)-[a-z-]+$/.test(a)),
});

const HOSTILE = `"><svg onload=x> ' onfocus='`;
const Q = JSON.stringify(HOSTILE);

/** Un agent minimal dont un seul champ porte la chaîne hostile. */
function agentYaml(o: { key?: string; label?: string; info?: string; avatar?: string; engines?: string; model?: string; options?: string; env?: string }): string {
  return `agents:
  ${o.key ?? "a"}:
    label: ${o.label ?? "A"}
${o.info ? `    info: ${o.info}\n` : ""}${o.avatar ? `    avatar: ${o.avatar}\n` : ""}    engines:
      default:
        harness: claude
${o.model ? `        model: ${o.model}\n` : ""}${o.options ? `        options: [${o.options}]\n` : ""}${o.env ? `        env:\n          ${o.env}\n` : ""}${o.engines ?? ""}`;
}

describe("configure render escaping", () => {
  const cases: [string, string, UiState][] = [
    ["agent key", agentYaml({ key: Q }), agentsTab(HOSTILE)],
    ["label", agentYaml({ label: Q }), agentsTab("a")],
    ["info", agentYaml({ info: Q }), agentsTab("a")],
    ["avatar", agentYaml({ avatar: Q }), agentsTab("a")],
    ["engine name", agentYaml({ engines: `      ${Q}:\n        harness: codex\n` }), agentsTab("a")],
    ["model", agentYaml({ model: Q }), agentsTab("a")],
    ["option", agentYaml({ options: Q }), agentsTab("a")],
    ["env name", agentYaml({ env: `${Q}: "x"` }), agentsTab("a")],
    ["env value", agentYaml({ env: `K: ${Q}` }), agentsTab("a")],
    ["preset name", `presets:\n  ${Q}:\n    ANTHROPIC_BASE_URL: "x"\n`, { tab: "providers", selected: HOSTILE }],
    ["preset variable name", `presets:\n  p:\n    ${Q}: "x"\n`, { tab: "providers", selected: "p" }],
    ["preset variable value", `presets:\n  p:\n    K: ${Q}\n`, { tab: "providers", selected: "p" }],
    ["option item of an option set", `presets:\n  p: [${Q}]\n`, { tab: "options", selected: "p" }],
    ["preset in the provider menu", `presets:\n  ${Q}:\n    ANTHROPIC_BASE_URL: "x"\n${agentYaml({})}`, { ...agentsTab("a"), menu: { agent: "a", engine: "default", kind: "provider" } }],
    ["option set in the options menu", `presets:\n  ${Q}: [--x]\n${agentYaml({})}`, { ...agentsTab("a"), menu: { agent: "a", engine: "default", kind: "options" } }],
  ];

  for (const [place, yaml, ui] of cases) {
    test(`keeps a hostile ${place} inside its text or attribute`, async () => {
      const view = buildView(ConfigDocument.parse(yaml), "/tmp/.idnma.yml", false);
      const html = renderApp(view, ui);
      // La chaîne est bien rendue (le test n'est pas vide), échappée.
      expect(html).toContain("&lt;svg");
      expect(unexpected(await structureOf(html))).toEqual({ tags: [], attributes: [] });
    });
  }

  test("keeps a hostile file path inside its text", async () => {
    const view = buildView(ConfigDocument.parse(agentYaml({})), HOSTILE, false);
    const html = renderApp(view, agentsTab("a"));
    expect(html).toContain("&lt;svg");
    expect(unexpected(await structureOf(html))).toEqual({ tags: [], attributes: [] });
  });

  test("keeps hostile names inside an add row", async () => {
    const view = buildView(ConfigDocument.parse(agentYaml({ key: Q })), "/tmp/.idnma.yml", false);
    const html = renderApp(view, { ...agentsTab(HOSTILE), adding: { action: "addEngine", agent: HOSTILE } });
    expect(html).toContain('class="addrow"');
    expect(unexpected(await structureOf(html))).toEqual({ tags: [], attributes: [] });
  });
});

describe("configure render accessibility", () => {
  const menuOf = (kind: "provider" | "options"): UiState => ({ ...agentsTab("deepseek-flash"), menu: { agent: "deepseek-flash", engine: "default", kind } });

  test("names the Provider and Options triggers with their caption and hides the chevron", () => {
    const html = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    expect(html).toContain('aria-label="Provider: ollama"');
    expect(html).toContain('aria-label="Options: claude-max"');
    const triggers = [...html.matchAll(/<button\b[^>]*aria-haspopup="menu"[^>]*>.*?<\/button>/g)].map((m) => m[0]);
    expect(triggers.length).toBeGreaterThan(1);
    for (const trigger of triggers) expect(trigger).toContain('<span class="cv" aria-hidden="true">⌄</span>');
  });

  test("gives repeated controls a name that includes the engine or the variable", async () => {
    const structure = await structureOf(renderApp(viewOf(romain), agentsTab("deepseek-flash")));
    // Trois engines : chaque Copy, Model et Harness se distingue des autres.
    expect(structure.ariaLabels).toContain("Copy idnma run deepseek-flash --engine dst");
    expect(structure.ariaLabels).toContain("Model of engine opencode");
    expect(structure.ariaLabels).toContain("Harness of engine dst");
    expect(structure.ariaLabels).toContain("Name of variable DSH_PERMISSION_MODE");
    expect(structure.ariaLabels).toContain("DSH_PERMISSION_MODE value");
    expect(new Set(structure.ariaLabels).size).toBe(structure.ariaLabels.length);
  });

  test("never nests a block element in a span or a button, in any view", async () => {
    const views = [
      renderApp(viewOf(romain), menuOf("provider")),
      renderApp(viewOf(romain), menuOf("options")),
      renderApp(viewOf(romain), { tab: "providers", selected: "ollama" }),
      renderApp(viewOf(romain), { tab: "options", selected: "claude-max" }),
      renderApp(viewOf(romain), { ...agentsTab("deepseek-flash"), adding: { action: "addEnvVar", agent: "deepseek-flash", engine: "default" } }),
      renderApp(viewOf(linked), agentsTab()),
    ];
    for (const html of views) expect((await structureOf(html)).blockInInline).toEqual([]);
  });

  test("puts the alert role on the parse error message, not on main", () => {
    const view = buildView(ConfigDocument.parse("agents:\n  a: [unclosed\n"), "/tmp/.idnma.yml", false);
    const html = renderApp(view, agentsTab());
    expect(html).not.toMatch(/<main[^>]*role="alert"/);
    expect(html).toMatch(/<p class="message" role="alert">/);
  });
});

describe("configure render env section", () => {
  test("folds an engine without own variables into one small add action", () => {
    const [claude, dst] = engineBlocks(renderApp(viewOf(romain), agentsTab("deepseek-flash")));
    expect(claude).toContain('data-action="addEnvVar"');
    expect(claude).not.toContain('class="kv"');
    expect(claude).not.toContain('class="envbox"');
    expect(textOf(claude ?? "")).not.toContain("Env");
    // Un engine qui a des variables garde la section.
    expect(dst).toContain('class="kv"');
    expect(textOf(dst ?? "")).toContain("Env");
  });

  test("keeps the section for a merged preset even without own variables", () => {
    const text = `presets:\n  ollama: &ollama\n    ANTHROPIC_BASE_URL: "http://localhost:11434"\nagents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: codex\n        env:\n          <<: *ollama\n`;
    const html = renderApp(viewOf(text), agentsTab("a"));
    expect(html).toContain("&lt;&lt; ollama");
    expect(html).toContain('data-action="addEnvVar"');
  });

  test("shows no add action on a read only engine without variables", () => {
    const view = viewOf(romain);
    const agent = view.agents.find((a) => a.engines.some((e) => e.harness === "claude"));
    const engine = agent?.engines.find((e) => e.harness === "claude");
    if (!agent || !engine) throw new Error("fixture has no claude engine");
    engine.readOnly = "Defined by an alias.";
    engine.env = [];
    const block = engineBlocks(renderApp(view, agentsTab(agent.key))).find((b) => b.includes(`data-text="${engine.command}"`)) ?? "";
    expect(block).not.toContain('data-action="addEnvVar"');
  });

  test("swaps the add button for its input row only where the creation is in progress", () => {
    const ui: UiState = { ...agentsTab("deepseek-flash"), adding: { action: "addEnvVar", agent: "deepseek-flash", engine: "dst" } };
    const [claude, dst] = engineBlocks(renderApp(viewOf(romain), ui));
    expect(dst).toContain('<form class="addrow" data-add="addEnvVar" data-agent="deepseek-flash" data-engine="dst"');
    expect(dst).toContain('id="add:name"');
    expect(claude).not.toContain("addrow");
    expect(claude).toContain('data-action="addEnvVar"');
  });
});

// --- Ordre alphabétique, regroupement par harnais, badges « Used by » -------------------------------

const asSorted = (names: string[]): string[] => [...names].sort(compareNames);

/** Les clés des rangées de la barre latérale, dans l'ordre affiché (une clé peut y figurer plusieurs fois). */
function rowKeys(html: string): string[] {
  const side = html.slice(html.indexOf('<nav class="side">'), html.indexOf("</nav>"));
  return [...side.matchAll(/<button type="button" class="row(?: sel)?"[^>]*data-action="select" data-key="([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** Les options (valeur, présélection) du `<select>` désigné par son id. */
function selectOptions(html: string, id: string): { value: string; selected: boolean }[] {
  const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>(.*?)</select>`));
  return [...(select?.[1] ?? "").matchAll(/<option value="([^"]*)"( selected)?>/g)].map((m) => ({ value: m[1] ?? "", selected: m[2] !== undefined }));
}

/** Les groupes de la barre latérale : leur titre et les clés de leurs rangées. */
function sidebarGroups(html: string): { header: string; keys: string[] }[] {
  const side = html.slice(html.indexOf('<nav class="side">'), html.indexOf("</nav>"));
  return side
    .split('<div class="rowgroup"')
    .slice(1)
    .map((chunk) => ({
      header: textOf(chunk.match(/<div class="gh">(.*?)<\/div>/)?.[1] ?? "").trim(),
      keys: [...chunk.matchAll(/data-action="select" data-key="([^"]*)"/g)].map((m) => m[1] ?? ""),
    }));
}

const claudeAgents = (...keys: string[]): string =>
  keys.map((k) => `  ${k}:\n    engines:\n      default:\n        harness: claude\n`).join("");

describe("configure render order", () => {
  test("compareNames orders case-insensitively, numbers by value, and is deterministic on ties", () => {
    expect(["b", "A", "c"].sort(compareNames)).toEqual(["A", "b", "c"]);
    expect(["agent 10", "agent 2"].sort(compareNames)).toEqual(["agent 2", "agent 10"]);
    // « a » et « A » sont égaux pour la locale : l'ordre des points de code les départage, dans les deux sens.
    expect(compareNames("A", "a")).toBeLessThan(0);
    expect(compareNames("a", "A")).toBeGreaterThan(0);
    expect(compareNames("a", "a")).toBe(0);
  });

  test("sorts the harness select of an engine and of the add form, and keeps claude preselected on add", () => {
    const engine = renderApp(viewOf(romain), agentsTab("deepseek-flash"));
    const engineOptions = selectOptions(engine, "agent:deepseek-flash:engine:default:harness").map((o) => o.value);
    expect(engineOptions.length).toBeGreaterThanOrEqual(6);
    expect(engineOptions).toEqual(asSorted(engineOptions));

    const add = renderApp(viewOf(romain), { ...agentsTab("deepseek-flash"), adding: { action: "addAgent" } });
    const addOptions = selectOptions(add, "add:harness");
    expect(addOptions.map((o) => o.value)).toEqual(asSorted(engineOptions));
    // claude n'est plus la première option, mais reste le choix par défaut d'un nouvel agent.
    expect(addOptions[0]?.value).not.toBe("claude");
    expect(addOptions.filter((o) => o.selected).map((o) => o.value)).toEqual(["claude"]);

    const addEngine = renderApp(viewOf(romain), { ...agentsTab("deepseek-flash"), adding: { action: "addEngine", agent: "deepseek-flash" } });
    expect(selectOptions(addEngine, "add:harness").filter((o) => o.selected).map((o) => o.value)).toEqual(["claude"]);
  });

  test("keeps the unknown harness of an engine as its first option, then the sorted ones", () => {
    const text = "agents:\n  a:\n    engines:\n      default:\n        harness: martian\n";
    const options = selectOptions(renderApp(viewOf(text), agentsTab("a")), "agent:a:engine:default:harness");
    expect(options[0]).toEqual({ value: "martian", selected: true });
    expect(options.slice(1).map((o) => o.value)).toEqual(asSorted(options.slice(1).map((o) => o.value)));
  });

  test("sorts the provider menu as one list with Anthropic, the tail last", () => {
    const text = `presets:\n  aardvark: &aardvark\n    K: v\n  zeta: &zeta\n    K: v\nagents:\n${claudeAgents("a")}`;
    const html = renderApp(viewOf(text), { ...agentsTab("a"), menu: { agent: "a", engine: "default", kind: "provider" } });
    const menu = html.slice(html.indexOf('role="menu"'));
    const [main = "", tail = ""] = menu.split('<div class="msep">');
    const labels = [...main.matchAll(/data-provider-kind="(anthropic|preset)"(?: data-preset="([^"]*)")?/g)].map((m) => (m[1] === "anthropic" ? "Anthropic" : (m[2] ?? "")));
    expect(labels.length).toBeGreaterThanOrEqual(5);
    expect(labels).toEqual(asSorted(labels));
    // Anthropic n'est pas en tête : elle se trie avec les presets.
    expect(labels.indexOf("aardvark")).toBeLessThan(labels.indexOf("Anthropic"));
    expect(labels.indexOf("Anthropic")).toBeLessThan(labels.indexOf("zeta"));
    expect(textOf(tail)).toMatch(/Custom env….*Edit providers…/);
  });

  test("lists None first in the options menu, then the option sets sorted, Custom last", () => {
    const text = `presets:\n  zz: &zz [--a]\n  aa: &aa [--b]\nagents:\n${claudeAgents("a")}`;
    const html = renderApp(viewOf(text), { ...agentsTab("a"), menu: { agent: "a", engine: "default", kind: "options" } });
    const menu = html.slice(html.indexOf('role="menu"'));
    const [main = "", tail = ""] = menu.split('<div class="msep">');
    const kinds = [...main.matchAll(/data-options-kind="(none|preset)"(?: data-preset="([^"]*)")?/g)].map((m) => (m[1] === "none" ? "" : (m[2] ?? "")));
    expect(kinds[0]).toBe("");
    const sets = kinds.slice(1);
    expect(sets.length).toBeGreaterThanOrEqual(3);
    expect(sets).toEqual(asSorted(sets));
    expect(sets).toContain("aa");
    expect(tail).toContain('data-options-kind="custom"');
  });

  test("sorts the agent rows by displayed name, the key standing in for a missing label", () => {
    const text = `agents:
  k1:
    label: Zulu
    engines:
      default:
        harness: claude
  k2:
    label: alpha
    engines:
      default:
        harness: claude
  Charlie:
    engines:
      default:
        harness: claude
  n10:
    label: Agent 10
    engines:
      default:
        harness: claude
  n2:
    label: Agent 2
    engines:
      default:
        harness: claude
`;
    const view = viewOf(text);
    const keys = rowKeys(renderApp(view, agentsTab()));
    const shown = (key: string): string => view.agents.find((a) => a.key === key)?.label || key;
    expect(keys.map(shown)).toEqual(asSorted(keys.map(shown)));
    expect(keys).toHaveLength(5);
    // Le label diffère de la clé : l'ordre suit ce que l'on voit, pas la clé.
    expect(keys.indexOf("k2")).toBeLessThan(keys.indexOf("k1"));
    expect(keys.indexOf("n2")).toBeLessThan(keys.indexOf("n10"));
  });

  test("breaks a tie between two agents with the same displayed name by key", () => {
    const text = `agents:\n  b:\n    label: Same\n    engines:\n      default:\n        harness: claude\n  a:\n    label: Same\n    engines:\n      default:\n        harness: claude\n`;
    expect(rowKeys(renderApp(viewOf(text), agentsTab()))).toEqual(["a", "b"]);
  });

  test("sorts the provider and option set rows, built-ins not yet in the file included", () => {
    const text = `presets:\n  zulu: &zulu\n    K: v\n  mine: &mine [--a]\nagents:\n${claudeAgents("a")}`;
    const view = viewOf(text);
    const providers = rowKeys(renderApp(view, { tab: "providers" }));
    expect(providers.length).toBeGreaterThanOrEqual(4);
    expect(providers).toEqual(asSorted(providers));
    // Un built-in absent du fichier se trie avec les autres ; le preset du fichier « zulu » ferme la liste.
    const absent = view.presets.filter((p) => p.builtIn && !p.inFile && p.kind === "provider").map((p) => p.name);
    expect(absent.length).toBeGreaterThan(0);
    for (const name of absent) expect(providers).toContain(name);
    expect(providers.at(-1)).toBe("zulu");

    const options = rowKeys(renderApp(view, { tab: "options" }));
    expect(options).toEqual(asSorted(options));
    expect(options).toContain("mine");
    expect(options).toContain("claude-max");
  });
});

describe("configure render group by harness", () => {
  const text = `agents:
  multi:
    label: Multi
    engines:
      default:
        harness: opencode
      second:
        harness: claude
  solo:
    label: Solo
    engines:
      default:
        harness: claude
  bare:
    label: Bare
  odd:
    label: Odd
    engines:
      default:
        harness: ""
  twin:
    label: Twin
    engines:
      default:
        harness: codex
      second:
        harness: codex
`;
  const grouped = (selected?: string): UiState => ({ ...agentsTab(selected), groupBy: "harness" });

  test("shows the toggle under the tabs on the Agents tab only, a button and not an input", () => {
    const off = renderApp(viewOf(text), agentsTab());
    expect(off).toMatch(/<button type="button" role="checkbox" aria-checked="false" class="grp" data-action="groupBy">/);
    expect(textOf(off)).toContain("Group by harness");
    expect(off.indexOf('role="tablist"')).toBeLessThan(off.indexOf('role="checkbox"'));
    expect(off).not.toContain("<div class=\"rowgroup\"");

    const on = renderApp(viewOf(text), grouped());
    expect(on).toContain('role="checkbox" aria-checked="true"');
    expect(on).not.toMatch(/<input[^>]*groupBy/);

    expect(renderApp(viewOf(text), { tab: "providers", groupBy: "harness" })).not.toContain('role="checkbox"');
    expect(renderApp(viewOf(text), { tab: "options", groupBy: "harness" })).not.toContain('role="checkbox"');
  });

  test("groups agents by harness, sorted, an agent under each harness it uses, No engine last", () => {
    const groups = sidebarGroups(renderApp(viewOf(text), grouped()));
    const headers = groups.map((g) => g.header);
    expect(headers.at(-1)).toBe("No engine");
    const engineHeaders = headers.slice(0, -1);
    expect(engineHeaders).toEqual(asSorted(engineHeaders));
    expect(engineHeaders).toContain("claude");
    expect(engineHeaders).toContain("opencode");
    expect(engineHeaders).toContain("(none)");

    const under = (header: string): string[] => groups.find((g) => g.header === header)?.keys ?? [];
    expect(under("claude")).toContain("multi");
    expect(under("opencode")).toContain("multi");
    expect(under("claude")).toContain("solo");
    expect(under("opencode")).not.toContain("solo");
    expect(under("(none)")).toEqual(["odd"]);
    expect(under("No engine")).toEqual(["bare"]);
  });

  test("lists an agent once under a harness even when two of its engines use it", () => {
    const groups = sidebarGroups(renderApp(viewOf(text), grouped()));
    expect(groups.find((g) => g.header === "codex")?.keys).toEqual(["twin"]);
  });

  test("tells the rows of an agent apart by their group, only in grouped mode", () => {
    const rowsOf = (html: string, key: string): string[] =>
      [...html.matchAll(/<button type="button" class="row[^"]*"[^>]*data-action="select" data-key="([^"]*)"([^>]*)>/g)].filter((m) => m[1] === key).map((m) => m[0]);
    const on = rowsOf(renderApp(viewOf(text), grouped()), "multi");
    expect(on).toHaveLength(2);
    const groupOf = (row: string): string | undefined => row.match(/data-group="([^"]*)"/)?.[1];
    expect(on.map(groupOf).sort()).toEqual(["claude", "opencode"]);

    const off = rowsOf(renderApp(viewOf(text), agentsTab()), "multi");
    expect(off).toHaveLength(1);
    expect(off[0]).not.toContain("data-group");
    // Les autres rangées (preset) n'en portent pas non plus.
    expect(renderApp(viewOf(text), { tab: "providers" })).not.toContain("data-group");
  });

  test("exposes the displayed keys in sidebar order, one entry per row", () => {
    const view = viewOf(text);
    const ui = grouped();
    expect(shownKeys(view, ui)).toEqual(rowKeys(renderApp(view, ui)));
    expect(shownKeys(view, agentsTab())).toEqual(rowKeys(renderApp(view, agentsTab())));
    expect(shownKeys(view, { tab: "providers" })).toEqual(rowKeys(renderApp(view, { tab: "providers" })));
  });

  test("keeps the default agent order inside a group", () => {
    const sorted = `agents:\n  k1:\n    label: Zulu\n    engines:\n      default:\n        harness: claude\n  k2:\n    label: Alpha\n    engines:\n      default:\n        harness: claude\n`;
    expect(sidebarGroups(renderApp(viewOf(sorted), grouped()))).toEqual([{ header: "claude", keys: ["k2", "k1"] }]);
  });

  test("marks every row of the selected agent, and only them", () => {
    const html = renderApp(viewOf(text), grouped("multi"));
    const current = [...html.matchAll(/<button type="button" class="row sel" aria-current="true" data-action="select" data-key="([^"]*)"/g)].map((m) => m[1]);
    expect(current).toEqual(["multi", "multi"]);
    expect(html.match(/aria-current="true"/g)).toHaveLength(2);
    expect(html.match(/class="row sel"/g)).toHaveLength(2);
  });

  test("shows no harness text on a grouped row but keeps the error dot", () => {
    const broken = `agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        model: 3\n  b:\n    label: B\n    engines:\n      default:\n        harness: claude\n`;
    const view = viewOf(broken);
    expect(view.issues.some((i) => i.agent === "a" && i.severity === "error")).toBe(true);
    const html = renderApp(view, grouped());
    const rows = html.split('<button type="button" class="row').slice(1).filter((r) => r.includes('data-action="select"')).map((r) => '<button type="button" class="row' + r);
    expect(rows).toHaveLength(2);
    const [rowA = "", rowB = ""] = rows;
    expect(rowA).toContain("dot err");
    expect(textOf(rowA)).not.toContain("claude");
    expect(textOf(rowB)).not.toContain("claude");
    expect(rowB).not.toContain('class="meta"');
    // Hors regroupement, la rangée garde son harnais.
    expect(renderApp(view, agentsTab())).toContain(">claude");
  });

  test("selects the first displayed row by default, so the pane and the highlighted row agree", () => {
    const file = `agents:\n  z:\n    label: Zeta\n    engines:\n      default:\n        harness: claude\n  a:\n    label: Alpha\n    engines:\n      default:\n        harness: opencode\n`;
    const view = viewOf(file);
    const plain = renderApp(view, agentsTab());
    // « z » vient en premier dans le fichier, « a » en premier à l'écran.
    expect(rowKeys(plain)[0]).toBe("a");
    expect(plain).toMatch(/class="row sel" aria-current="true" data-action="select" data-key="a"/);
    expect(plain).toContain("<h2>Alpha</h2>");

    const byHarness = renderApp(view, grouped());
    const firstGroup = sidebarGroups(byHarness)[0];
    expect(firstGroup?.header).toBe("claude");
    expect(byHarness).toMatch(/class="row sel" aria-current="true" data-action="select" data-key="z"/);
    expect(byHarness).toContain("<h2>Zeta</h2>");

    // Une sélection disparue retombe sur la première rangée affichée.
    expect(renderApp(view, agentsTab("gone"))).toContain("<h2>Alpha</h2>");
    // Même règle pour les presets : la première rangée triée est celle du panneau.
    const providers = renderApp(viewOf(romain), { tab: "providers" });
    const first = rowKeys(providers)[0] ?? "";
    expect(providers).toContain(`class="row sel" aria-current="true" data-action="select" data-key="${first}"`);
    expect(providers).toContain(`<h2>${first}</h2>`);
  });
});

describe("configure render Used by badges", () => {
  const text = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
  fast: &fast [--effort, low]
agents:
  zed:
    label: Zed
    engines:
      default:
        harness: claude
        options: *fast
        env:
          <<: *ollama
  plain:
    engines:
      default:
        harness: opencode
        env:
          <<: *ollama
  bee:
    label: bee
    engines:
      default:
        harness: codex
        options: *fast
  hostile:
    label: ${JSON.stringify("<b>x</b> & \"y\"")}
    engines:
      default:
        harness: claude
        env:
          <<: *ollama
`;
  const badgesOf = (html: string): { key: string; harness: string; name: string; aria: string }[] => {
    const box = html.slice(html.indexOf('<div class="badges">'));
    return [...box.matchAll(/<button type="button" class="badge" data-action="openAgent" data-key="([^"]*)" data-harness="([^"]*)" aria-label="([^"]*)">(.*?)<\/button>/g)].map((m) => ({
      key: m[1] ?? "",
      harness: m[2] ?? "",
      aria: m[3] ?? "",
      name: m[4] ?? "",
    }));
  };

  test("lists one badge per agent on a provider, sorted by displayed name, with its harness", () => {
    const html = renderApp(viewOf(text), { tab: "providers", selected: "ollama" });
    const badges = badgesOf(html);
    expect(badges.map((b) => b.key).sort()).toEqual(["hostile", "plain", "zed"]);
    const names = badges.map((b) => b.name.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", '"'));
    expect(names).toEqual(asSorted(names));
    const byKey = Object.fromEntries(badges.map((b) => [b.key, b]));
    expect(byKey.zed).toMatchObject({ harness: "claude", name: "Zed", aria: "Open agent Zed" });
    // Sans label, le badge montre la clé.
    expect(byKey.plain).toMatchObject({ harness: "opencode", name: "plain", aria: "Open agent plain" });
    expect(html).not.toContain('data-action="copy"');
  });

  test("escapes the label of a badge, in its text and in its accessible name", () => {
    const html = renderApp(viewOf(text), { tab: "providers", selected: "ollama" });
    expect(html).not.toContain("<b>x</b>");
    const hostile = badgesOf(html).find((b) => b.key === "hostile");
    expect(hostile?.name).toBe("&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
    expect(hostile?.aria).toBe("Open agent &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
  });

  test("sorts the badges by label, not by key", () => {
    const file = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
agents:
  a:
    label: Zed
    engines:
      default:
        harness: claude
        env:
          <<: *ollama
  z:
    label: Abe
    engines:
      default:
        harness: claude
        env:
          <<: *ollama
`;
    const badges = badgesOf(renderApp(viewOf(file), { tab: "providers", selected: "ollama" }));
    expect(badges.map((b) => [b.key, b.name])).toEqual([
      ["z", "Abe"],
      ["a", "Zed"],
    ]);
  });

  test("lists the agents of an option set the same way", () => {
    const badges = badgesOf(renderApp(viewOf(text), { tab: "options", selected: "fast" }));
    expect(badges.map((b) => [b.key, b.harness])).toEqual([
      ["bee", "codex"],
      ["zed", "claude"],
    ]);
  });

  test("says so when no agent uses the preset, with no badge", () => {
    const html = renderApp(viewOf(text), { tab: "providers", selected: "lmstudio" });
    expect(textOf(html)).toContain("Used by");
    expect(textOf(html)).toContain("No agent uses this yet.");
    expect(html).not.toContain('class="badge"');
    expect(html).not.toContain("No engine uses this yet.");
  });
});
