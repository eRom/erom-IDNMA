import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { createLineReader, encodeFrame, parsePluginFrame } from "../src/bridge/protocol.ts";
import { apply } from "../src/dst/plugin.ts";
import type { BridgePluginConfig } from "../src/dst/plugin.ts";
import { createFakeAgent, createFakeDsh } from "./helpers/fake-dsh.ts";
import type { FakeAgent, FakeCtx, FakeMessage } from "./helpers/fake-dsh.ts";

type Frame = Record<string, unknown> & { type: string };

const BRIDGE_TOKEN = "bridge-token-test";
const CONTROL_TOKEN = "control-token-test";
const PID = 4242;

// --- Faux pont : un vrai serveur node:net qui joue la doublure ------------------------------------

interface Bridge {
  path: string;
  dir: string;
  frames: Frame[];
  /** Lignes que le parseur du livreur (`parsePluginFrame`) refuse : doit rester vide. */
  invalid: string[];
  connections: number;
  closedConnections: number;
  send(frame: object): void;
  /** Envoie une ligne que le plugin doit refuser (`bad-frame`) ; le barrage la compte pour ne pas la confondre avec sa propre réponse. */
  sendInvalid(line: object | string): void;
  /** Rend toutes les trames émises avant l'appel, dans l'ordre : le plugin répond au barrage après avoir traité ce qui précède. */
  barrier(): Promise<void>;
}

