import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, logEvent } from "../src/log.ts";

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
});

test("errorMessage keeps an Error message and falls back to an English technical string", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage("not an error")).toBe("unknown error");
  expect(errorMessage(undefined)).toBe("unknown error");
});

test("logEvent appends one timestamped JSON line under the config directory", () => {
  logEvent("probe", { a: 1 });
  logEvent("probe", { a: 2 });
  const lines = readFileSync(join(dir, "logs", "idnma.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines.map((line) => line.a)).toEqual([1, 2]);
  expect(lines.every((line) => line.event === "probe" && typeof line.ts === "string")).toBe(true);
});
