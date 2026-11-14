import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Chaque commande courte tourne sous un preload qui interdit les modules lourds (écran et SDK ACP) : AC-19.
const ROOT = join(import.meta.dir, "..");
const PRELOAD = "./tests/helpers/forbid-ui-modules.ts";

let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync("/tmp/idnma-t-");
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

// Un lancement depuis un pane idnma atteindrait un socket de contrôle vivant : ces variables sont retirées.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "IDNMA_NAME" || key === "IDNMA_CONTROL_SOCKET" || key === "IDNMA_CONTROL_TOKEN") continue;
    env[key] = value;
  }
  env.IDNMA_CONFIG_DIR = configDir;
  return env;
}

for (const argv of [["peer", "list", "--help"], ["peer", "send", "--help"], ["read", "--help"], ["hook", "--help"], ["run", "--help"]]) {
  test(`idnma ${argv.join(" ")} never loads the screen or the ACP SDK`, () => {
    const out = Bun.spawnSync(["bun", "--preload", PRELOAD, "src/cli.ts", ...argv], { cwd: ROOT, env: cleanEnv() });
    expect(out.exitCode).toBe(0);
    expect(out.stderr.toString()).not.toContain("forbidden module");
  });
}

for (const name of ["@opentui/core", "@agentclientprotocol/sdk"]) {
  test(`the preload does catch an import of ${name}`, () => {
    const out = Bun.spawnSync(["bun", "--preload", PRELOAD, "-e", `await import("${name}")`], { cwd: ROOT, env: cleanEnv() });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr.toString()).toContain("forbidden module");
    // Le chemin résolu du paquet lui-même, pas un sous-module interne.
    expect(out.stderr.toString()).toContain(`node_modules/${name}`);
  });
}
