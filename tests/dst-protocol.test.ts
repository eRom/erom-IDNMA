import { describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  createLineReader,
  encodeFrame,
  parseCourierFrame,
  parsePluginFrame,
} from "../src/bridge/protocol.ts";

function collect(): { lines: string[]; overflows: number; read: (chunk: Buffer) => void } {
  const state = { lines: [] as string[], overflows: 0, read: (_chunk: Buffer) => {} };
  state.read = createLineReader(
    (line) => state.lines.push(line),
    () => {
      state.overflows += 1;
    },
  );
  return state;
}

describe("encodeFrame", () => {
  test("writes one JSON object followed by a newline", () => {
    const encoded = encodeFrame({ type: "error", code: "bad-frame" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.indexOf("\n")).toBe(encoded.length - 1);
    expect(JSON.parse(encoded)).toEqual({ type: "error", code: "bad-frame" });
  });

  test("keeps a newline inside a string on one line", () => {
    const encoded = encodeFrame({ type: "deliver", text: "a\nb" });
    expect(encoded.split("\n").length).toBe(2);
    expect(JSON.parse(encoded).text).toBe("a\nb");
  });

  test("exposes the protocol constants", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
    expect(MAX_FRAME_BYTES).toBeGreaterThan(1024);
  });
});

describe("createLineReader", () => {
  test("splits two frames arriving in one packet", () => {
    const r = collect();
    r.read(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles a frame split across three packets", () => {
    const r = collect();
    r.read(Buffer.from('{"a":'));
    r.read(Buffer.from('"x'));
    expect(r.lines).toEqual([]);
    r.read(Buffer.from('y"}\n'));
    expect(r.lines).toEqual(['{"a":"xy"}']);
  });

  test("keeps a multi-byte character cut between two packets whole", () => {
    const r = collect();
    const bytes = Buffer.from('{"t":"é€😀"}\n');
    for (const byte of bytes) r.read(Buffer.from([byte]));
    expect(r.lines).toEqual(['{"t":"é€😀"}']);
  });

  test("holds a partial line until its newline arrives", () => {
    const r = collect();
    r.read(Buffer.from('{"a":1}\n{"b"'));
    expect(r.lines).toEqual(['{"a":1}']);
    r.read(Buffer.from(":2}\n"));
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("calls onOverflow when a line exceeds the limit without a newline", () => {
    const r = collect();
    r.read(Buffer.alloc(MAX_FRAME_BYTES, 0x61));
    expect(r.overflows).toBe(0);
    r.read(Buffer.alloc(1, 0x61));
    expect(r.overflows).toBeGreaterThanOrEqual(1);
    expect(r.lines).toEqual([]);
  });

  test("a long line that ends within the limit is not an overflow", () => {
    const r = collect();
    r.read(Buffer.alloc(MAX_FRAME_BYTES - 1, 0x61));
    r.read(Buffer.from("\n"));
    expect(r.overflows).toBe(0);
    expect(r.lines.length).toBe(1);
  });
});

describe("parsePluginFrame", () => {
  test("accepts a hello and keeps only the tui version", () => {
    expect(parsePluginFrame('{"type":"hello","v":1,"token":"bridge-token-test","pid":42,"versions":{"tui":"1.2.3","other":"x"}}')).toEqual({
      type: "hello",
      v: 1,
      token: "bridge-token-test",
      pid: 42,
      versions: { tui: "1.2.3" },
    });
    expect(parsePluginFrame('{"type":"hello","v":1,"token":"t","pid":42,"versions":{}}')).toEqual({
      type: "hello",
      v: 1,
      token: "t",
      pid: 42,
      versions: {},
    });
  });

  test("accepts a state with or without a session", () => {
    expect(parsePluginFrame('{"type":"state","session":"s1","status":"running"}')).toEqual({ type: "state", session: "s1", status: "running" });
    expect(parsePluginFrame('{"type":"state","session":null,"status":"idle"}')).toEqual({ type: "state", session: null, status: "idle" });
  });

  test("accepts delivered and claimed", () => {
    expect(parsePluginFrame('{"type":"delivered","id":"m1","mode":"steer","session":"s1"}')).toEqual({
      type: "delivered",
      id: "m1",
      mode: "steer",
      session: "s1",
    });
    expect(parsePluginFrame('{"type":"claimed","id":"m1","turn":3}')).toEqual({ type: "claimed", id: "m1", turn: 3 });
  });

  test("accepts a minimal result and a full one", () => {
    expect(parsePluginFrame('{"type":"result","id":"m1","turn":3,"reason":"completed","mixed":false,"sources":[]}')).toEqual({
      type: "result",
      id: "m1",
      turn: 3,
      reason: "completed",
      mixed: false,
      sources: [],
    });
    expect(
      parsePluginFrame(
        '{"type":"result","id":"m1","turn":4,"reason":"aborted","cause":"user","mixed":true,"sources":["user","none"],"text":"Paris","error":{"message":"boom","code":"TRANSPORT"}}',
      ),
    ).toEqual({
      type: "result",
      id: "m1",
      turn: 4,
      reason: "aborted",
      cause: "user",
      mixed: true,
      sources: ["user", "none"],
      text: "Paris",
      error: { message: "boom", code: "TRANSPORT" },
    });
  });

  test("reduces a result error carrying other fields to message and code", () => {
    const frame = parsePluginFrame(
      '{"type":"result","id":"m1","turn":1,"reason":"error","mixed":false,"sources":[],"error":{"message":"boom","code":"X","stack":"secret","status":500}}',
    );
    expect(frame).toMatchObject({ type: "result", error: { message: "boom", code: "X" } });
    expect(Object.keys((frame as { error: object }).error).sort()).toEqual(["code", "message"]);
    const partial = parsePluginFrame('{"type":"result","id":"m1","turn":1,"reason":"error","mixed":false,"sources":[],"error":{"code":"X","message":7}}');
    expect(partial).toMatchObject({ error: { code: "X" } });
    expect(Object.keys((partial as { error: object }).error)).toEqual(["code"]);
  });

  test("accepts every dropped reason and rejects an unknown one", () => {
    for (const why of ["discarded", "disposed", "no-agent", "rejected"] as const) {
      expect(parsePluginFrame(`{"type":"dropped","id":"m1","why":"${why}"}`)).toEqual({ type: "dropped", id: "m1", why });
    }
    expect(parsePluginFrame('{"type":"dropped","id":"m1","why":"rejected","error":"nope"}')).toEqual({
      type: "dropped",
      id: "m1",
      why: "rejected",
      error: "nope",
    });
    expect(parsePluginFrame('{"type":"dropped","id":"m1","why":"mystery"}')).toBeUndefined();
  });

  test("accepts an error frame", () => {
    expect(parsePluginFrame('{"type":"error","code":"register-failed"}')).toEqual({ type: "error", code: "register-failed" });
  });

  test("ignores unknown keys", () => {
    expect(parsePluginFrame('{"type":"claimed","id":"m1","turn":3,"future":{"a":1}}')).toEqual({ type: "claimed", id: "m1", turn: 3 });
    expect(parsePluginFrame('{"type":"state","session":null,"status":"idle","extra":true}')).toEqual({ type: "state", session: null, status: "idle" });
  });

  test("rejects a missing or mistyped required field", () => {
    const bad = [
      '{"type":"hello","v":1,"pid":42,"versions":{}}',
      '{"type":"hello","v":"1","token":"t","pid":42,"versions":{}}',
      '{"type":"hello","v":1,"token":"t","pid":42}',
      '{"type":"state","status":"idle"}',
      '{"type":"state","session":"s1","status":"sleeping"}',
      '{"type":"delivered","id":"m1","mode":"wait","session":"s1"}',
      '{"type":"delivered","id":"m1","mode":"steer"}',
      '{"type":"claimed","id":"m1"}',
      '{"type":"claimed","id":7,"turn":1}',
      '{"type":"result","id":"m1","turn":1,"reason":"completed","sources":[]}',
      '{"type":"result","id":"m1","turn":1,"reason":"completed","mixed":false,"sources":[1]}',
      '{"type":"result","id":"m1","turn":1,"reason":"completed","mixed":false}',
      '{"type":"dropped","why":"disposed"}',
      '{"type":"error"}',
      '{"type":"error","code":4}',
    ];
    for (const line of bad) expect(parsePluginFrame(line)).toBeUndefined();
  });

  test("rejects an unknown type and unreadable input", () => {
    expect(parsePluginFrame('{"type":"deliver","id":"m1","priority":"now","sender":"a","text":"x"}')).toBeUndefined();
    expect(parsePluginFrame('{"type":"mystery"}')).toBeUndefined();
    expect(parsePluginFrame("not json")).toBeUndefined();
    expect(parsePluginFrame("")).toBeUndefined();
    expect(parsePluginFrame("[1,2]")).toBeUndefined();
    expect(parsePluginFrame("null")).toBeUndefined();
    expect(parsePluginFrame('"hello"')).toBeUndefined();
  });
});

describe("parseCourierFrame", () => {
  test("accepts a deliver with and without a hint", () => {
    expect(parseCourierFrame('{"type":"deliver","id":"m1","priority":"next","sender":"claude-ceres","text":"bonjour"}')).toEqual({
      type: "deliver",
      id: "m1",
      priority: "next",
      sender: "claude-ceres",
      text: "bonjour",
    });
    expect(parseCourierFrame('{"type":"deliver","id":"m1","priority":"now","sender":"a","text":"x","hint":"(idnma) ...","future":1}')).toEqual({
      type: "deliver",
      id: "m1",
      priority: "now",
      sender: "a",
      text: "x",
      hint: "(idnma) ...",
    });
  });

  test("rejects an unknown priority, a missing field and a foreign type", () => {
    expect(parseCourierFrame('{"type":"deliver","id":"m1","priority":"asap","sender":"a","text":"x"}')).toBeUndefined();
    expect(parseCourierFrame('{"type":"deliver","id":"m1","priority":"now","text":"x"}')).toBeUndefined();
    expect(parseCourierFrame('{"type":"deliver","id":"m1","priority":"now","sender":"a","text":"x","hint":3}')).toBeUndefined();
    expect(parseCourierFrame('{"type":"state","session":null,"status":"idle"}')).toBeUndefined();
    expect(parseCourierFrame("garbage")).toBeUndefined();
  });
});
