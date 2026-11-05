// Recette manuelle de la page `idnma configure`, dans un vrai Chrome sans tête.
//
// Pourquoi : `app.ts` colle le DOM à `renderApp` ; ses parties pures sont testées par `bun test`
// (tests/configure-page-logic.test.ts), mais focus, clics réels, ⌘S, menus et refus du serveur ne se voient
// que dans un navigateur. Ce script ne fait pas partie de la suite : il lance Chrome.
//
// Usage : bun scripts/configure-smoke.ts
//   CHROME=/chemin/vers/chrome  pour un autre binaire (défaut : Google Chrome de macOS)
//   Code de sortie 0 si tout passe, 1 sinon ; le résumé est la dernière ligne (« N/M passed »).
//
// Ce qu'il fait : pour chaque scénario, un dossier temporaire avec une copie de tests/fixtures/configure/romain.yml
// (ou rien, pour un fichier neuf), `idnma configure --no-open` en sous-processus, une page pilotée par le
// protocole DevTools. Il ne tue que les processus qu'il a lancés, et jamais ~/.idnma.yml n'est touché.
//
// Ce qu'il vérifie :
//   1. parcours : jeton retiré de l'adresse, bande de commande qui suit la clé à chaque frappe, renommage et
//      focus remappé, refus 409 sous le champ, création en ligne (sans prompt), Duplicate, menu Provider au
//      clavier, + Add variable puis renommage, jetons d'options, beforeunload, visibilitychange, Copy, ⌘S,
//      fichier modifié sur le disque (avis avec Reload).
//   2. revue T11, cas A : sur un fichier propre, taper dans un champ puis ⌘S aussitôt enregistre dès le premier ⌘S.
//   3. revue T11, cas B : appui, attente, relâchement sur Save après une frappe : un seul clic enregistre.
//   3 bis. fichier propre : taper dans un champ active Save et Revert, puis un clic réel sur Save enregistre (le geste nominal).
//   4. revue T11, cas C : + Add variable avec un nom existant (engine et preset) est refusé, la valeur reste.
//   5. revue T11, cas D : un menu ouvert se ferme au clic sur Copy.
//   6. fichier neuf : écran « Add your first agent », création d'un agent avec son engine, Revert inactif.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "configure", "romain.yml");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- Pilotage de Chrome ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Page {
  ev<T = unknown>(expression: string): Promise<T>;
  wait(ms: number): Promise<void>;
  insert(text: string): Promise<void>;
  key(key: string): Promise<void>;
  chord(key: string, code: string, modifiers: number): Promise<void>;
  mouse(type: "mousePressed" | "mouseReleased" | "mouseMoved", x: number, y: number): Promise<void>;
  center(selector: string): Promise<[number, number]>;
  active(): Promise<string>;
  errors: string[];
  close(): Promise<void>;
}

const KEY_CODES: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };

