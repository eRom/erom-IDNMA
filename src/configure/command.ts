/** Commande de test d'un engine : `idnma run <clé>` pour `default`, sinon avec `--engine <nom>`. */
export function commandLine(agentKey: string, engineName: string): string {
  return engineName === "default" ? `idnma run ${agentKey}` : `idnma run ${agentKey} --engine ${engineName}`;
}
