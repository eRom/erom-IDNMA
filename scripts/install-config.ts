// Installe la configuration d'idnma : ~/.idnma.yml depuis l'exemple du dépôt. N'écrase rien.
// Les variables des engines (`$NOM`) viennent de l'environnement (~/.zshenv) ; aucun secrets.yml
// n'est lu ni créé, et un secrets.yml déjà présent n'est jamais touché.
// Usage : bun scripts/install-config.ts
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkPath } from "../src/paths.ts";

const EXAMPLE = join(import.meta.dir, "..", ".idnma.example.yml");

function main(): void {
  const path = networkPath();
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    console.log(`.idnma.yml déjà présent, rien touché : ${path}`);
  } else {
    copyFileSync(EXAMPLE, path);
    console.log(`.idnma.yml créé : ${path}`);
  }
}

try {
  main();
} catch (error) {
  // Une erreur système (droits, disque) : son message cite un chemin, jamais une valeur d'environnement.
  console.error(`install-config : ${error instanceof Error ? error.message : "erreur inconnue"}`);
  process.exit(1);
}
