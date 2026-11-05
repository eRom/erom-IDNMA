import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configureCommand, openInBrowser } from "../src/configure/command-line.ts";
import { startConfigureServer, type ConfigureServer } from "../src/configure/server.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "configure", "romain.yml");

let dir: string;
let previousConfigDir: string | undefined;
let started: ConfigureServer[];

beforeEach(() => {
  previousConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = dir;
  copyFileSync(FIXTURE, join(dir, ".idnma.yml"));
  started = [];
});

afterEach(() => {
  for (const server of started) server.stop();
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
});

/** Le démarrage réel, mais le serveur est gardé pour que le test puisse l'arrêter. */
function start(o: Parameters<typeof startConfigureServer>[0]): ConfigureServer {
  const server = startConfigureServer(o);
  started.push(server);
  return server;
}

/** Capture ce que la commande écrit sur stderr, sans le laisser passer. */
function captureStderr(): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("configure command", () => {
  test("prints the help and exits 0 on --help", async () => {
    const out: string[] = [];
    const code = await configureCommand(["--help"], { write: (text) => out.push(text), start: () => assertNotStarted() });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Usage : idnma configure [--no-open]");
  });

  test("exits 2 on an unknown argument, without starting a server", async () => {
    const stderr = captureStderr();
    try {
      const code = await configureCommand(["--bogus"], { start: () => assertNotStarted(), open: () => assertNotStarted() });
      expect(code).toBe(2);
      expect(stderr.text()).toContain("idnma configure : argument inconnu « --bogus »");
      expect(stderr.text()).toContain("Usage : idnma configure [--no-open]");
    } finally {
      stderr.restore();
    }
  });

  test("does not open the browser with --no-open", async () => {
    const opened: string[] = [];
    const out: string[] = [];
    const running = configureCommand(["--no-open"], { start, open: (url) => (opened.push(url), true), write: (text) => out.push(text) });
    await Bun.sleep(50);
    started[0]?.stop();
    expect(await running).toBe(0);
    expect(opened).toEqual([]);
    expect(out.join("")).toBe(`idnma configure : ${started[0]?.url}\nCtrl-C pour arrêter ; s'arrête seul quand la page est fermée.\n`);
  });

  test("opens the printed url in the browser by default", async () => {
    const opened: string[] = [];
    const running = configureCommand([], { start, open: (url) => (opened.push(url), true), write: () => {} });
    await Bun.sleep(50);
    const url = started[0]?.url;
    started[0]?.stop();
    expect(await running).toBe(0);
    expect(opened).toEqual([url!]);
  });

  test("prints the url when the browser cannot be opened", async () => {
    const out: string[] = [];
    const running = configureCommand([], { start, open: () => false, write: (text) => out.push(text) });
    await Bun.sleep(50);
    const server = started[0]!;
    expect(out.join("")).toBe(
      `idnma configure : ${server.url}\nCtrl-C pour arrêter ; s'arrête seul quand la page est fermée.\nOuvre cette adresse dans ton navigateur.\n`,
    );
    // Le serveur tourne : l'adresse imprimée répond.
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    server.stop();
    expect(await running).toBe(0);
  });

  test("serves the file at networkPath()", async () => {
    const running = configureCommand(["--no-open"], { start, write: () => {} });
    await Bun.sleep(50);
    const server = started[0]!;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { "x-idnma-token": server.token } });
    const body = (await response.json()) as { view: { path: string } };
    expect(body.view.path).toBe(join(dir, ".idnma.yml"));
    server.stop();
    await running;
  });

  test("stops on SIGINT and exits 0", async () => {
    const running = configureCommand(["--no-open"], { start, write: () => {} });
    await Bun.sleep(50);
    const server = started[0]!;
    process.emit("SIGINT");
    expect(await running).toBe(0);
    await server.done;
    await expect(fetch(server.url)).rejects.toThrow();
  });

  test("reports an unreadable file in French and exits 1", async () => {
    // Un dossier à la place du fichier : la lecture échoue en EISDIR.
    rmSync(join(dir, ".idnma.yml"));
    mkdirSync(join(dir, ".idnma.yml"));
    const stderr = captureStderr();
    try {
      const code = await configureCommand(["--no-open"], { write: () => {} });
      expect(code).toBe(1);
      expect(stderr.text()).toBe(`idnma configure : impossible de lire ${join(dir, ".idnma.yml")} (EISDIR).\n`);
    } finally {
      stderr.restore();
    }
  });
});

describe("openInBrowser", () => {
  test("answers false, without throwing, when the opener binary is missing", () => {
    expect(openInBrowser("http://127.0.0.1:1/", "idnma-no-such-opener")).toBe(false);
  });

  test("answers true when the opener starts, without ever opening a real browser", () => {
    // `Bun.spawn` est remplacé : le test ne doit pas ouvrir de fenêtre sur la machine qui le lance.
    const calls: unknown[][] = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
      return {} as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);
    try {
      expect(openInBrowser("http://127.0.0.1:1/")).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const [cmd, options] = calls[0] as [string[], { stdout: string; stderr: string }];
    expect(cmd[0]).toBe(process.platform === "darwin" ? "open" : "xdg-open");
    expect(cmd[1]).toBe("http://127.0.0.1:1/");
    expect(options).toMatchObject({ stdout: "ignore", stderr: "ignore" });
  });
});

function assertNotStarted(): never {
  throw new Error("the server must not start");
}
