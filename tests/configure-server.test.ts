import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_FILE_TEMPLATE } from "../src/configure/builtins.ts";
import { startConfigureServer } from "../src/configure/server.ts";
import type { ConfigView, EditOp } from "../src/configure/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "configure", "romain.yml");
const tempDirs: string[] = [];
const servers: Array<{ stop(): void }> = [];
const savedEnv = process.env["OPENROUTER" + "_API_KEY"];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env["OPENROUTER" + "_API_KEY"];
  else process.env["OPENROUTER" + "_API_KEY"] = savedEnv;
});

function tempDir(): string {
  const dir = mkdtempSync("/tmp/idnma-t-");
  tempDirs.push(dir);
  return dir;
}

/** Copie de la fixture dans un dossier temporaire, ou fichier au contenu donné. */
function configFile(content?: string): string {
  const path = join(tempDir(), ".idnma.yml");
  if (content === undefined) copyFileSync(FIXTURE, path);
  else writeFileSync(path, content);
  return path;
}

function start(path: string, options: { idleMs?: number; token?: string } = {}) {
  const server = startConfigureServer({ path, ...options });
  servers.push(server);
  return server;
}

type Started = ReturnType<typeof start>;

/** Appel de l'API avec le jeton, la méthode et le corps JSON ; `headers` passe après les défauts. */
function call(server: Started, route: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-idnma-token": server.token, ...init.headers };
  const method = init.method ?? "GET";
  if (method === "POST") headers["content-type"] ??= "application/json";
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function view(response: Response): Promise<ConfigView> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { view: ConfigView }).view;
}

const renameEngine: EditOp = { op: "renameEngine", agent: "kimi", engine: "opencode", newName: "renamed" };