const cleanups: Array<() => void> = [];
const bridges: Bridge[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startBridge(): Promise<Bridge> {
  const dir = mkdtempSync("/tmp/idnma-t-");
  const path = join(dir, "b.sock");
  let connection: Socket | undefined;
  let intentionalBadFrames = 0;
  const bridge: Bridge = {
    path,
    dir,
    frames: [],
    invalid: [],
    connections: 0,
    closedConnections: 0,
    send(frame) {
      connection?.write(encodeFrame(frame));
    },
    sendInvalid(line) {
      intentionalBadFrames += 1;
      connection?.write(typeof line === "string" ? `${line}\n` : encodeFrame(line));
    },
    async barrier() {
      const badFrames = () => bridge.frames.filter((frame) => frame.type === "error" && frame.code === "bad-frame").length;
      connection?.write("barrier\n");
      await waitFor(() => badFrames() > intentionalBadFrames);
      // retire la réponse au barrage pour ne pas polluer les assertions
      let index = bridge.frames.length - 1;
      while (index >= 0 && !(bridge.frames[index]?.type === "error" && bridge.frames[index]?.code === "bad-frame")) index -= 1;
      bridge.frames.splice(index, 1);
    },
  };
  const server: Server = createServer((socket) => {
    connection = socket;
    bridge.connections += 1;
    socket.on("error", () => {});
    socket.on("close", () => {
      bridge.closedConnections += 1;
    });
    socket.on(
      "data",
      createLineReader(
        (line) => {
          if (parsePluginFrame(line) === undefined) bridge.invalid.push(line);
          bridge.frames.push(JSON.parse(line) as Frame);
        },
        () => {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    connection?.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  bridges.push(bridge);
  return bridge;
}

afterEach(() => {
  const invalid = bridges.flatMap((bridge) => bridge.invalid);
  bridges.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
  // une trame que le parseur du livreur refuse est un défaut du plugin, quel que soit le test
  expect(invalid).toEqual([]);
});

// --- Montage ------------------------------------------------------------------------------------

interface Rig {
  ctx: FakeCtx;
  bridge: Bridge;
  agents: FakeAgent[];
  serversFile: string;
  /** Écrit `servers.json` comme la TUI : une entrée pour le pid du plugin. */
  pointTo(sessionId: string | undefined): void;
}

interface RigOptions {
  agents?: string[];
  subAgents?: string[];
  control?: boolean;
  config?: BridgePluginConfig;
  /** `true` : `servers.json` désigne cette session dès le départ. */
  serversSession?: string;
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const bridge = await startBridge();
  const ctx = createFakeDsh();
  const serversFile = join(bridge.dir, "servers.json");
  const agents = (options.agents ?? ["a1"]).map(createFakeAgent);
  for (const agent of agents) ctx.agents.add(agent);
  const setup: Rig = {
    ctx,
    bridge,
    agents,
    serversFile,
    pointTo(sessionId) {
      writeFileSync(serversFile, JSON.stringify(sessionId === undefined ? [{ pid: 1, sessionId: "other" }] : [{ pid: 1, sessionId: "other" }, { pid: PID, sessionId }]));
    },
  };
  if (options.serversSession !== undefined) setup.pointTo(options.serversSession);
  const env: Record<string, string | undefined> = { IDNMA_DST_BRIDGE: bridge.path, IDNMA_DST_BRIDGE_TOKEN: BRIDGE_TOKEN };
  if (options.control) env.IDNMA_CONTROL_TOKEN = CONTROL_TOKEN;
  apply(ctx, { serversFile, env, pid: PID, refreshMs: 600_000, discardGraceMs: 40, ...options.config });
  cleanups.push(() => ctx.dispose());
  await waitFor(() => bridge.frames.length >= 2);
  return setup;
}

const message = (id: string, kind?: string): FakeMessage => (kind === undefined ? { id } : { id, source: { kind } });

/** Envoie un `deliver` depuis la doublure et rend les trames que le plugin émet en réponse. */
async function deliver(r: Rig, frame: { id: string; priority: "now" | "next" | "later"; text?: string; hint?: string; sender?: string }): Promise<Frame[]> {
  const before = r.bridge.frames.length;
  r.bridge.send({ type: "deliver", sender: "claude-junon", text: "Quelle est la capitale de la France ?", ...frame });
  await r.bridge.barrier();
  return r.bridge.frames.slice(before);
}

const framesOf = (r: Rig, type: string): Frame[] => r.bridge.frames.filter((frame) => frame.type === type);

const turnStart = (r: Rig, agent: FakeAgent, turn: number): void => r.ctx.emit("session/event", agent.session, { type: "turn/start", seq: turn * 10, data: { turn } });
const turnEnd = (r: Rig, agent: FakeAgent, turn: number, reason: object): void => r.ctx.emit("session/event", agent.session, { type: "turn/end", seq: turn * 10 + 9, data: { turn, reason } });
const assistantSays = (r: Rig, agent: FakeAgent, turn: number, text: string): void =>
  r.ctx.emit("session/event", agent.session, { type: "assistant/message", seq: turn * 10 + 5, data: { turn, step: 1, message: { content: [{ type: "text", text }] } } });
const claim = (r: Rig, agent: FakeAgent, claimedMessage: FakeMessage, turn: number): void => r.ctx.emit("agent/inbox/claimed", { agent, message: claimedMessage, turn });
const setStatus = (r: Rig, agent: FakeAgent, status: "idle" | "running"): void => {
  agent.status = status;
  r.ctx.emit("agent/status", { agent, status });
};
const lastCall = (agent: FakeAgent) => agent.calls[agent.calls.length - 1];

// --- Inerte, connexion, enregistrement ------------------------------------------------------------

describe("inert without the bridge variables", () => {
  test("no listener and no connection when IDNMA_DST_BRIDGE is missing", async () => {
    const bridge = await startBridge();
    const ctx = createFakeDsh();
    apply(ctx, { env: { IDNMA_DST_BRIDGE_TOKEN: BRIDGE_TOKEN, IDNMA_CONTROL_TOKEN: CONTROL_TOKEN }, pid: PID });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ctx.listenerCount()).toBe(0);
    expect(ctx.shellEnv.contributors).toHaveLength(0);
    expect(bridge.connections).toBe(0);
  });

  test("no listener and no connection when IDNMA_DST_BRIDGE_TOKEN is missing", async () => {
    const bridge = await startBridge();
    const ctx = createFakeDsh();
    apply(ctx, { env: { IDNMA_DST_BRIDGE: bridge.path }, pid: PID });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ctx.listenerCount()).toBe(0);
    expect(bridge.connections).toBe(0);
  });
});

describe("hello and state", () => {
  test("sends hello then the current state, without the tui version when unknown", async () => {
    const r = await rig({ agents: [] });
    expect(r.bridge.frames[0]).toEqual({ type: "hello", v: 1, token: BRIDGE_TOKEN, pid: PID, versions: {} });
    expect(r.bridge.frames[1]).toEqual({ type: "state", session: null, status: "idle" });
  });

  test("announces the foreground agent and its status in the first state", async () => {
    const r = await rig({ agents: ["a1"] });
    expect(r.bridge.frames[1]).toEqual({ type: "state", session: "a1", status: "idle" });
  });

  test("reads the tui version from the package found above process.argv[1]", async () => {
    const root = mkdtempSync("/tmp/idnma-t-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, "node_modules", "@deepseek-harness-tui", "dsh-tui");
    mkdirSync(join(pkgDir, "lib"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-harness-tui/dsh-tui", version: "0.17.0" }));
    writeFileSync(join(pkgDir, "lib", "host-entry.js"), "");
    const original = process.argv[1];
    process.argv[1] = join(pkgDir, "lib", "host-entry.js");
    try {
      const r = await rig({ agents: [] });
      expect(r.bridge.frames[0]).toEqual({ type: "hello", v: 1, token: BRIDGE_TOKEN, pid: PID, versions: { tui: "0.17.0" } });
    } finally {
      if (original === undefined) process.argv.splice(1, 1);
      else process.argv[1] = original;
    }
  });

  test("a socket error never throws out of the plugin", async () => {
    const dir = mkdtempSync("/tmp/idnma-t-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = createFakeDsh();
    ctx.agents.add(createFakeAgent("a1"));
    expect(() => apply(ctx, { env: { IDNMA_DST_BRIDGE: join(dir, "absent.sock"), IDNMA_DST_BRIDGE_TOKEN: BRIDGE_TOKEN }, pid: PID, serversFile: join(dir, "servers.json") })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(() => ctx.emit("agent/status", { agent: ctx.agents.roots()[0], status: "running" })).not.toThrow();
    expect(() => ctx.dispose()).not.toThrow();
  });
});

describe("shell environment of the agent commands", () => {
  test("registers the control token under DSH_IDNMA_CONTROL_TOKEN only when IDNMA_CONTROL_TOKEN exists", async () => {
    const withToken = await rig({ control: true });
    const [contributor] = withToken.ctx.shellEnv.contributors;
    expect(withToken.ctx.shellEnv.contributors).toHaveLength(1);
    expect(contributor?.name).toBe("idnma");
    expect(Object.keys(contributor?.variables ?? {})).toEqual(["DSH_IDNMA_CONTROL_TOKEN"]);
    expect(contributor?.variables.DSH_IDNMA_CONTROL_TOKEN?.description).toBe("Jeton du canal de contrôle idnma (idnma peer send, idnma peer list).");
    expect(contributor?.resolve()).toEqual({ DSH_IDNMA_CONTROL_TOKEN: CONTROL_TOKEN });

    const without = await rig({ control: false });
    expect(without.ctx.shellEnv.contributors).toHaveLength(0);
  });

  test("unregisters the contributor when the plugin is disposed", async () => {
    const r = await rig({ control: true });
    r.ctx.dispose();
    expect(r.ctx.shellEnv.contributors).toHaveLength(0);
  });

  test("a register that throws reports register-failed and the bridge keeps working", async () => {
    const bridge = await startBridge();
    const ctx = createFakeDsh();
    ctx.shellEnv.failWith = new Error("contributor idnma already registered (secret detail)");
    const agent = createFakeAgent("a1");
    ctx.agents.add(agent);
    apply(ctx, { env: { IDNMA_DST_BRIDGE: bridge.path, IDNMA_DST_BRIDGE_TOKEN: BRIDGE_TOKEN, IDNMA_CONTROL_TOKEN: CONTROL_TOKEN }, pid: PID, refreshMs: 600_000, serversFile: join(bridge.dir, "servers.json") });
    cleanups.push(() => ctx.dispose());
    await waitFor(() => bridge.frames.length >= 3);
    expect(bridge.frames.find((frame) => frame.type === "error")).toEqual({ type: "error", code: "register-failed" });

    bridge.send({ type: "deliver", id: "m1", priority: "next", sender: "claude-junon", text: "salut" });
    await bridge.barrier();
    expect(agent.calls).toHaveLength(1);
    expect(bridge.frames.some((frame) => frame.type === "delivered" && frame.id === "m1")).toBe(true);
  });
});

// --- Premier plan ---------------------------------------------------------------------------------

describe("foreground agent", () => {
  test("servers.json designates the root of the session recorded for this pid", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1" });
    expect(framesOf(r, "state")[0]).toEqual({ type: "state", session: "r1", status: "idle" });
  });

  test("a change of servers.json at a lifecycle event produces a new state", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1" });
    r.pointTo("r2");
    const [r1] = r.agents;
    r.ctx.emit("agent/status", { agent: r1, status: "idle" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r1", "r2"]);
  });

  test("falls back to the last created root when servers.json is absent", async () => {
    const r = await rig({ agents: ["r1", "r2"] });
    // aucun `agent/created` vu : repli final sur la dernière de roots()
    expect(framesOf(r, "state")[0]?.session).toBe("r2");
    const older = r.agents[0] as FakeAgent;
    r.ctx.emit("agent/created", { agent: older, source: "startup" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r2", "r1"]);
  });

  test("falls back when servers.json has no entry for this pid or names a session without a live root", async () => {
    const r = await rig({ agents: ["r1", "r2"] });
    writeFileSync(r.serversFile, JSON.stringify([{ pid: 1, sessionId: "r1" }]));
    r.ctx.emit("agent/status", { agent: r.agents[0], status: "idle" });
    writeFileSync(r.serversFile, JSON.stringify([{ pid: PID, sessionId: "gone" }]));
    r.ctx.emit("agent/status", { agent: r.agents[0], status: "idle" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r2"]);
  });

  test("the only root is the foreground even when servers.json names another session", async () => {
    const r = await rig({ agents: ["solo"], serversSession: "gone" });
    expect(framesOf(r, "state")[0]?.session).toBe("solo");
  });

  test("a sub-agent created after the roots is never chosen", async () => {
    const r = await rig({ agents: ["r1", "r2"] });
    const sub = createFakeAgent("sub1");
    r.ctx.agents.add(sub, { root: false });
    r.ctx.emit("agent/created", { agent: sub, source: "startup" });
    r.ctx.emit("agent/created", { agent: r.agents[0], source: "startup" });
    const sub2 = createFakeAgent("sub2");
    r.ctx.agents.add(sub2, { root: false });
    r.ctx.emit("agent/created", { agent: sub2, source: "startup" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r2", "r1"]);
  });

  test("an unreadable servers.json after a valid read keeps the foreground", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1" });
    writeFileSync(r.serversFile, '[{"pid": 4242, "sessi');
    r.ctx.emit("agent/status", { agent: r.agents[0], status: "idle" });
    r.ctx.emit("agent/created", { agent: r.agents[1], source: "startup" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r1"]);
  });

  test("servers.json is reread on each deliver, not only on lifecycle events", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1" });
    r.pointTo("r2");
    await deliver(r, { id: "m1", priority: "next" });
    expect(r.agents[1]?.calls).toHaveLength(1);
    expect(r.agents[0]?.calls).toHaveLength(0);
  });

  test("servers.json is never reread on session/event", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1" });
    r.pointTo("r2");
    turnStart(r, r.agents[0] as FakeAgent, 1);
    assistantSays(r, r.agents[0] as FakeAgent, 1, "texte");
    turnEnd(r, r.agents[0] as FakeAgent, 1, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.session)).toEqual(["r1"]);
  });

  test("the refresh timer rereads servers.json", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r1", config: { refreshMs: 20 } });
    r.pointTo("r2");
    await waitFor(() => framesOf(r, "state").some((frame) => frame.session === "r2"));
  });

  test("a new state is sent when the status of the foreground changes, and only then", async () => {
    const r = await rig({ agents: ["a1"] });
    const [a1] = r.agents as [FakeAgent];
    setStatus(r, a1, "running");
    setStatus(r, a1, "running");
    setStatus(r, a1, "idle");
    await r.bridge.barrier();
    expect(framesOf(r, "state").map((frame) => frame.status)).toEqual(["idle", "running", "idle"]);
  });
});

// --- Table de choix -------------------------------------------------------------------------------

type Mode = "followup" | "steer";
interface TableRow {
  name: string;
  expected: Record<"now" | "next" | "later", Mode>;
  arrange(r: Rig, agent: FakeAgent): Promise<void>;
}

const ROMAIN_TURN_MESSAGE = message("romain-1", "user");

const TABLE: TableRow[] = [
  { name: "at rest", expected: { now: "followup", next: "followup", later: "followup" }, arrange: async () => {} },
  {
    name: "during a peer turn",
    expected: { now: "steer", next: "followup", later: "followup" },
    arrange: async (r, agent) => {
      await deliver(r, { id: "peer-0", priority: "next" });
      agent.status = "running";
      agent.inbox.nextTurn = [message("peer-0", "agent-message")];
      turnStart(r, agent, 1);
    },
  },
  {
    name: "during a user turn",
    expected: { now: "steer", next: "steer", later: "followup" },
    arrange: async (r, agent) => {
      agent.status = "running";
      agent.inbox.nextTurn = [ROMAIN_TURN_MESSAGE];
      turnStart(r, agent, 1);
    },
  },
  {
    name: "during a turn of unknown owner",
    expected: { now: "steer", next: "steer", later: "followup" },
    arrange: async (r, agent) => {
      agent.status = "running";
      agent.inbox.nextTurn = [];
      turnStart(r, agent, 1);
    },
  },
  {
    name: "between two turns with ours at the head of next-turn",
    expected: { now: "steer", next: "followup", later: "followup" },
    arrange: async (r, agent) => {
      await deliver(r, { id: "peer-0", priority: "next" });
      agent.status = "running";
      agent.inbox.nextTurn = [message("peer-0", "agent-message")];
    },
  },
  {
    name: "between two turns with a foreign message at the head of next-turn",
    expected: { now: "steer", next: "steer", later: "followup" },
    arrange: async (_r, agent) => {
      agent.status = "running";
      agent.inbox.nextTurn = [ROMAIN_TURN_MESSAGE];
    },
  },
  {
    name: "between two turns with an empty next-turn",
    expected: { now: "followup", next: "followup", later: "followup" },
    arrange: async (_r, agent) => {
      agent.status = "running";
      agent.inbox.nextTurn = [];
    },
  },
];

describe("choice of followup or steer", () => {
  for (const row of TABLE) {
    for (const priority of ["now", "next", "later"] as const) {
      test(`${row.name}, priority ${priority}: ${row.expected[priority]}`, async () => {
        const r = await rig();
        const [agent] = r.agents as [FakeAgent];
        await row.arrange(r, agent);
        const frames = await deliver(r, { id: "probe", priority });
        expect(lastCall(agent)?.mode).toBe(row.expected[priority]);
        expect(frames.filter((frame) => frame.type === "delivered")).toEqual([{ type: "delivered", id: "probe", mode: row.expected[priority], session: "a1" }]);
      });
    }
  }
});

describe("message handed to dsh", () => {
  test("followup carries the relay form (F8) with the text alone, even when a hint is given", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next", sender: "claude-junon", text: "Quelle est la capitale ?", hint: "Réponds par idnma peer send claude-junon" });
    expect(agent.calls).toEqual([
      {
        mode: "followup",
        message: {
          id: "m1",
          role: "user",
          content: [
            { type: "text", text: "Team message from claude-junon:" },
            { type: "text", text: "Quelle est la capitale ?" },
          ],
          source: { kind: "agent-message", form: "relay", senderSessionId: "claude-junon" },
        },
      },
    ]);
  });

  test("steer sends text, a newline and the hint; without hint, the text alone", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.status = "running";
    agent.inbox.nextTurn = [ROMAIN_TURN_MESSAGE];
    await deliver(r, { id: "m1", priority: "now", text: "pause ?", hint: "Réponds par idnma peer send claude-junon" });
    await deliver(r, { id: "m2", priority: "now", text: "sans rappel" });
    expect(agent.calls.map((call) => call.mode)).toEqual(["steer", "steer"]);
    expect(agent.calls[0]?.message.content?.[1]).toEqual({ type: "text", text: "pause ?\nRéponds par idnma peer send claude-junon" });
    expect(agent.calls[1]?.message.content?.[1]).toEqual({ type: "text", text: "sans rappel" });
  });
});

// --- Propriétaire du tour -------------------------------------------------------------------------

describe("turn owner fixed at turn/start from inbox.nextTurn[0]", () => {
  for (const order of ["steer first", "followup first"] as const) {
    test(`our steer and a user followup claimed in one batch (${order}) leave the turn to the user`, async () => {
      const r = await rig();
      const [agent] = r.agents as [FakeAgent];
      agent.status = "running";
      agent.inbox.nextTurn = [message("romain-0", "user")];
      turnStart(r, agent, 1);
      await deliver(r, { id: "steer-1", priority: "now" });
      expect(lastCall(agent)?.mode).toBe("steer");
      turnEnd(r, agent, 1, { kind: "completed" });

      const romainFollowup = message("romain-2", "user");
      agent.inbox.nextTurn = [romainFollowup];
      agent.inbox.nextStep = [lastCall(agent)?.message as FakeMessage];
      turnStart(r, agent, 2);
      const ourSteer = lastCall(agent)?.message as FakeMessage;
      if (order === "steer first") {
        claim(r, agent, ourSteer, 2);
        claim(r, agent, romainFollowup, 2);
      } else {
        claim(r, agent, romainFollowup, 2);
        claim(r, agent, ourSteer, 2);
      }
      // `next` pendant un tour de l'utilisateur : steer ; un tour de pair l'aurait mis en followup
      await deliver(r, { id: "probe", priority: "next" });
      expect(lastCall(agent)?.mode).toBe("steer");
      expect(framesOf(r, "result")).toEqual([]);
    });

    test(`a user steer and our followup claimed in one batch (${order}) give a mixed peer turn`, async () => {
      const r = await rig();
      const [agent] = r.agents as [FakeAgent];
      await deliver(r, { id: "peer-f", priority: "next" });
      const ourFollowup = lastCall(agent)?.message as FakeMessage;
      const romainSteer = message("romain-s", "user");
      agent.status = "running";
      agent.inbox.nextTurn = [ourFollowup];
      agent.inbox.nextStep = [romainSteer];
      turnStart(r, agent, 1);
      if (order === "steer first") {
        claim(r, agent, romainSteer, 1);
        claim(r, agent, ourFollowup, 1);
      } else {
        claim(r, agent, ourFollowup, 1);
        claim(r, agent, romainSteer, 1);
      }
      assistantSays(r, agent, 1, "⏵ Réponse\n\nParis");
      turnEnd(r, agent, 1, { kind: "completed" });
      await r.bridge.barrier();
      expect(framesOf(r, "result")).toEqual([{ type: "result", id: "peer-f", turn: 1, reason: "completed", mixed: true, sources: ["user"], text: "Paris" }]);
    });
  }

  test("a peer turn lets the next priority wait as a followup", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "peer-f", priority: "next" });
    agent.status = "running";
    agent.inbox.nextTurn = [lastCall(agent)?.message as FakeMessage];
    turnStart(r, agent, 1);
    claim(r, agent, lastCall(agent)?.message as FakeMessage, 1);
    agent.inbox.nextTurn = [];
    await deliver(r, { id: "probe", priority: "next" });
    expect(lastCall(agent)?.mode).toBe("followup");
  });
});

// --- Entrées de l'utilisateur et sources -----------------------------------------------------------------

/** Un followup des nôtres réclamé au tour 1 avec les messages étrangers `foreign`, puis `turn/end`. */
async function followupTurnWith(r: Rig, foreign: FakeMessage[]): Promise<Frame> {
  const [agent] = r.agents as [FakeAgent];
  await deliver(r, { id: "peer-f", priority: "next" });
  const ours = lastCall(agent)?.message as FakeMessage;
  agent.status = "running";
  agent.inbox.nextTurn = [ours];
  turnStart(r, agent, 1);
  claim(r, agent, ours, 1);
  for (const other of foreign) claim(r, agent, other, 1);
  assistantSays(r, agent, 1, "Réponse");
  turnEnd(r, agent, 1, { kind: "completed" });
  await r.bridge.barrier();
  const [result] = framesOf(r, "result");
  return result as Frame;
}

describe("user inputs", () => {
  for (const kind of ["user", "skill-invocation", "dsh-tui-btw", "dsh-tui-recap"]) {
    test(`a ${kind} message claimed in the turn of our followup makes the result mixed`, async () => {
      const r = await rig();
      const result = await followupTurnWith(r, [message("romain-x", kind)]);
      expect(result.mixed).toBe(true);
      expect(result.sources).toEqual([kind]);
    });
  }

  test("a skill-invocation claimed before our followup in the same turn still mixes it", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "peer-f", priority: "next" });
    const ours = lastCall(agent)?.message as FakeMessage;
    agent.status = "running";
    agent.inbox.nextTurn = [ours];
    turnStart(r, agent, 1);
    claim(r, agent, message("skill-1", "skill-invocation"), 1);
    claim(r, agent, ours, 1);
    turnEnd(r, agent, 1, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")[0]).toMatchObject({ mixed: true, sources: ["skill-invocation"] });
  });

  test("runtime-context and skill-catalog do not mix the turn and are reported in sources", async () => {
    const r = await rig();
    const result = await followupTurnWith(r, [message("ctx-1", "runtime-context"), message("cat-1", "skill-catalog")]);
    expect(result.mixed).toBe(false);
    expect(result.sources).toEqual(["runtime-context", "skill-catalog"]);
  });

  test("a claimed message without source is reported as none and does not mix the turn", async () => {
    const r = await rig();
    const result = await followupTurnWith(r, [message("anon-1")]);
    expect(result.mixed).toBe(false);
    expect(result.sources).toEqual(["none"]);
  });

  test("a user message claimed in another turn does not leak into the tracked turn", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.status = "running";
    agent.inbox.nextTurn = [message("romain-0", "user")];
    turnStart(r, agent, 1);
    claim(r, agent, message("romain-0", "user"), 1);
    turnEnd(r, agent, 1, { kind: "completed" });
    agent.status = "idle";
    agent.inbox.nextTurn = [];
    const result = await followupTurnWith(r, []);
    expect(result.mixed).toBe(false);
    expect(result.sources).toEqual([]);
  });
});

// --- Séquences capturées --------------------------------------------------------------------------

describe("captured sequences", () => {
  test("F6: dsh emits status, turn/start and claimed inside followup(); the wire order is delivered, state, claimed, result", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    // comme dsh : le message entre dans nextTurn, l'agent passe à running, le tour s'ouvre et réclame le message avant le retour de followup()
    agent.onCall = ({ message: sent }) => {
      agent.inbox.nextTurn = [sent];
      setStatus(r, agent, "running");
      turnStart(r, agent, 1);
      agent.inbox.nextTurn = [];
      claim(r, agent, sent, 1);
    };
    const answers = await deliver(r, { id: "m1", priority: "next" });
    expect(answers).toEqual([
      { type: "delivered", id: "m1", mode: "followup", session: "a1" },
      { type: "state", session: "a1", status: "running" },
      { type: "claimed", id: "m1", turn: 1 },
    ]);
    assistantSays(r, agent, 1, "⏵ Answering the team message\n\nParis");
    turnEnd(r, agent, 1, { kind: "completed" });
    setStatus(r, agent, "idle");
    await r.bridge.barrier();
    expect(r.bridge.frames.slice(2)).toEqual([
      { type: "delivered", id: "m1", mode: "followup", session: "a1" },
      { type: "state", session: "a1", status: "running" },
      { type: "claimed", id: "m1", turn: 1 },
      { type: "result", id: "m1", turn: 1, reason: "completed", mixed: false, sources: [], text: "Paris" },
      { type: "state", session: "a1", status: "idle" },
    ]);
  });

  test("frames emitted during a rejected call follow dropped rejected", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.onCall = () => setStatus(r, agent, "running");
    agent.failWith.followup = new Error("refusé");
    const answers = await deliver(r, { id: "m1", priority: "next" });
    expect(answers).toEqual([
      { type: "dropped", id: "m1", why: "rejected", error: "refusé" },
      { type: "state", session: "a1", status: "running" },
    ]);
  });

  test("F7: a steer claimed in turn 4 reports no result, the followup answers at turn 5 only", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    const romain = message("romain-4", "user");
    agent.inbox.nextTurn = [romain];
    setStatus(r, agent, "running");
    turnStart(r, agent, 4);
    claim(r, agent, romain, 4);
    agent.inbox.nextTurn = [];

    await deliver(r, { id: "steer-1", priority: "now" });
    await deliver(r, { id: "follow-1", priority: "later" });
    expect(agent.calls.map((call) => call.mode)).toEqual(["steer", "followup"]);
    const [steerMessage, followupMessage] = agent.calls.map((call) => call.message) as [FakeMessage, FakeMessage];
    agent.inbox.nextStep = [steerMessage];
    agent.inbox.nextTurn = [followupMessage];

    claim(r, agent, steerMessage, 4);
    assistantSays(r, agent, 4, "⏵ Wrapping up with the requested answer\n\nDONE-ROMAIN\nCapital of Italy: Rome");
    turnEnd(r, agent, 4, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "claimed")).toEqual([{ type: "claimed", id: "steer-1", turn: 4 }]);
    expect(framesOf(r, "result")).toEqual([]);

    turnStart(r, agent, 5);
    claim(r, agent, followupMessage, 5);
    assistantSays(r, agent, 5, "⏵ Answering the peer followup\n\nMadrid");
    turnEnd(r, agent, 5, { kind: "completed" });
    setStatus(r, agent, "idle");
    await r.bridge.barrier();
    expect(framesOf(r, "claimed")).toEqual([
      { type: "claimed", id: "steer-1", turn: 4 },
      { type: "claimed", id: "follow-1", turn: 5 },
    ]);
    expect(framesOf(r, "result")).toEqual([{ type: "result", id: "follow-1", turn: 5, reason: "completed", mixed: false, sources: [], text: "Madrid" }]);
  });

  test("run 4: a failed turn is reported as is, with message and code", async () => {
    const r = await rig();
    const result = await runTurn(r, { kind: "error", error: { message: "DeepSeek Messages transport failed", code: "TRANSPORT" } });
    expect(result).toEqual({
      type: "result",
      id: "peer-f",
      turn: 1,
      reason: "error",
      mixed: false,
      sources: [],
      error: { message: "DeepSeek Messages transport failed", code: "TRANSPORT" },
    });
  });

  test("an error reduces to its message and code strings, dropping the rest", async () => {
    const r = await rig();
    const result = await runTurn(r, { kind: "error", error: { message: "boom", code: 42, stack: "trace", cause: { deep: true } } });
    expect(result.error).toEqual({ message: "boom" });
  });

  test("run 4: an aborted turn carries its cause and no error", async () => {
    const r = await rig();
    const result = await runTurn(r, { kind: "aborted", reason: { kind: "user" } });
    expect(result).toEqual({ type: "result", id: "peer-f", turn: 1, reason: "aborted", cause: "user", mixed: false, sources: [] });
  });

  test("the last non-empty assistant text of the turn wins, step line and blank lines removed", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "peer-f", priority: "next" });
    const ours = lastCall(agent)?.message as FakeMessage;
    agent.status = "running";
    agent.inbox.nextTurn = [ours];
    turnStart(r, agent, 1);
    claim(r, agent, ours, 1);
    assistantSays(r, agent, 1, "⏵ Premier titre\n\nPremière réponse");
    assistantSays(r, agent, 1, "⏵ Titre seul\n\n");
    assistantSays(r, agent, 1, "");
    assistantSays(r, agent, 1, "⏵ Deuxième titre\n\n\nLigne 1\nLigne 2");
    turnEnd(r, agent, 1, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")[0]?.text).toBe("Ligne 1\nLigne 2");
  });

  test("a turn without assistant text has no text key", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "peer-f", priority: "next" });
    const ours = lastCall(agent)?.message as FakeMessage;
    agent.status = "running";
    agent.inbox.nextTurn = [ours];
    turnStart(r, agent, 1);
    claim(r, agent, ours, 1);
    turnEnd(r, agent, 1, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")[0]).toEqual({ type: "result", id: "peer-f", turn: 1, reason: "completed", mixed: false, sources: [] });
  });
});

