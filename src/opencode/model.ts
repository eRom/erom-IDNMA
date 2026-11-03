/** Référence de modèle d'opencode : fournisseur, identifiant, variante facultative. */
export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Entrée de `GET /api/model` (champ `data`, un tableau). */
export interface ModelEntry {
  providerID: string;
  id: string;
  variants?: Array<{ id: string }>;
}

/**
 * Lit `fournisseur/modèle` ou `fournisseur/modèle#variante`. Le fournisseur va jusqu'au premier `/`
 * (un identifiant de modèle peut en contenir d'autres), la variante suit le dernier `#`.
 * `undefined` sans `/` ou avec une partie vide.
 */
export function parseModelRef(text: string): ModelRef | undefined {
  const slash = text.indexOf("/");
  if (slash < 0) return undefined;
  const providerID = text.slice(0, slash);
  let id = text.slice(slash + 1);
  let variant: string | undefined;
  const hash = id.lastIndexOf("#");
  if (hash >= 0) {
    variant = id.slice(hash + 1);
    id = id.slice(0, hash);
    if (variant === "") return undefined;
  }
  if (providerID === "" || id === "") return undefined;
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

/** Vrai si le service connaît ce modèle ; une variante absente ou `default` est toujours acceptée. */
export function hasModel(models: ModelEntry[], ref: ModelRef): boolean {
  const entry = models.find((m) => m.providerID === ref.providerID && m.id === ref.id);
  if (!entry) return false;
  if (ref.variant === undefined || ref.variant === "default") return true;
  return entry.variants?.some((v) => v.id === ref.variant) ?? false;
}