async function openPage(debugPort: number, url: string): Promise<Page> {
  const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string; id: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => void (ws.onopen = resolve));
  let next = 0;
  const pending = new Map<number, (message: Json) => void>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Json;
    const id = message.id as number | undefined;
    if (id !== undefined) pending.get(id)?.(message);
    if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify((message.params as Json).exceptionDetails));
    if (message.method === "Runtime.consoleAPICalled" && (message.params as Json).type === "error") errors.push("console.error");
  };
  const send = (method: string, params: Json = {}): Promise<Json> =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1340, height: 900, deviceScaleFactor: 1, mobile: false });

  const page: Page = {
    async ev<T>(expression: string): Promise<T> {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const result = reply.result as Json;
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return (result.result as Json).value as T;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async insert(text) {
      await send("Input.insertText", { text });
    },
    async key(key) {
      const code = KEY_CODES[key] ?? 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, text: key === "Enter" ? "\r" : undefined });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    },
    async chord(key, code, modifiers) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
    },
    async mouse(type, x, y) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    },
    center: (selector) =>
      page.ev<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`),
    active: () => page.ev<string>("document.activeElement?.id || document.activeElement?.dataset?.action || document.activeElement?.tagName"),
    errors,
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => undefined);
    },
  };
  return page;
}

// --- Serveur et scénarios -------------------------------------------------------------------------

interface Context {
  p: Page;
  file: string;
  disk(): string;
}

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, got?: unknown): void {
  total++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  -> ${JSON.stringify(got)}`}`);
}

async function startServer(dir: string): Promise<{ url: string; stop: () => void }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "configure", "--no-open"], { cwd: ROOT, env: { ...process.env, IDNMA_CONFIG_DIR: dir }, stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  let seen = "";
  while (!/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("le serveur s'est arrêté avant d'afficher son adresse");
    seen += new TextDecoder().decode(value);
  }
  const url = seen.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0] as string;
  return { url, stop: () => proc.kill() };
}

async function startChrome(): Promise<{ port: number; stop: () => void }> {
  const profile = mkdtempSync(join(tmpdir(), "idnma-smoke-chrome-"));
  const proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1340,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const reader = proc.stderr.getReader();
  let seen = "";
  while (!/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Chrome ne s'est pas lancé");
    seen += new TextDecoder().decode(value);
  }
  return { port: Number(seen.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]), stop: () => proc.kill() };
}

/** Un scénario : un dossier de config neuf, un serveur, une page ; tout est rendu à la fin. */
async function scenario(debugPort: number, title: string, config: "romain" | "new", run: (c: Context) => Promise<void>): Promise<void> {
  console.log(`\n# ${title}`);
  const dir = mkdtempSync(join(tmpdir(), "idnma-smoke-"));
  const file = join(dir, ".idnma.yml");
  if (config === "romain") copyFileSync(FIXTURE, file);
  else mkdirSync(dir, { recursive: true });
  const server = await startServer(dir);
  const p = await openPage(debugPort, server.url);
  try {
    await p.wait(1500);
    await run({ p, file, disk: () => readFileSync(file, "utf-8") });
    check("no script error on the page", p.errors.length === 0, p.errors);
  } finally {
    await p.close();
    server.stop();
  }
}

const selectLabelEnd = (id: string): string => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.setSelectionRange(el.value.length, el.value.length); })()`;
const selectAll = (id: string): string => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.select(); })()`;
const CMD = 4;

