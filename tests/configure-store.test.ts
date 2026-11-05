import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, saveConfig, textHash } from "../src/configure/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Un dossier laissé en lecture seule par un test ne se nettoie pas.
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync("/tmp/idnma-t-");
  tempDirs.push(dir);
  return dir;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("configure store", () => {
  test("reads the text and hashes it, and a missing file reads as absent", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    expect(readConfig(path)).toEqual({ text: undefined, hash: "absent" });
    writeFileSync(path, "agents: {}\n");
    expect(readConfig(path)).toEqual({ text: "agents: {}\n", hash: textHash("agents: {}\n") });
    expect(textHash("a")).not.toBe(textHash("b"));
    expect(textHash(undefined)).toBe("absent");
  });

  test("writes atomically and keeps the mode", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o600);

    const result = saveConfig(path, "new\n", readConfig(path).hash);
    expect(result).toEqual({ kind: "written", hash: textHash("new\n") });
    expect(readFileSync(path, "utf-8")).toBe("new\n");
    expect(modeOf(path)).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes(".idnma-tmp-"))).toEqual([]);

    const fresh = join(dir, "fresh.yml");
    expect(saveConfig(fresh, "created\n", "absent")).toEqual({ kind: "written", hash: textHash("created\n") });
    expect(readFileSync(fresh, "utf-8")).toBe("created\n");
    expect(modeOf(fresh)).toBe(0o644);
  });

  test("refuses when the file changed on disk", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    writeFileSync(path, "old\n");
    const { hash } = readConfig(path);
    writeFileSync(path, "edited by hand\n");

    expect(saveConfig(path, "mine\n", hash)).toEqual({ kind: "changed-on-disk" });
    expect(readFileSync(path, "utf-8")).toBe("edited by hand\n");
    expect(readdirSync(dir)).toEqual([".idnma.yml"]);
  });

  test("refuses when the file was deleted on disk", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    writeFileSync(path, "old\n");
    const { hash } = readConfig(path);
    rmSync(path);

    expect(saveConfig(path, "mine\n", hash)).toEqual({ kind: "changed-on-disk" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses when a new file appeared", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    const { hash } = readConfig(path);
    expect(hash).toBe("absent");
    writeFileSync(path, "appeared\n");

    expect(saveConfig(path, "mine\n", hash)).toEqual({ kind: "changed-on-disk" });
    expect(readFileSync(path, "utf-8")).toBe("appeared\n");
  });

  test("reports a failed write without leaving a partial file", () => {
    const dir = tempDir();
    const path = join(dir, ".idnma.yml");
    writeFileSync(path, "old\n");
    const { hash } = readConfig(path);
    chmodSync(dir, 0o500);

    const result = saveConfig(path, "SECRET-CONTENT\n", hash);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.message).toContain(path);
    expect(result.message).toContain("EACCES");
    expect(result.message).not.toContain("SECRET-CONTENT");
    expect(readFileSync(path, "utf-8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual([".idnma.yml"]);

    // Même refus pour un fichier neuf dans un dossier fermé.
    const fresh = saveConfig(join(dir, "fresh.yml"), "x\n", "absent");
    expect(fresh.kind).toBe("failed");
    expect(readdirSync(dir)).toEqual([".idnma.yml"]);
  });
});
