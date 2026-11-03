import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COURIER_EVENT_TYPES, openEventStream, type OpencodeEvent } from "../src/opencode/events.ts";
import { OpencodeHttpError, type ServiceInfo } from "../src/opencode/service.ts";
import { startFakeOpencodeService, type FakeOpencodeService } from "./helpers/fake-opencode-service.ts";

let dir: string;
let fake: FakeOpencodeService | undefined;
let closers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = dir;
});

afterEach(() => {
  for (const close of closers) close();
  closers = [];
  fake?.stop();
  fake = undefined;
  delete process.env.IDNMA_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function serve(): { service: FakeOpencodeService; info: ServiceInfo } {
  const service = startFakeOpencodeService();
  fake = service;
  return { service, info: { url: service.url, pid: process.pid, password: service.password } };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Ouvre le flux et enregistre événements et fermetures. */
async function open(info: ServiceInfo, types: readonly string[] = COURIER_EVENT_TYPES) {
  const events: OpencodeEvent[] = [];
  const closes: unknown[] = [];
  const stream = await openEventStream({
    info,
    types,
    onEvent: (e) => events.push(e),
    onClose: (error) => closes.push(error),
  });
  closers.push(() => stream.close());
  return { stream, events, closes };
}

/** Rejoue des octets par morceaux de 7 : les coupures tombent au milieu des trames et des caractères multi-octets. */
async function emitInChunks(service: FakeOpencodeService, bytes: Uint8Array, size = 7): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    service.emitRaw(bytes.subarray(offset, offset + size));
    await Bun.sleep(4);
  }
}

describe("openEventStream", () => {
  test("replays the captured stream in order, split every 7 bytes, with no event from heartbeats", async () => {
    const { service, info } = serve();
    const { events } = await open(info);
    await emitInChunks(service, readFileSync(join(import.meta.dir, "fixtures", "opencode-sse-raw.txt")));
    await waitFor(() => events.length >= 3, "three events");
    await Bun.sleep(30);
    expect(events.map((e) => e.type)).toEqual(["server.connected", "session.created", "session.deleted"]);
    expect(events[1]?.data.sessionID).toBe("ses_e7bae6e32ffetIyiqgxuXdM4sO");
  });

  test("delivers multi-byte text intact when chunks cut through characters", async () => {
    const { service, info } = serve();
    const { events } = await open(info);
    const text = "réponse « ok » é";
    const frame = `data: ${JSON.stringify({ id: "evt_1", type: "session.text.ended", data: { sessionID: "ses_a", text } })}\n\n`;
    let cutsInsideCharacters = 0;
    // Sept décalages de la trame sous un pas de 7 octets : au moins un découpe un caractère en deux.
    for (let shift = 0; shift < 7; shift++) {
      const bytes = new TextEncoder().encode(`:${"x".repeat(shift)}\n\n${frame}`);
      for (let at = 7; at < bytes.length; at += 7) if (((bytes[at] ?? 0) & 0xc0) === 0x80) cutsInsideCharacters++;
      await emitInChunks(service, bytes);
    }
    expect(cutsInsideCharacters).toBeGreaterThan(0);
    await waitFor(() => events.length >= 7, "seven text events");
    expect(events.map((e) => e.data.text)).toEqual(Array<string>(7).fill(text));
  });

  test("ignores an invalid JSON frame, delivers the next one and logs only its length", async () => {
    const { service, info } = serve();
    const { events } = await open(info);
    service.emitRaw("data: {pas du json\n\n");
    service.emit({ id: "evt_2", type: "session.execution.started", data: { sessionID: "ses_a" } });
    await waitFor(() => events.length >= 1, "the valid event");
    expect(events.map((e) => e.type)).toEqual(["session.execution.started"]);
    const lines = readFileSync(join(dir, "logs", "idnma.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const invalid = lines.filter((l) => l.event === "opencode-event-invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.length).toBe("{pas du json".length);
    expect(JSON.stringify(invalid[0])).not.toContain("pas du json");
  });

  test("ignores a frame without a data line", async () => {
    const { service, info } = serve();
    const { events } = await open(info);
    service.emitRaw("id: 5\n\n");
    service.emit({ id: "evt_3", type: "session.step.ended", data: {} });
    await waitFor(() => events.length >= 1, "the event after the empty frame");
    expect(events.map((e) => e.type)).toEqual(["session.step.ended"]);
  });

  test("requests the stream with repeated types parameters and Basic auth", async () => {
    const { service, info } = serve();
    await open(info, COURIER_EVENT_TYPES);
    const request = service.requests.find((r) => r.path === "/api/event");
    expect(request?.method).toBe("GET");
    const types = request?.query.getAll("types") ?? [];
    expect(types).toContain("session.execution.started");
    expect(types).toContain("session.text.ended");
    expect(types).toEqual([...COURIER_EVENT_TYPES]);
    // Le faux service répond 401 sans l'en-tête Basic attendu : l'ouverture réussie le prouve.
    expect(service.openStreams()).toBe(1);
  });

  test("calls onClose once when the server drops the stream", async () => {
    const { service, info } = serve();
    const { closes } = await open(info);
    service.dropStreams();
    await waitFor(() => closes.length >= 1, "onClose");
    await Bun.sleep(30);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeUndefined();
  });

  test("never calls onClose after close()", async () => {
    const { service, info } = serve();
    const { stream, closes } = await open(info);
    stream.close();
    service.dropStreams();
    await Bun.sleep(80);
    expect(closes).toHaveLength(0);
    await waitFor(() => service.openStreams() === 0, "the server to see the stream gone");
  });

  test("keeps reading when onEvent throws", async () => {
    const { service, info } = serve();
    const seen: string[] = [];
    const stream = await openEventStream({
      info,
      types: COURIER_EVENT_TYPES,
      onEvent: (e) => {
        seen.push(e.type);
        if (seen.length === 1) throw new Error("handler failed");
      },
      onClose: () => {},
    });
    closers.push(() => stream.close());
    service.emit({ id: "evt_4", type: "session.step.ended", data: {} });
    service.emit({ id: "evt_5", type: "session.text.ended", data: {} });
    await waitFor(() => seen.length >= 2, "both events");
    expect(seen).toEqual(["session.step.ended", "session.text.ended"]);
  });

  test("rejects with an OpencodeHttpError carrying status 401 on a wrong password", async () => {
    const { info } = serve();
    const error = await openEventStream({
      info: { ...info, password: "pw-wrong-not-secret" },
      types: COURIER_EVENT_TYPES,
      onEvent: () => {},
      onClose: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(401);
  });

  test("rejects with status 0 when the service is unreachable", async () => {
    const { info } = serve();
    fake?.stop();
    const error = await openEventStream({ info, types: COURIER_EVENT_TYPES, onEvent: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
  });
});
