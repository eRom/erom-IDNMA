import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { isChildOf, isDescendantOf, peerPidOf } from "../src/bus/peer-pid.ts";
import { daemonPid } from "../src/codex/daemon.ts";

const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });
const REPO = join(import.meta.dir, "..");

let tempDir: string;
let servers: Server[];
let children: ReturnType<typeof Bun.spawn>[];

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/idnma-t-");
  servers = [];
  children = [];
});

afterEach(() => {
  for (const server of servers) server.close();
  for (const child of children) child.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

childTest("peerPidOf returns the connecting process pid", async () => {
  const socketPath = join(tempDir, "p.sock");
  const seen = new Promise<number | undefined>((resolveSeen) => {
    const server = createServer((socket) => {
      resolveSeen(peerPidOf(socket));
      socket.destroy();
    });
    servers.push(server);
    server.listen(socketPath);
  });
  // Le serveur écoute en liaison synchrone sous Bun ; le client se connecte depuis un autre process.
  await Bun.sleep(50);
  const script = `const s = require("node:net").createConnection(${JSON.stringify(socketPath)}); s.on("error", () => {}); setTimeout(() => process.exit(0), 2000);`;
  const client = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
  children.push(client);
  expect(await seen).toBe(client.pid);
});

childTest("isDescendantOf is true for a child of the process, false the other way and for init", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  children.push(child);
  expect(isDescendantOf(child.pid, process.pid)).toBe(true);
  expect(isDescendantOf(process.pid, process.pid)).toBe(true);
  expect(isDescendantOf(process.pid, child.pid)).toBe(false);
  expect(isDescendantOf(1, process.pid)).toBe(false);
});

childTest("isChildOf accepts a direct child only: not a grandchild, not the process itself, never under init", async () => {
  // Un shell qui lance un petit-enfant et donne son pid : la forme d'une commande lancée par le bash de Pi.
  const shell = Bun.spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe" });
  children.push(shell);
  const reader = shell.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const grandchild = Number(new TextDecoder().decode(value).trim());
  expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
  try {
    expect(isChildOf(shell.pid, process.pid)).toBe(true);
    expect(isChildOf(grandchild, process.pid)).toBe(false);
    expect(isDescendantOf(grandchild, process.pid)).toBe(true);
    expect(isChildOf(process.pid, process.pid)).toBe(false);
    expect(isChildOf(shell.pid, 1)).toBe(false);
  } finally {
    process.kill(grandchild);
  }
});

childTest("isDescendantOf refuses launchd as an ancestor, whoever asks", async () => {
  // Un process quelconque descend de launchd : un daemon qui se déclarerait pid 1 admettrait tout le monde.
  expect(isDescendantOf(process.pid, 1)).toBe(false);
  expect(isDescendantOf(process.pid, 0)).toBe(false);
  expect(isDescendantOf(process.pid, -1)).toBe(false);
});

childTest("isDescendantOf refuses a pid that is not positive", async () => {
  expect(isDescendantOf(0, process.pid)).toBe(false);
  expect(isDescendantOf(-4, process.pid)).toBe(false);
});

childTest("isDescendantOf runs /bin/ps, never a ps found in the PATH", async () => {
  const unrelatedAncestor = 4_000_000;
  // Un faux `ps` en tête du PATH du process affirmerait que tout pid descend de `unrelatedAncestor`.
  const fakeBin = join(tempDir, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "ps"), `#!/bin/sh\necho "${process.pid} ${unrelatedAncestor}"\n`);
  chmodSync(join(fakeBin, "ps"), 0o755);
  const script = `import { isDescendantOf } from ${JSON.stringify(join(REPO, "src/bus/peer-pid.ts"))}; console.log(isDescendantOf(${process.pid}, ${unrelatedAncestor}));`;
  const probe = Bun.spawn(["bun", "-e", script], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "ignore" });
  children.push(probe);
  expect((await new Response(probe.stdout).text()).trim()).toBe("false");
});

childTest("isDescendantOf follows a grandchild through an intermediate shell", async () => {
  const shell = Bun.spawn(["sh", "-c", "sleep 30 & wait"]);
  children.push(shell);
  await Bun.sleep(300);
  const listing = Bun.spawnSync(["pgrep", "-P", String(shell.pid)]).stdout.toString().trim();
  const grandchild = Number(listing.split("\n")[0]);
  expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
  try {
    expect(isDescendantOf(grandchild, process.pid)).toBe(true);
    expect(isDescendantOf(grandchild, shell.pid)).toBe(true);
  } finally {
    process.kill(grandchild);
  }
});

childTest("daemonPid returns the pid of the process serving the socket", async () => {
  const socketPath = join(tempDir, "d.sock");
  const script = `import { startFakeCodexDaemon } from ${JSON.stringify(join(REPO, "tests/helpers/fake-codex-daemon.ts"))}; startFakeCodexDaemon(${JSON.stringify(socketPath)}); console.log("ready"); setTimeout(() => process.exit(0), 8000);`;
  const server = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "ignore" });
  children.push(server);
  const reader = server.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  const pid = await daemonPid(socketPath);
  expect(pid).toBe(server.pid);
  expect(pid).not.toBe(process.pid);
});

childTest("daemonPid is undefined when nothing serves the socket", async () => {
  expect(await daemonPid(join(tempDir, "absent.sock"))).toBeUndefined();
});

test("peerPidOf is undefined on a socket without a descriptor", () => {
  const detached = createConnection(join(tempDir, "never.sock"));
  detached.on("error", () => {});
  detached.destroy();
  expect(peerPidOf(detached)).toBeUndefined();
});