describe("a result is always reported", () => {
  test("a followup claimed for a turn without turn/start is still reported at turn/end", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    claim(r, agent, lastCall(agent)?.message as FakeMessage, 7);
    assistantSays(r, agent, 7, "Réponse tardive");
    turnEnd(r, agent, 7, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")).toEqual([{ type: "result", id: "m1", turn: 7, reason: "completed", mixed: false, sources: [], text: "Réponse tardive" }]);
  });

  test("a followup claimed for a turn older than the open one is still reported", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    agent.status = "running";
    turnStart(r, agent, 5);
    claim(r, agent, lastCall(agent)?.message as FakeMessage, 4);
    turnEnd(r, agent, 4, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")).toEqual([{ type: "result", id: "m1", turn: 4, reason: "completed", mixed: false, sources: [] }]);
  });

  test("a turn/start over a tracked turn whose turn/end was missed closes it as interrupted", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    const ours = lastCall(agent)?.message as FakeMessage;
    agent.status = "running";
    agent.inbox.nextTurn = [ours];
    turnStart(r, agent, 1);
    claim(r, agent, ours, 1);
    claim(r, agent, message("ctx-1", "runtime-context"), 1);
    assistantSays(r, agent, 1, "⏵ Début\n\nRéponse partielle");
    agent.inbox.nextTurn = [];
    turnStart(r, agent, 2);
    turnEnd(r, agent, 2, { kind: "completed" });
    await r.bridge.barrier();
    expect(framesOf(r, "result")).toEqual([
      { type: "result", id: "m1", turn: 1, reason: "interrupted", mixed: false, sources: ["runtime-context"], text: "Réponse partielle" },
    ]);
  });

  test("a turn/end without a readable reason is reported as interrupted", async () => {
    const r = await rig();
    expect((await runTurn(r, {})).reason).toBe("interrupted");
    const other = await rig();
    expect((await runTurn(other, { kind: 12 })).reason).toBe("interrupted");
  });
});

