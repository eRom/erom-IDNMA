/** Usage incorrect de `idnma run` : message en français pour l'utilisateur, code de sortie 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface RunArgs {
  agent?: string;
  engine?: string;
  passthrough: string[];
}

/**
 * Grammaire : `--here` est consommé et ignoré où qu'il soit (IdemA le tape par habitude) ;
 * `--engine` prend une valeur (`--engine e` ou `--engine=e`) ; le premier positionnel est
 * l'agent ; tout autre jeton, et tout ce qui suit `--`, part au harnais.
 */
export function parseRunArgs(argv: string[]): RunArgs {
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const tail = separator === -1 ? [] : argv.slice(separator + 1);
  const passthrough: string[] = [];
  let agent: string | undefined;
  let engine: string | undefined;

  for (let i = 0; i < head.length; i++) {
    const token = head[i]!;
    if (token === "--engine" || token.startsWith("--engine=")) {
      const value = token === "--engine" ? head[++i] : token.slice("--engine=".length);
      if (value === undefined || value === "") throw new UsageError("--engine attend une valeur.");
      engine = value;
    } else if (token === "--here") {
      continue;
    } else if (agent === undefined && !token.startsWith("-")) {
      agent = token;
    } else {
      passthrough.push(token);
    }
  }

  return {
    ...(agent === undefined ? {} : { agent }),
    ...(engine === undefined ? {} : { engine }),
    passthrough: [...passthrough, ...tail],
  };
}
