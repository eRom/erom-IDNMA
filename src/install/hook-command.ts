import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * La commande que les harnais exécutent pour un hook : le bun qui lance `idnma install` et le `src/cli.ts`
 * de ce checkout, en chemin réel. Les hooks installés pointent donc vers le checkout qui a installé :
 * lancer `idnma install` depuis le checkout lié par `bun link`, jamais depuis un worktree jetable.
 */
export function hookCommand(): { bun: string; cli: string } {
  return { bun: process.execPath, cli: realpathSync(fileURLToPath(new URL("../cli.ts", import.meta.url))) };
}
