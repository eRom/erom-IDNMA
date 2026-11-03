import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 20_000 });
const NODE = join(import.meta.dir, "helpers", "codex-understudy-node.ts");
const THREAD_A = "01a179b5-b063-74a3-8b58-1ef7941809f1";
const THREAD_B = "02b280c6-c174-75b4-9c69-2f0852a1a0f2";

let root: string;

beforeEach(() => {
  root = mkdtempSync("/tmp/idnma-loop-");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface NodeReport {
  name: string;
  turnStarts: number;
}

childTest("two Codex understudies do not answer each other's answers in a loop", async () => {
  // Registre commun, dossiers de test, environnement purgé des variables de la doublure.
  const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, CODEX_THREAD_ID: _d, ...cleanEnv } = process.env;
  const env = {
    ...cleanEnv,
    IDNMA_CLAUDE_DIR: join(root, "sessions"),
    IDNMA_SOCKETS_DIR: join(root, "socks"),
    IDNMA_CONFIG_DIR: join(root, "config"),
  };
  mkdirSync(env.IDNMA_CLAUDE_DIR, { recursive: true });
  const spawnNode = (name: string, thread: string, writeTo: string, durationMs: number) =>
    Bun.spawn(["bun", NODE, name, join(root, name), thread, writeTo, String(durationMs)], { env, stdout: "pipe", stderr: "inherit" });

  const b = spawnNode("codex-b", THREAD_B, "-", 3500);
  await Bun.sleep(800);
  // A écrit une fois à B ; chacun garde 2 s pour se répondre, s'il le voulait.
  const a = spawnNode("codex-a", THREAD_A, "codex-b", 2000);
  const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
  const reportA = JSON.parse(outA.trim().split("\n").pop()!) as NodeReport;
  const reportB = JSON.parse(outB.trim().split("\n").pop()!) as NodeReport;

  // B ouvre un tour pour le message de A ; A ouvre un tour pour la réponse de B, sans renvoi.
  expect(reportB.turnStarts).toBe(1);
  expect(reportA.turnStarts).toBeLessThanOrEqual(1);
});