async function main(): Promise<void> {
  const chrome = await startChrome();
  try {
    await scenario(chrome.port, "1. walk through", "romain", async ({ p, disk, file }) => {
      const startText = disk();
      check("token removed from address bar", (await p.ev<string>("location.search")) === "");
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      await p.ev(selectAll("agent:deepseek-flash:key"));
      await p.insert("ds-flash");
      await p.wait(100);
      check("command strip follows Key on input", (await p.ev<string>(`[...document.querySelectorAll('.eng .cmd .key')].map(e=>e.textContent).join(',')`)) === "ds-flash,ds-flash,ds-flash");
      check("copy text follows Key on input", (await p.ev<string>(`document.querySelector('.eng [data-action=copy]').dataset.text`)) === "idnma run ds-flash");
      check("typing writes nothing before the change event, and shows no refusal", disk() === startText && (await p.ev<number>(`document.querySelectorAll(".refusal").length`)) === 0);
      await p.key("Tab");
      await p.wait(500);
      check("rename keeps the selection under the new key", (await p.ev<string>(`document.querySelector('.row.sel')?.dataset.key`)) === "ds-flash");
      check("focus follows the renamed agent", (await p.active()) === "agent:ds-flash:avatar", await p.active());

      await p.ev(selectAll("agent:ds-flash:key"));
      await p.insert("opus");
      await p.key("Tab");
      await p.wait(500);
      check("409 refusal under the Key field", (await p.ev<boolean>(`!!document.getElementById('agent:ds-flash:key').closest('.fld').querySelector('.refusal')`)) === true);
      await p.ev(`document.getElementById('agent:ds-flash:label').focus()`);
      await p.insert("X");
      await p.key("Tab");
      await p.wait(400);
      check("an accepted operation clears the refusal", (await p.ev<number>(`document.querySelectorAll('.refusal').length`)) === 0);

      await p.ev(`document.querySelector('[data-action=addAgent]').click()`);
      await p.wait(200);
      check("add agent opens an inline row, focused", (await p.active()) === "add:key", await p.active());
      await p.insert("zed");
      await p.key("Tab");
      await p.insert("Zed Agent");
      await p.key("Enter");
      await p.wait(600);
      check("new agent selected, with its default engine", (await p.ev<string>(`document.querySelector('.row.sel')?.dataset.key + ':' + document.querySelectorAll('.eng').length`)) === "zed:1");
      await p.ev(`document.querySelector('[data-action=addAgent]').click()`);
      await p.wait(100);
      await p.key("Enter");
      await p.wait(200);
      check("empty name shows a message", (await p.ev<string>(`document.querySelector('.refusal')?.textContent`)) === "Enter a name.");
      await p.key("Escape");
      await p.wait(200);
      check("Escape cancels the row and refocuses its button", (await p.ev<string>(`!document.querySelector('form.addrow') && document.activeElement?.dataset?.action`)) === "addAgent");

      await p.ev(`document.querySelector('.row[data-key="opus"]').click()`);
      await p.wait(200);
      await p.ev(`document.querySelector('[data-action=duplicateAgent]').click()`);
      await p.wait(500);
      check("duplicate selects the copy, label text selected", (await p.ev<boolean>(`document.activeElement.id === 'agent:opus-copy:label' && document.activeElement.selectionEnd === document.activeElement.value.length && document.activeElement.selectionStart === 0`)) === true);

      await p.ev(`document.querySelector('.row[data-key="ds-flash"]').click()`);
      await p.wait(200);
      await p.ev(`document.getElementById('agent:ds-flash:engine:default:provider').click()`);
      await p.wait(100);
      check("menu open, first item focused", (await p.ev<boolean>(`document.activeElement.classList.contains('mi')`)) === true);
      await p.key("ArrowDown");
      check("ArrowDown moves inside the menu", (await p.ev<boolean>(`document.querySelectorAll('.menu .mi')[1] === document.activeElement`)) === true);
      await p.key("Escape");
      await p.wait(150);
      check("Escape closes it and refocuses the trigger", (await p.active()) === "agent:ds-flash:engine:default:provider", await p.active());
      await p.ev(`document.getElementById('agent:ds-flash:engine:default:provider').click()`);
      await p.wait(100);
      await p.ev(`document.querySelector('.menu [data-provider-kind=preset][data-preset=openrouter]').click()`);
      await p.wait(400);
      check("provider changed from the menu", (await p.ev<string>(`document.getElementById('agent:ds-flash:engine:default:provider').getAttribute('aria-label')`)) === "Provider: openrouter");

      await p.ev(`document.querySelector('.eng [data-action=addEnvVar]').click()`);
      await p.wait(150);
      await p.insert("MY_VAR");
      await p.key("Enter");
      await p.wait(500);
      check("new variable: its value takes the focus", (await p.active()) === "agent:ds-flash:engine:default:env:MY_VAR:value", await p.active());
      await p.ev(selectAll("agent:ds-flash:engine:default:env:MY_VAR:name"));
      await p.insert("MY_VAR2");
      await p.key("Tab");
      await p.wait(500);
      check("renamed variable: focus follows", (await p.active()) === "agent:ds-flash:engine:default:env:MY_VAR2:value", await p.active());

      await p.ev(`document.getElementById('agent:ds-flash:engine:opencode:options:1').focus()`);
      await p.insert("--verbose");
      await p.key("Enter");
      await p.wait(500);
      check("option token added: focus on the next empty token", (await p.active()) === "agent:ds-flash:engine:opencode:options:2", await p.active());

      check("beforeunload asks when dirty", (await p.ev<boolean>(`(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()`)) === true);
      await p.ev(`document.querySelector('.win').dataset.marker = 'kept'`);
      await p.ev(`document.dispatchEvent(new Event('visibilitychange'))`);
      await p.wait(400);
      check("visibilitychange on an unchanged state keeps the DOM", (await p.ev<string>(`document.querySelector('.win').dataset.marker`)) === "kept");
      await p.ev(`document.querySelector('.eng [data-action=copy]').click()`);
      await p.wait(300);
      check("Copy gives feedback or a fallback", (await p.ev<boolean>(`document.querySelector('.eng [data-action=copy]').textContent === 'Copied' || !document.querySelector('.notice').hidden`)) === true);

      const before = disk();
      await p.ev(selectLabelEnd("agent:ds-flash:label"));
      await p.insert("!");
      await p.chord("s", "KeyS", CMD);
      await p.wait(800);
      check("Cmd-S writes the file with the field typed just before", disk() !== before && disk().includes("MY_VAR2") && disk().includes("!"));
      check("Save disabled after saving", (await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled`)) === true);

      writeFileSync(file, `${disk()}\n# edited elsewhere\n`);
      await p.ev(selectLabelEnd("agent:ds-flash:avatar"));
      await p.insert("x");
      await p.key("Tab");
      await p.wait(400);
      await p.chord("s", "KeyS", CMD);
      await p.wait(600);
      check("file changed on disk: notice with Reload", (await p.ev<boolean>(`!document.querySelector('.notice').hidden && !!document.querySelector('.notice [data-action=reload]')`)) === true);
      await p.ev(`document.dispatchEvent(new Event('visibilitychange'))`);
      await p.ev(selectLabelEnd("agent:ds-flash:avatar"));
      await p.wait(400);
      check("that notice survives a refresh", (await p.ev<boolean>(`!document.querySelector('.notice').hidden`)) === true);
      await p.ev(`document.querySelector('.notice [data-action=reload]').click()`);
      await p.wait(500);
      check("Reload drops the edits and hides the notice", (await p.ev<boolean>(`document.querySelector('.notice').hidden && document.querySelector('[data-action=save]').disabled`)) === true);
    });

    await scenario(chrome.port, "2. review case A: type in a clean file, then Cmd-S", "romain", async ({ p, disk }) => {
      const original = disk();
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      check("starts clean: Save and Revert disabled", (await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled && document.querySelector('[data-action=revert]').disabled`)) === true);
      await p.ev(selectLabelEnd("agent:deepseek-flash:label"));
      await p.insert(" ZZA");
      await p.chord("s", "KeyS", CMD);
      await p.wait(900);
      check("the first Cmd-S saved the file", disk() !== original && disk().includes("ZZA"));
    });

    await scenario(chrome.port, "3. review case B: press, hold, release on Save after typing", "romain", async ({ p, disk }) => {
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      await p.ev(selectAll("agent:deepseek-flash:avatar"));
      await p.insert("avatarB1");
      await p.key("Tab");
      await p.wait(500);
      const afterFirst = disk();
      await p.ev(selectLabelEnd("agent:deepseek-flash:label"));
      await p.insert(" ZZB");
      const [x, y] = await p.center("[data-action=save]");
      await p.mouse("mouseMoved", x, y);
      await p.mouse("mousePressed", x, y);
      await p.wait(300);
      await p.mouse("mouseReleased", x, y);
      await p.wait(900);
      check("one real click on Save saved the typed field", disk() !== afterFirst && disk().includes("ZZB"));
      // Autre bouton, même piège : Duplicate après une frappe.
      await p.ev(selectLabelEnd("agent:deepseek-flash:label"));
      await p.insert("!");
      const [dx, dy] = await p.center("[data-action=duplicateAgent]");
      await p.mouse("mousePressed", dx, dy);
      await p.wait(300);
      await p.mouse("mouseReleased", dx, dy);
      await p.wait(800);
      check("a click on Duplicate right after typing is not swallowed", (await p.ev<boolean>(`!!document.querySelector('.row[data-key="deepseek-flash-copy"]')`)) === true);
    });

    await scenario(chrome.port, "3 bis. type in a clean file, then click Save", "romain", async ({ p, disk }) => {
      const original = disk();
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      check("starts clean: Save and Revert disabled", (await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled && document.querySelector('[data-action=revert]').disabled`)) === true);
      await p.ev(selectLabelEnd("agent:deepseek-flash:label"));
      await p.insert(" ZZC");
      check("typing enables Save and Revert before any change event", (await p.ev<boolean>(`!document.querySelector('[data-action=save]').disabled && !document.querySelector('[data-action=revert]').disabled`)) === true);
      check("nothing is written yet", disk() === original);
      const [x, y] = await p.center("[data-action=save]");
      await p.mouse("mouseMoved", x, y);
      await p.mouse("mousePressed", x, y);
      await p.wait(200);
      await p.mouse("mouseReleased", x, y);
      await p.wait(900);
      check("one click on Save commits the field and saves it", disk() !== original && disk().includes("ZZC"));
      check("Save is disabled again once saved", (await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled`)) === true);

      // Le chemin par Tab reste valable : le change part au blur, la vue devient sale, rien n'est écrit avant Save.
      const saved = disk();
      await p.ev(selectLabelEnd("agent:deepseek-flash:avatar"));
      await p.insert("q");
      await p.key("Tab");
      await p.wait(500);
      check("the Tab path still works (change sent on blur)", !(await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled`)) && disk() === saved);
    });

    await scenario(chrome.port, "4. review case C: + Add variable on an existing name", "romain", async ({ p }) => {
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      const value = `document.getElementById('agent:deepseek-flash:engine:dst:env:DSH_PERMISSION_MODE:value')`;
      const before = await p.ev<string>(`${value}.value`);
      await p.ev(`document.querySelector('[data-action=addEnvVar][data-engine=dst]').click()`);
      await p.wait(200);
      await p.insert("DSH_PERMISSION_MODE");
      await p.key("Enter");
      await p.wait(500);
      check("engine variable: refused in the form", (await p.ev<string>(`document.querySelector('.refusal')?.textContent`)) === "Variable DSH_PERMISSION_MODE already exists.");
      check("its value is untouched", (await p.ev<string>(`${value}.value`)) === before, await p.ev<string>(`${value}.value`));
      check("the existing field takes the focus", (await p.active()) === "agent:deepseek-flash:engine:dst:env:DSH_PERMISSION_MODE:value", await p.active());
      check("nothing was sent", (await p.ev<boolean>(`document.querySelector('[data-action=save]').disabled`)) === true);

      await p.ev(`document.querySelector('[data-action=tab][data-tab=providers]').click()`);
      await p.wait(200);
      await p.ev(`document.querySelector('.row[data-key="ollama"]').click()`);
      await p.wait(200);
      const token = `document.getElementById('preset:ollama:var:ANTHROPIC_AUTH_TOKEN:value')`;
      const presetBefore = await p.ev<string>(`${token}.value`);
      await p.ev(`document.querySelector('[data-action=addPresetVar]').click()`);
      await p.wait(200);
      await p.insert("ANTHROPIC_AUTH_TOKEN");
      await p.key("Enter");
      await p.wait(500);
      check("preset variable: refused in the form, value untouched", (await p.ev<string>(`document.querySelector('.refusal')?.textContent`)) === "Variable ANTHROPIC_AUTH_TOKEN already exists." && (await p.ev<string>(`${token}.value`)) === presetBefore);
    });

    await scenario(chrome.port, "5. review case D: an open menu closes on a click on Copy", "romain", async ({ p }) => {
      await p.ev(`document.querySelector('.row[data-key="deepseek-flash"]').click()`);
      await p.wait(200);
      await p.ev(`document.getElementById('agent:deepseek-flash:engine:default:provider').click()`);
      await p.wait(200);
      const [x, y] = await p.center(".eng [data-action=copy]");
      await p.mouse("mousePressed", x, y);
      await p.mouse("mouseReleased", x, y);
      await p.wait(400);
      check("the menu is gone", (await p.ev<boolean>(`!document.querySelector('.menu')`)) === true);
    });

    await scenario(chrome.port, "6. new file: first agent", "new", async ({ p, disk, file }) => {
      check("shows the first-agent screen", (await p.ev<string>(`document.querySelector('.first-agent h2')?.textContent`)) === "Add your first agent");
      check("Revert is disabled, Create is enabled", (await p.ev<boolean>(`document.querySelector('[data-action=revert]').disabled && !document.querySelector('[data-action=save]').disabled`)) === true);
      check("its form has a blue primary of its own", (await p.ev<boolean>(`!!document.querySelector('form.addrow.first button.btn.pri')`)) === true);
      await p.ev(`document.querySelector('[data-action=addAgent]').click()`);
      await p.wait(200);
      check("the sidebar button focuses the same form (one form on screen)", (await p.ev<number>(`document.querySelectorAll('form.addrow').length`)) === 1 && (await p.active()) === "add:key");
      await p.insert("luna");
      await p.key("Tab");
      await p.insert("Luna");
      await p.key("Enter");
      await p.wait(700);
      check("the agent exists with its default engine", (await p.ev<string>(`document.querySelector('.row.sel')?.dataset.key + ':' + document.querySelectorAll('.eng').length`)) === "luna:1");
      check("Revert is now enabled", (await p.ev<boolean>(`!document.querySelector('[data-action=revert]').disabled`)) === true);
      await p.chord("s", "KeyS", CMD);
      await p.wait(700);
      check("Create writes the file with the agent and its engine", disk().includes("luna:") && disk().includes("harness: claude"), file);
    });
  } finally {
    chrome.stop();
  }
  console.log(`\n${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

await main();