/** Un followup des nôtres suivi d'un tour qui se termine pour `reason`. */
async function runTurn(r: Rig, reason: object): Promise<Frame> {
  const [agent] = r.agents as [FakeAgent];
  await deliver(r, { id: "peer-f", priority: "next" });
  const ours = lastCall(agent)?.message as FakeMessage;
  agent.status = "running";
  agent.inbox.nextTurn = [ours];
  turnStart(r, agent, 1);
  claim(r, agent, ours, 1);
  turnEnd(r, agent, 1, reason);
  await r.bridge.barrier();
  return framesOf(r, "result")[0] as Frame;
}

// --- Pertes ---------------------------------------------------------------------------------------

describe("losses", () => {
  test("discarded without disposed becomes dropped discarded after the grace delay", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    r.ctx.emit("agent/inbox/discarded", { agent, message: lastCall(agent)?.message });
    await r.bridge.barrier();
    expect(framesOf(r, "dropped")).toEqual([]);
    await waitFor(() => framesOf(r, "dropped").length === 1);
    expect(framesOf(r, "dropped")[0]).toEqual({ type: "dropped", id: "m1", why: "discarded" });
  });

  test("discarded then disposed within the delay becomes dropped disposed, never discarded", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    r.ctx.emit("agent/inbox/discarded", { agent, message: lastCall(agent)?.message });
    r.ctx.agents.remove("a1");
    r.ctx.emit("agent/disposed", { agent });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await r.bridge.barrier();
    expect(framesOf(r, "dropped")).toEqual([{ type: "dropped", id: "m1", why: "disposed" }]);
  });

  test("disposed with a followup in the inbox gives dropped disposed immediately followed by a state", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    r.ctx.agents.remove("a1");
    r.ctx.emit("agent/disposed", { agent });
    await r.bridge.barrier();
    const frames = r.bridge.frames;
    const dropIndex = frames.findIndex((frame) => frame.type === "dropped");
    expect(frames[dropIndex]).toEqual({ type: "dropped", id: "m1", why: "disposed" });
    expect(frames[dropIndex + 1]).toEqual({ type: "state", session: null, status: "idle" });
    expect(frames).toHaveLength(dropIndex + 2);
  });

  test("a state follows dropped disposed even when it did not change", async () => {
    const r = await rig({ agents: ["r1", "r2"], serversSession: "r2" });
    const [r1, r2] = r.agents as [FakeAgent, FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    expect(r2.calls).toHaveLength(1);
    // le premier plan passe à r1 avant que r2 ne disparaisse : le dispose ne change plus rien à l'état
    r.pointTo("r1");
    r.ctx.emit("agent/status", { agent: r1, status: "idle" });
    r.ctx.agents.remove("r2");
    r.ctx.emit("agent/disposed", { agent: r2 });
    await r.bridge.barrier();
    const frames = r.bridge.frames;
    const dropIndex = frames.findIndex((frame) => frame.type === "dropped");
    expect(frames[dropIndex]).toEqual({ type: "dropped", id: "m1", why: "disposed" });
    expect(frames[dropIndex + 1]).toEqual({ type: "state", session: "r1", status: "idle" });
    expect(frames[dropIndex - 1]).toEqual({ type: "state", session: "r1", status: "idle" });
  });

  test("dropped no-agent is followed by a state, even unchanged", async () => {
    const r = await rig({ agents: [] });
    const frames = await deliver(r, { id: "m1", priority: "next" });
    expect(frames).toEqual([
      { type: "dropped", id: "m1", why: "no-agent" },
      { type: "state", session: null, status: "idle" },
    ]);
  });

  test("disposed with a tracked open turn reports result disposed with what was collected", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    await deliver(r, { id: "m1", priority: "next" });
    const ours = lastCall(agent)?.message as FakeMessage;
    agent.status = "running";
    agent.inbox.nextTurn = [ours];
    turnStart(r, agent, 3);
    claim(r, agent, ours, 3);
    claim(r, agent, message("ctx-1", "runtime-context"), 3);
    assistantSays(r, agent, 3, "⏵ Début\n\nRéponse partielle");
    r.ctx.agents.remove("a1");
    r.ctx.emit("agent/disposed", { agent });
    await r.bridge.barrier();
    expect(framesOf(r, "result")).toEqual([{ type: "result", id: "m1", turn: 3, reason: "disposed", mixed: false, sources: ["runtime-context"], text: "Réponse partielle" }]);
    expect(framesOf(r, "dropped")).toEqual([]);
  });

  test("a followup that throws is reported as dropped rejected with the exception message", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.failWith.followup = new Error("dsh a refusé le message");
    const frames = await deliver(r, { id: "m1", priority: "next" });
    expect(frames).toEqual([{ type: "dropped", id: "m1", why: "rejected", error: "dsh a refusé le message" }]);
  });

  test("a thrown value whose toString throws still gives dropped rejected", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.failWith.followup = {
      toString() {
        throw new Error("toString piégé");
      },
    };
    const frames = await deliver(r, { id: "m1", priority: "next" });
    expect(frames).toEqual([{ type: "dropped", id: "m1", why: "rejected", error: "erreur inconnue" }]);
  });

  test("a steer that throws is reported as dropped rejected", async () => {
    const r = await rig();
    const [agent] = r.agents as [FakeAgent];
    agent.status = "running";
    agent.inbox.nextTurn = [ROMAIN_TURN_MESSAGE];
    agent.failWith.steer = new Error("steer refusé");
    const frames = await deliver(r, { id: "m1", priority: "now" });
    expect(frames.filter((frame) => frame.type !== "state")).toEqual([{ type: "dropped", id: "m1", why: "rejected", error: "steer refusé" }]);
  });
});

