import { networkPath } from "../paths.ts";
import { startConfigureServer } from "./server.ts";

/** Aide de `idnma configure`. */
export const CONFIGURE_HELP = `Usage : idnma configure [--no-open]

Ouvre dans le navigateur l'éditeur de ~/.idnma.yml (agents, moteurs, presets). Le serveur n'écoute que sur
cette machine ; il s'arrête seul quand la page est fermée, ou sur Ctrl-C. Rien n'est écrit avant « Save ».

  --no-open   n'ouvre pas le navigateur : l'adresse est seulement affichée
`;

/**
 * Ouvre l'adresse dans le navigateur par défaut (`open` sur macOS, `xdg-open` ailleurs) ; `false` si le
 * lancement échoue (binaire absent). Ne lève jamais. `opener` ne sert qu'aux tests.
 */
export function openInBrowser(url: string, opener = process.platform === "darwin" ? "open" : "xdg-open"): boolean {
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface ConfigureDeps {
  start?: typeof startConfigureServer;
  open?: (url: string) => boolean;
  write?: (text: string) => void;
}

/** Code d'une erreur système (`EACCES`, `EISDIR`…), sinon un libellé neutre. */
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "erreur inconnue";
}

/**
 * `idnma configure [--no-open]` : démarre le serveur sur `~/.idnma.yml`, ouvre la page, et attend son arrêt
 * (page fermée ou Ctrl-C). Rend le code de sortie : 0 arrêt normal, 1 fichier illisible, 2 usage incorrect.
 */
export async function configureCommand(args: string[], deps: ConfigureDeps = {}): Promise<number> {
  const start = deps.start ?? startConfigureServer;
  const open = deps.open ?? openInBrowser;
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));

  if (args[0] === "--help" || args[0] === "-h") {
    write(CONFIGURE_HELP);
    return 0;
  }
  const unknown = args.find((arg) => arg !== "--no-open");
  if (unknown !== undefined) {
    process.stderr.write(`idnma configure : argument inconnu « ${unknown} »\n\n${CONFIGURE_HELP}`);
    return 2;
  }

  const path = networkPath();
  let server: ReturnType<typeof startConfigureServer>;
  try {
    server = start({ path });
  } catch (error) {
    process.stderr.write(`idnma configure : impossible de lire ${path} (${errorCode(error)}).\n`);
    return 1;
  }

  write(`idnma configure : ${server.url}\nCtrl-C pour arrêter ; s'arrête seul quand la page est fermée.\n`);
  if (!args.includes("--no-open") && !open(server.url)) write("Ouvre cette adresse dans ton navigateur.\n");

  // Ctrl-C libère le port proprement ; l'écouteur part avec le serveur.
  const onSignal = (): void => server.stop();
  process.once("SIGINT", onSignal);
  try {
    await server.done;
  } finally {
    process.off("SIGINT", onSignal);
  }
  return 0;
}
