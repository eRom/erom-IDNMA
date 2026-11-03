import { afterEach, beforeEach, expect, test } from "bun:test";
import { peerSocketPath, socketsDir } from "../src/paths.ts";

// Règle du dossier des sockets, relevée dans le binaire de Claude Code 2.1.317 (macOS et Linux).
const ENV_KEYS = ["IDNMA_SOCKETS_DIR", "XDG_RUNTIME_DIR", "CLAUDE_CODE_TMPDIR", "TMPDIR"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("IDNMA_SOCKETS_DIR overrides every other source", () => {
  process.env.IDNMA_SOCKETS_DIR = "/tmp/idnma-forced";
  process.env.XDG_RUNTIME_DIR = "/run/user/42";
  expect(socketsDir()).toBe("/tmp/idnma-forced");
});

test("XDG_RUNTIME_DIR comes first, before CLAUDE_CODE_TMPDIR", () => {
  process.env.XDG_RUNTIME_DIR = "/run/user/42";
  process.env.CLAUDE_CODE_TMPDIR = "/tmp/cc-tmp";
  expect(socketsDir()).toBe("/run/user/42/cc-socks");
});

test("an empty XDG_RUNTIME_DIR counts as absent and CLAUDE_CODE_TMPDIR takes over", () => {
  process.env.XDG_RUNTIME_DIR = "";
  process.env.CLAUDE_CODE_TMPDIR = "/tmp/cc-tmp";
  expect(socketsDir()).toBe("/tmp/cc-tmp/cc-socks");
});

test("without either variable: /tmp on macOS, the TMPDIR-driven temporary directory on Linux", () => {
  process.env.TMPDIR = "/tmp/idnma-tmpdir";
  expect(socketsDir()).toBe(process.platform === "darwin" ? "/tmp/cc-socks" : "/tmp/idnma-tmpdir/cc-socks");
});

test("peerSocketPath keeps a 103-byte path and falls back to /tmp/cc-socks-<uid> past it", () => {
  const pid = 4242;
  const suffix = `/cc-socks/${pid}.sock`;
  const uid = process.getuid?.() ?? 0;
  // Chemin d'exactement 103 octets : gardé.
  process.env.XDG_RUNTIME_DIR = `/${"x".repeat(103 - suffix.length - 1)}`;
  expect(Buffer.byteLength(peerSocketPath(pid))).toBe(103);
  expect(peerSocketPath(pid)).toBe(`${process.env.XDG_RUNTIME_DIR}${suffix}`);
  // Un octet de plus : repli.
  process.env.XDG_RUNTIME_DIR = `/${"x".repeat(103 - suffix.length)}`;
  expect(peerSocketPath(pid)).toBe(`/tmp/cc-socks-${uid}/${pid}.sock`);
});