describe("configure server", () => {
  test("serves the page without data", async () => {
    const server = start(configFile());
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const chunk = html.match(/\/chunk-[\w-]+\.js/)?.[0];
    expect(chunk).toBeDefined();
    expect(html).toMatch(/\/chunk-[\w-]+\.css/);
    expect(html).not.toContain("opus");
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);

    const script = await fetch(`http://127.0.0.1:${server.port}${chunk}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  test("guards the api", async () => {
    const path = configFile();
    const before = readFileSync(path, "utf-8");
    const server = start(path);
    const base = `http://127.0.0.1:${server.port}`;

    // Sans jeton, avec un mauvais jeton.
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect((await call(server, "/api/state", { headers: { "x-idnma-token": "wrong" } })).status).toBe(403);
    // Le jeton en paramètre n'ouvre que le flux, pas le JSON.
    expect((await fetch(`${base}/api/state?token=${server.token}`)).status).toBe(403);
    // Hôte étranger.
    expect((await call(server, "/api/state", { headers: { host: "evil.test" } })).status).toBe(403);
    expect((await call(server, "/api/state", { headers: { host: `evil.test:${server.port}` } })).status).toBe(403);
    // Origine étrangère sur une route modifiante.
    const foreign = await call(server, "/api/op", { method: "POST", body: { op: renameEngine }, headers: { origin: "http://evil.test" } });
    expect(foreign.status).toBe(403);
    // Corps non JSON.
    const plain = await call(server, "/api/op", { method: "POST", body: { op: renameEngine }, headers: { "content-type": "text/plain" } });
    expect(plain.status).toBe(415);
    // Le flux demande aussi le jeton.
    expect((await fetch(`${base}/api/events`)).status).toBe(403);
    expect((await fetch(`${base}/api/events?token=wrong`)).status).toBe(403);

    expect(readFileSync(path, "utf-8")).toBe(before);
    // Rien de ce qui précède n'a modifié l'état : la même vue reste propre.
    expect((await view(await call(server, "/api/state"))).dirty).toBe(false);
  });

  test("accepts localhost and a same-origin request", async () => {
    const server = start(configFile());
    const origin = `http://localhost:${server.port}`;
    const ok = await call(server, "/api/state", { headers: { host: `localhost:${server.port}`, origin } });
    expect(ok.status).toBe(200);
  });

  test("applies an op and saves", async () => {
    const path = configFile();
    const server = start(path);
    const before = readFileSync(path, "utf-8");

    const edited = await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));
    expect(edited.dirty).toBe(true);
    expect(edited.agents.find((agent) => agent.key === "kimi")?.engines.map((engine) => engine.name)).toContain("renamed");
    expect(readFileSync(path, "utf-8")).toBe(before);

    const saved = await view(await call(server, "/api/save", { method: "POST" }));
    expect(saved.dirty).toBe(false);
    const written = readFileSync(path, "utf-8");
    expect(written).not.toBe(before);
    expect(before).not.toContain("renamed:");
    expect(written).toContain("renamed:");
  });

  test("save without changes writes nothing", async () => {
    const path = configFile("agents:\r\n  a:\r\n    label: A\r\n    engines:\r\n      default:\r\n        harness: claude\r\n");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, old, old);
    const before = readFileSync(path, "utf-8");
    const server = start(path);

    const state = await view(await call(server, "/api/state"));
    expect(state.dirty).toBe(false);
    const saved = await view(await call(server, "/api/save", { method: "POST" }));
    expect(saved.dirty).toBe(false);
    expect(statSync(path).mtimeMs).toBe(old.getTime());
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("saves a file that still has errors", async () => {
    const path = configFile();
    const server = start(path);
    const emptyLabel: EditOp = { op: "setAgentField", key: "opus", field: "label", value: "" };

    const edited = await view(await call(server, "/api/op", { method: "POST", body: { op: emptyLabel } }));
    expect(edited.issues.length).toBeGreaterThan(0);
    const saved = await view(await call(server, "/api/save", { method: "POST" }));
    expect(saved.dirty).toBe(false);
    expect(saved.issues.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf-8")).not.toContain("label: Opus");
  });

  test("refuses a stale save and reloads the manual edit", async () => {
    const path = configFile();
    const server = start(path);
    await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));

    const manual = "agents:\n  manual:\n    label: Manual\n    engines:\n      default:\n        harness: claude\n";
    writeFileSync(path, manual);
    const response = await call(server, "/api/save", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ changedOnDisk: true });
    expect(readFileSync(path, "utf-8")).toBe(manual);

    const reloaded = await view(await call(server, "/api/reload", { method: "POST" }));
    expect(reloaded.dirty).toBe(false);
    expect(reloaded.agents.map((agent) => agent.key)).toEqual(["manual"]);
    // Après le rechargement, la nouvelle base permet de sauver sur la version écrite à la main.
    await view(await call(server, "/api/op", { method: "POST", body: { op: { op: "setAgentField", key: "manual", field: "label", value: "Done" } } }));
    expect((await view(await call(server, "/api/save", { method: "POST" }))).dirty).toBe(false);
    expect(readFileSync(path, "utf-8")).toContain("label: Done");
  });

  test("reverts to the last read or saved text", async () => {
    const path = configFile();
    const server = start(path);
    await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));

    const reverted = await view(await call(server, "/api/revert", { method: "POST" }));
    expect(reverted.dirty).toBe(false);
    expect(reverted.agents.find((agent) => agent.key === "kimi")?.engines.map((engine) => engine.name)).not.toContain("renamed");

    // Après un Save, Revert revient au texte sauvé, pas à la lecture initiale.
    await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));
    await view(await call(server, "/api/save", { method: "POST" }));
    await view(await call(server, "/api/op", { method: "POST", body: { op: { op: "renameEngine", agent: "kimi", engine: "renamed", newName: "again" } } }));
    const afterSave = await view(await call(server, "/api/revert", { method: "POST" }));
    expect(afterSave.agents.find((agent) => agent.key === "kimi")?.engines.map((engine) => engine.name)).toContain("renamed");
  });

  test("never sends environment values", async () => {
    const sentinel = ["sentinel", "7f3a"].join("-");
    process.env["OPENROUTER" + "_API_KEY"] = sentinel;
    const server = start(configFile());
    const base = `http://127.0.0.1:${server.port}`;

    const page = await (await fetch(`${base}/`)).text();
    const chunks = [...page.matchAll(/\/chunk-[\w-]+\.(?:js|css)/g)].map((match) => match[0]);
    const bodies = [page];
    for (const chunk of chunks) bodies.push(await (await fetch(`${base}${chunk}`)).text());
    for (const response of [
      await call(server, "/api/state"),
      await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }),
      await call(server, "/api/save", { method: "POST" }),
      await call(server, "/api/revert", { method: "POST" }),
      await call(server, "/api/reload", { method: "POST" }),
    ]) {
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }
    for (const body of bodies) expect(body).not.toContain(sentinel);
  });

  test("serves the parse-error view", async () => {
    const path = configFile("agents:\n  a: [\n");
    const server = start(path);

    const state = await view(await call(server, "/api/state"));
    expect(state.parseError).toBeDefined();
    expect(state.dirty).toBe(false);
    const response = await call(server, "/api/op", { method: "POST", body: { op: renameEngine } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { refused: string }).refused).toBe("Fix the syntax error first.");
    expect(readFileSync(path, "utf-8")).toBe("agents:\n  a: [\n");
  });

  test("refuses an operation the document rejects", async () => {
    const path = configFile();
    const before = readFileSync(path, "utf-8");
    const server = start(path);

    const response = await call(server, "/api/op", { method: "POST", body: { op: { op: "deleteAgent", key: "nobody" } } });
    expect(response.status).toBe(409);
    expect(typeof ((await response.json()) as { refused: string }).refused).toBe("string");
    expect((await view(await call(server, "/api/state"))).dirty).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("rejects a malformed operation body", async () => {
    const path = configFile();
    const before = readFileSync(path, "utf-8");
    const server = start(path);
    const bodies: unknown[] = [
      {},
      { op: null },
      { op: { op: "nothing" } },
      { op: { op: "addEngine", agent: "opus", name: "x", harness: "emacs" } },
      { op: { op: "renameEngine", agent: "kimi", engine: "opencode" } },
      { op: { op: "renameEngine", agent: "kimi", engine: "opencode", newName: "x", extra: 1 } },
      { op: { op: "unlink", path: [{}] } },
    ];
    for (const body of bodies) {
      const response = await call(server, "/api/op", { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ refused: "Invalid operation." });
    }
    const broken = await fetch(`http://127.0.0.1:${server.port}/api/op`, {
      method: "POST",
      headers: { "x-idnma-token": server.token, "content-type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    expect((await view(await call(server, "/api/state"))).dirty).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("answers an unexpected failure with a generic error and keeps serving", async () => {
    // Le fichier est devenu un dossier : la relecture échoue en EISDIR, une erreur qui n'est pas un refus d'opération.
    const path = configFile();
    const server = start(path);
    await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));
    rmSync(path);
    mkdirSync(path);
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let response: Response;
    try {
      response = await call(server, "/api/reload", { method: "POST" });
    } finally {
      console.error = originalError;
    }
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ failed: "Internal error." });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("/api/reload");
    expect(logged[0]).not.toContain("Opus");

    // Le serveur répond encore, et l'édition en cours n'a pas bougé.
    const state = await view(await call(server, "/api/state"));
    expect(state.dirty).toBe(true);
    expect(state.agents.some((agent) => agent.key === "opus")).toBe(true);
  });

  test("reports a failed write and keeps the edit", async () => {
    const path = configFile();
    const before = readFileSync(path, "utf-8");
    const server = start(path);
    await view(await call(server, "/api/op", { method: "POST", body: { op: renameEngine } }));
    // Dossier en lecture seule : le temporaire ne peut pas être créé.
    const dir = join(path, "..");
    chmodSync(dir, 0o500);
    try {
      const response = await call(server, "/api/save", { method: "POST" });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { failed: string };
      expect(body.failed).toContain(path);
      expect(body.failed).toContain("EACCES");
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(path, "utf-8")).toBe(before);
    // L'édition reste en mémoire : un nouveau Save réussit une fois le dossier rouvert.
    expect((await view(await call(server, "/api/state"))).dirty).toBe(true);
    expect((await view(await call(server, "/api/save", { method: "POST" }))).dirty).toBe(false);
  });

  test("creates a new file on save", async () => {
    const path = join(tempDir(), ".idnma.yml");
    const server = start(path);

    const state = await view(await call(server, "/api/state"));
    expect(state.isNew).toBe(true);
    const saved = await view(await call(server, "/api/save", { method: "POST" }));
    expect(saved.isNew).toBe(false);
    expect(saved.dirty).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(NEW_FILE_TEMPLATE);
  });

  test("does not touch the disk for a new file until Save", async () => {
    const path = join(tempDir(), ".idnma.yml");
    const server = start(path);
    await view(await call(server, "/api/op", { method: "POST", body: { op: { op: "addAgent", key: "fresh", label: "Fresh" } } }));
    expect(() => statSync(path)).toThrow();
  });

  test("stops when the last page leaves", async () => {
    const server = start(configFile(), { idleMs: 200 });
    const started = Date.now();
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${server.port}/api/events?token=${server.token}`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toStartWith(":");

    controller.abort();
    await Promise.race([server.done, Bun.sleep(1000).then(() => Promise.reject(new Error("the server kept running")))]);
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
  });

  test("never stops before the first page connects, and a returning page keeps it alive", async () => {
    const server = start(configFile(), { idleMs: 100 });
    let stopped = false;
    void server.done.then(() => {
      stopped = true;
    });
    await Bun.sleep(400);
    expect(stopped).toBe(false);
    expect((await call(server, "/api/state")).status).toBe(200);

    const first = new AbortController();
    await fetch(`http://127.0.0.1:${server.port}/api/events?token=${server.token}`, { signal: first.signal });
    first.abort();
    // La page revient avant la fin du délai : le minuteur est annulé.
    await Bun.sleep(30);
    const second = new AbortController();
    await fetch(`http://127.0.0.1:${server.port}/api/events?token=${server.token}`, { signal: second.signal });
    await Bun.sleep(400);
    expect(stopped).toBe(false);

    second.abort();
    await Promise.race([server.done, Bun.sleep(1000).then(() => Promise.reject(new Error("the server kept running")))]);
    expect(stopped).toBe(true);
  });

  test("stop() ends the server and resolves done", async () => {
    const server = start(configFile());
    server.stop();
    await Promise.race([server.done, Bun.sleep(1000).then(() => Promise.reject(new Error("done never resolved")))]);
    await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
    server.stop();
  });

  test("uses the token it is given", async () => {
    const server = start(configFile(), { token: "fixed-token" });
    expect(server.token).toBe("fixed-token");
    expect(server.url).toContain("?token=fixed-token");
    expect((await call(server, "/api/state")).status).toBe(200);
  });

  test("answers an unknown route with 404", async () => {
    const server = start(configFile());
    expect((await call(server, "/api/nothing")).status).toBe(404);
    expect((await call(server, "/api/state", { method: "POST" })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${server.port}/elsewhere`)).status).toBe(404);
  });
});
