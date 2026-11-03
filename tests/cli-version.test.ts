import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

// La version annoncée est celle du package.json lu sur disque : celle que release-please incrémente.
const packageVersion = (): string => (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

for (const flag of ["--version", "-v"]) {
  test(`idnma ${flag} prints the package.json version on stdout and exits 0`, () => {
    const result = Bun.spawnSync([process.execPath, CLI, flag], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`idnma ${packageVersion()}\n`);
    expect(result.stderr.toString()).toBe("");
  });
}

test("the version is a semver string, as the release tags expect", () => {
  expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