// --- Erreurs --------------------------------------------------------------------------------------

describe("errors never escape and never carry text", () => {
  test("a malformed agent/created event reports listener-failed and does not throw", async () => {
    const r = await rig();
    expect(() => r.ctx.emit("agent/created", undefined)).not.toThrow();
    await r.bridge.barrier();
    expect(framesOf(r, "error")).toEqual([{ type: "error", code: "listener-failed" }]);
  });

  test("each malformed event is contained and reports a fixed code, never a message", async () => {
    const r = await rig();
    const malformed: Array<[string, ...unknown[]]> = [
      ["agent/created", null],
      ["agent/disposed", {}],
      ["agent/inbox/claimed", { agent: null, message: null, turn: 1 }],
      ["agent/inbox/discarded", { agent: {}, message: undefined }],
      ["session/event", null, null],
      ["session/event", undefined, { type: "turn/end", data: { turn: 1 } }],
    ];
    for (const [event, ...args] of malformed) {
      const before = framesOf(r, "error").length;
      expect(() => r.ctx.emit(event, ...args)).not.toThrow();
      await r.bridge.barrier();
      const errors = framesOf(r, "error");
      expect(errors.length, event).toBe(before + 1);
      expect(errors[errors.length - 1]).toEqual({ type: "error", code: "listener-failed" });
    }
  });

  test("an unreadable deliver line answers bad-frame without quoting the input", async () => {
    const r = await rig();
    const before = r.bridge.frames.length;
    r.bridge.sendInvalid({ type: "deliver", id: "m1", priority: "next", sender: "x" }); // text manquant
    r.bridge.sendInvalid({ type: "deliver", id: "m2", priority: "urgent", sender: "x", text: "SECRET-TEXT" });
    await r.bridge.barrier();
    const answers = r.bridge.frames.slice(before);
    expect(answers).toEqual([
      { type: "error", code: "bad-frame" },
      { type: "error", code: "bad-frame" },
    ]);
    expect(JSON.stringify(answers)).not.toContain("SECRET-TEXT");
    expect(r.agents[0]?.calls).toHaveLength(0);
  });

  test("a line that is not JSON answers bad-frame only", async () => {
    const r = await rig();
    const before = r.bridge.frames.length;
    r.bridge.sendInvalid("{not json SECRET-TEXT");
    await r.bridge.barrier();
    const answers = r.bridge.frames.slice(before);
    expect(answers).toEqual([{ type: "error", code: "bad-frame" }]);
    expect(JSON.stringify(answers)).not.toContain("SECRET-TEXT");
  });
});

