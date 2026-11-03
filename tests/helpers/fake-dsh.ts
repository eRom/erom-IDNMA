// Faux `ctx` Cordis pour tester le plugin idnma sans dsh. Les formes reprennent celles observées par
// la sonde dans dst : `ctx.on(event, handler)`, `ctx.effect(fn)` dont le retour est un disposer,
// `ctx.agents.roots()`, `ctx.shellEnv.register(contributor)`, agents `{ id, status, session, inbox }`.

export interface FakeMessage {
  id: string;
  role?: string;
  content?: unknown[];
  source?: { kind?: string; [key: string]: unknown };
}

export interface AgentCall {
  mode: "followup" | "steer";
  message: FakeMessage;
}

export interface FakeAgent {
  id: string;
  status: "idle" | "running";
  session: { id: string; header: { id: string } };
  inbox: { nextTurn: FakeMessage[]; nextStep: FakeMessage[] };
  /** Appels reçus, dans l'ordre. */
  calls: AgentCall[];
  /** Erreur à lever à l'appel correspondant (simule un refus de dsh). */
  failWith: { followup?: unknown; steer?: unknown };
  /** Appelé dans `followup()`/`steer()`, après l'enregistrement : permet d'émettre comme dsh, de façon synchrone, avant le retour. */
  onCall?: (call: AgentCall) => void;
  followup(message: FakeMessage): void;
  steer(message: FakeMessage): void;
}

export function createFakeAgent(id: string): FakeAgent {
  const agent: FakeAgent = {
    id,
    status: "idle",
    session: { id, header: { id } },
    inbox: { nextTurn: [], nextStep: [] },
    calls: [],
    failWith: {},
    followup(message) {
      const call: AgentCall = { mode: "followup", message };
      agent.calls.push(call);
      agent.onCall?.(call);
      if (agent.failWith.followup !== undefined) throw agent.failWith.followup;
    },
    steer(message) {
      const call: AgentCall = { mode: "steer", message };
      agent.calls.push(call);
      agent.onCall?.(call);
      if (agent.failWith.steer !== undefined) throw agent.failWith.steer;
    },
  };
  return agent;
}

export interface FakeContributor {
  name: string;
  variables: Record<string, { description: string }>;
  resolve(): Record<string, string>;
}

export interface FakeCtx {
  on(event: string, handler: (...args: never[]) => unknown): () => void;
  /** Émet un événement vers les écouteurs inscrits ; une exception d'écouteur remonte à l'appelant. */
  emit(event: string, ...args: unknown[]): void;
  effect(fn: () => () => void): void;
  /** Exécute les disposers d'effets et retire tous les écouteurs. */
  dispose(): void;
  listenerCount(): number;
  agents: {
    roots(): FakeAgent[];
    get(id: string): FakeAgent | undefined;
    /** Ajoute un agent au registre ; `root: false` en fait un sous-agent (absent de `roots()`). */
    add(agent: FakeAgent, options?: { root?: boolean }): void;
    remove(id: string): void;
  };
  shellEnv: {
    contributors: FakeContributor[];
    /** Erreur à lever à l'inscription (contributeur déjà inscrit après un rechargement). */
    failWith?: Error;
    register(contributor: FakeContributor): () => void;
  };
}

export function createFakeDsh(): FakeCtx {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const effectDisposers: Array<() => void> = [];
  const registry = new Map<string, { agent: FakeAgent; root: boolean }>();
  const contributors: FakeContributor[] = [];

  const ctx: FakeCtx = {
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      const stored = handler as (...args: unknown[]) => unknown;
      set.add(stored);
      listeners.set(event, set);
      return () => {
        set.delete(stored);
      };
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    effect(fn) {
      effectDisposers.push(fn());
    },
    dispose() {
      for (const disposer of effectDisposers.splice(0).reverse()) disposer();
      listeners.clear();
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
    agents: {
      roots: () => [...registry.values()].filter((entry) => entry.root).map((entry) => entry.agent),
      get: (id) => registry.get(id)?.agent,
      add(agent, options = {}) {
        registry.set(agent.id, { agent, root: options.root ?? true });
      },
      remove(id) {
        registry.delete(id);
      },
    },
    shellEnv: {
      contributors,
      register(contributor) {
        if (ctx.shellEnv.failWith !== undefined) throw ctx.shellEnv.failWith;
        contributors.push(contributor);
        return () => {
          const index = contributors.indexOf(contributor);
          if (index !== -1) contributors.splice(index, 1);
        };
      },
    },
  };
  return ctx;
}
