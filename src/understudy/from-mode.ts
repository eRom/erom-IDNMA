import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FromMode } from "../bus/envelope.ts";
import type { ForeignHarness } from "../config/network.ts";
import { dstPrefsDir } from "../paths.ts";

// Flag de chaque harnais qui désactive les demandes de permission (code exécuté le 26/10/2026).
// dst n'en a pas : son mode vient de `DSH_PERMISSION_MODE` (spec §6.5).
const BYPASS_FLAGS: Record<Exclude<ForeignHarness, "dst">, string> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  grok: "--always-approve",
  agy: "--dangerously-skip-permissions",
  opencode: "--auto",
};

const DST_FULL_ACCESS = "danger-full-access";

/**
 * Dernier mode choisi dans dst (`/permission`, Maj+Tab), retenu dans `permission.json` du dossier d'état de la TUI.
 * Au mieux : fichier absent, illisible ou de forme inattendue, pas de préférence.
 */
function readDstRememberedPermission(prefsDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(prefsDir, "permission.json"), "utf8"));
    const permission = (parsed as { permission?: unknown } | null)?.permission;
    return typeof permission === "string" ? permission.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `bypass` si l'agent désactive ses demandes de permission, sinon `prompting`. Codex, Grok, agy et
 * opencode le disent par un flag de leur propre harnais (`argv`). dst, par `DSH_PERMISSION_MODE` dans
 * l'env de l'enfant (`env`), qui l'emporte ; sans cette variable, par le dernier mode retenu par la TUI
 * (`permission.json` dans `prefsDir`). Le mode n'est lu qu'au lancement.
 */
export function inferFromMode(
  harness: ForeignHarness,
  argv: string[],
  env: Record<string, string | undefined> = {},
  prefsDir: string = dstPrefsDir(),
): FromMode {
  if (harness === "dst") {
    // Une variable vide ne compte pas comme épinglée (comme dans dst).
    const pinned = env.DSH_PERMISSION_MODE;
    const mode = pinned !== undefined && pinned !== "" ? pinned : readDstRememberedPermission(prefsDir);
    return mode === DST_FULL_ACCESS ? "bypass" : "prompting";
  }
  return argv.includes(BYPASS_FLAGS[harness]) ? "bypass" : "prompting";
}