// --- Fin de vie -----------------------------------------------------------------------------------

describe("disposal", () => {
  /** Relève les minuteurs de période `delays` créés pendant `body`, et ceux qui ont été annulés. */
  async function spyOnTimers(delays: number[], body: (created: Array<{ hasRef(): boolean }>, cleared: Set<unknown>) => Promise<void>): Promise<void> {
    const created: Array<{ hasRef(): boolean }> = [];
    const cleared = new Set<unknown>();
    const real = { setInterval, clearInterval, setTimeout, clearTimeout };
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = real.setInterval(...args);
      if (delays.includes(Number(args[1]))) created.push(handle as unknown as { hasRef(): boolean });
      return handle;
    }) as typeof setInterval;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = real.setTimeout(...args);
      if (delays.includes(Number(args[1]))) created.push(handle as unknown as { hasRef(): boolean });
      return handle;
    }) as typeof setTimeout;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      cleared.add(handle);
      real.clearInterval(handle);
    }) as typeof clearInterval;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(handle);
      real.clearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      await body(created, cleared);
    } finally {
      Object.assign(globalThis, real);
    }
  }

  test("ctx.dispose() closes the connection and clears the refresh timer, which was unreferenced from the start", async () => {
    await spyOnTimers([600_000], async (created, cleared) => {
      const r = await rig();
      expect(created).toHaveLength(1);
      expect(created[0]?.hasRef()).toBe(false);
      r.ctx.dispose();
      await waitFor(() => r.bridge.closedConnections === 1);
      expect(cleared.has(created[0])).toBe(true);
    });
  });

  test("a pending discard timer is unreferenced and cleared on dispose", async () => {
    await spyOnTimers([40], async (created, cleared) => {
      const r = await rig();
      const [agent] = r.agents as [FakeAgent];
      await deliver(r, { id: "m1", priority: "next" });
      r.ctx.emit("agent/inbox/discarded", { agent, message: lastCall(agent)?.message });
      expect(created).toHaveLength(1);
      expect(created[0]?.hasRef()).toBe(false);
      r.ctx.dispose();
      await waitFor(() => r.bridge.closedConnections === 1);
      expect(cleared.has(created[0])).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(framesOf(r, "dropped")).toEqual([]);
    });
  });

  test("the connection is made once and never reopened after it closed", async () => {
    const r = await rig({ config: { refreshMs: 20 } });
    r.ctx.dispose();
    await waitFor(() => r.bridge.closedConnections === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.bridge.connections).toBe(1);
  });
});
