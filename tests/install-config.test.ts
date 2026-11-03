import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install-config.ts");
const EXAMPLE = join(import.meta.dir, "..", ".idnma.example.yml");

let configDirPath: string;

beforeEach(() => {
  configDirPath = mkdtempSync("/tmp/idnma-t-");
});

afterEach(() => {
  rmSync(configDirPath, { recursive: true, force: true });
});

async function runScript(): Promise<{ code: number; out: string; err: string }> {
  // Environnement purgé des variables de pair : le sous-process ne doit rien hériter du pane courant.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("IDNMA_")) continue;
    env[key] = value;
  }
  env.IDNMA_CONFIG_DIR = configDirPath;
  const proc = Bun.spawn(["bun", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test("creates .idnma.yml identical to the example and never creates secrets.yml", async () => {
  const result = await runScript();
  expect(result.code).toBe(0);
  expect(readFileSync(join(configDirPath, ".idnma.yml"), "utf-8")).toBe(readFileSync(EXAMPLE, "utf-8"));
  expect(existsSync(join(configDirPath, "secrets.yml"))).toBe(false);
});

test("a second run touches nothing and says so", async () => {
  await runScript();
  const networkPath = join(configDirPath, ".idnma.yml");
  writeFileSync(networkPath, "agents: {}\n");

  const result = await runScript();
  expect(result.code).toBe(0);
  expect(result.out).toContain("déjà présent, rien touché");
  expect(readFileSync(networkPath, "utf-8")).toBe("agents: {}\n");
});

test("an existing secrets.yml stays byte for byte untouched", async () => {
  // Le fichier est écrit par stringify : jamais de ligne `CLÉ: valeur` tapée à la main.
  const secretsPath = join(configDirPath, "secrets.yml");
  const content = stringify({ env: { SOME_KEY: "valeur-temoin" } });
  writeFileSync(secretsPath, content);
  chmodSync(secretsPath, 0o600);

  const result = await runScript();
  expect(result.code).toBe(0);
  expect(readFileSync(secretsPath, "utf-8")).toBe(content);
  expect(result.out + result.err).not.toContain("valeur-temoin");
});
