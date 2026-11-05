import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigDocument } from "../src/configure/document.ts";
import { escapeHtml, renderApp, type UiState } from "../src/configure/page/render.ts";
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
    // « Used by » donne la commande qui dépend du preset.
    expect(html).toContain('data-text="idnma run oss20"');
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

  test("selects the first row when nothing valid is selected", () => {
    const html = renderApp(viewOf(romain), agentsTab("does-not-exist"));
    expect(html).toContain('data-action="duplicateAgent" data-agent="opus"');
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
    expect(html).toContain('data-action="copy"');
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
