// Contrôles du lancement en mode unifié qui précèdent tout effet (pane, nom, bus) : sans import lourd.
// Ce module n'importe de `src/acp/` que des types : `src/run/run.ts` l'importe en statique.
import type { UnifiedHarness } from "../acp/harness.ts";
import { engineIssues, UNIFIED_HARNESSES } from "../config/engine-rules.ts";
import { ConfigError, type Engine, type Harness } from "../config/network.ts";
import { UsageError } from "../run/args.ts";

/** L'écran du lancement : `--unified` ou `--native` tapé l'emporte sur `ui:` de l'engine, `native` par défaut. */
export function effectiveUi(engine: Engine, typed: "native" | "unified" | undefined): "native" | "unified" {
  return typed ?? engine.ui ?? "native";
}

/**
 * Refuse le mode unifié pour un harnais qui ne sait pas le porter. `--unified` tapé : erreur d'usage ; `ui: unified`
 * de l'engine : erreur de configuration, dite par la règle `unified-harness` partagée avec `idnma configure`.
 * `runAgent` filtre `engineIssues` par une liste blanche de codes : cette règle-ci ne passe pas par lui.
 * Le message nomme le harnais. À appeler avant tout effet.
 */
export function assertUnifiedHarness(engine: Engine, typed: "native" | "unified" | undefined, source: string): void {
  if (typed === "native") return;
  if (typed === "unified" && !(UNIFIED_HARNESSES as readonly Harness[]).includes(engine.harness)) {
    throw new UsageError(`--unified ne vaut que pour ${UNIFIED_HARNESSES.join(", ")} (harnais ${engine.harness}).`);
  }
  const issue = engineIssues(engine, source).find((candidate) => candidate.code === "unified-harness");
  if (issue !== undefined) throw new ConfigError(issue.message);
}

/** Message quand le binaire que idnma lance (l'adaptateur ACP, ou le harnais lui-même) n'est pas dans le PATH. */
export function missingAdapterMessage(harness: UnifiedHarness): string {
  switch (harness) {
    case "claude":
      return "Adaptateur « claude-agent-acp » introuvable dans le PATH. Télécharge l'archive de ta plateforme sur https://github.com/agentclientprotocol/claude-agent-acp/releases, puis pose ou lie le binaire claude-agent-acp dans le PATH (il tourne sans Node).";
    case "agy":
      return "Binaire « agy » introuvable dans le PATH.";
    case "opencode":
      return "Binaire « opencode » introuvable dans le PATH.";
    case "codex":
      return "Adaptateur « codex-acp » introuvable dans le PATH. Installe-le avec bun add -g @agentclientprotocol/codex-acp@2.5.0 (ou npm install -g), Node 22 requis.";
    case "grok":
      return "Binaire « grok » introuvable dans le PATH.";
    case "pi":
      return "Adaptateur « pi-acp » introuvable dans le PATH. Installe-le avec bun add -g pi-acp@0.0.34 (ou npm install -g), Node 22 requis.";
    case "dst":
      return "Binaire « dsh » introuvable dans le PATH (dst en mode unifié lance dsh --profile acp).";
  }
}

/**
 * Message quand le binaire de l'agent que l'adaptateur pilote manque (codex, pi). Les autres harnais n'ont pas de
 * binaire d'agent obligatoire : le message de l'adaptateur sert, le cas n'arrive pas.
 */
export function missingAgentMessage(harness: UnifiedHarness): string {
  switch (harness) {
    case "codex":
      return "Binaire « codex » introuvable dans le PATH : codex-acp le lance (CODEX_PATH).";
    case "pi":
      return "Binaire « pi » introuvable dans le PATH : pi-acp le lance.";
    case "claude":
    case "agy":
    case "opencode":
    case "grok":
    case "dst":
      return missingAdapterMessage(harness);
  }
}

/** Message quand l'agent répond qu'il n'est pas connecté (erreur ACP `authRequired`). */
export function notConnectedMessage(harness: UnifiedHarness): string {
  switch (harness) {
    case "claude":
      return "Claude n'est pas connecté : lance claude puis /login, puis relance idnma.";
    case "agy":
      return "agy n'est pas connecté : lance agy pour te connecter, puis relance idnma.";
    case "opencode":
      return "opencode n'est pas connecté : lance opencode auth login, puis relance idnma.";
    case "codex":
      return "Codex n'est pas connecté : lance codex login, puis relance idnma.";
    case "grok":
      return "Grok n'est pas connecté : lance grok pour te connecter, puis relance idnma.";
    case "pi":
      return "Pi n'est pas connecté : lance pi pour te connecter, puis relance idnma.";
    case "dst":
      return "dst n'est pas connecté : lance dst pour te connecter, puis relance idnma.";
  }
}
