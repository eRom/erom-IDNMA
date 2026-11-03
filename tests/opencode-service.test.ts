import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasModel, parseModelRef } from "../src/opencode/model.ts";
import { createOpencodeClient, ensureService, OpencodeHttpError, readServiceInfo, type ServiceInfo } from "../src/opencode/service.ts";
import { startFakeOpencodeService, type FakeOpencodeService } from "./helpers/fake-opencode-service.ts";

let dir: string;
let fake: FakeOpencodeService | undefined;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = dir;
});

afterEach(() => {
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

describe("parseModelRef", () => {
  test("splits provider and model at the first slash", () => {
    expect(parseModelRef("opencode/big-pickle")).toEqual({ providerID: "opencode", id: "big-pickle" });
  });

  test("keeps later slashes in the model id and reads the variant after the last hash", () => {
    expect(parseModelRef("openrouter/particle-ai/particle-1#high")).toEqual({
      providerID: "openrouter",
      id: "particle-ai/particle-1",
      variant: "high",
    });
  });

  test("rejects a reference without slash or with an empty part", () => {
    expect(parseModelRef("big-pickle")).toBeUndefined();
    expect(parseModelRef("/x")).toBeUndefined();
    expect(parseModelRef("x/")).toBeUndefined();
    expect(parseModelRef("x/y#")).toBeUndefined();
  });
});

describe("hasModel", () => {
  const models = [{ providerID: "ollama-cloud", id: "deepseek-v4.1-flash", variants: [{ id: "low" }, { id: "high" }] }];

  test("accepts a missing, default or listed variant", () => {
    expect(hasModel(models, { providerID: "ollama-cloud", id: "deepseek-v4.1-flash" })).toBe(true);
    expect(hasModel(models, { providerID: "ollama-cloud", id: "deepseek-v4.1-flash", variant: "default" })).toBe(true);
    expect(hasModel(models, { providerID: "ollama-cloud", id: "deepseek-v4.1-flash", variant: "high" })).toBe(true);
  });

  test("rejects an unknown variant, model or provider", () => {
    expect(hasModel(models, { providerID: "ollama-cloud", id: "deepseek-v4.1-flash", variant: "turbo" })).toBe(false);
    expect(hasModel(models, { providerID: "other", id: "deepseek-v4.1-flash" })).toBe(false);
    expect(hasModel(models, { providerID: "ollama-cloud", id: "nope" })).toBe(false);
  });

  test("rejects a non-default variant on a model without variants", () => {
    expect(hasModel([{ providerID: "p", id: "m" }], { providerID: "p", id: "m", variant: "high" })).toBe(false);
  });
});

describe("readServiceInfo", () => {
  test("returns undefined for a missing file, invalid JSON or a missing field", () => {
    expect(readServiceInfo(join(dir, "absent.json"))).toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(readServiceInfo(join(dir, "bad.json"))).toBeUndefined();
    writeFileSync(join(dir, "partial.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 1 }));
    expect(readServiceInfo(join(dir, "partial.json"))).toBeUndefined();
  });

  test("reads url, pid and password", () => {
    const { service } = serve();
    service.writeServiceFile(join(dir, "service.json"), 4242);
    expect(readServiceInfo(join(dir, "service.json"))).toEqual({ url: service.url, pid: 4242, password: service.password });
  });

  test("defaults to the file of IDNMA_OPENCODE_SERVICE_FILE", () => {
    const { service } = serve();
    process.env.IDNMA_OPENCODE_SERVICE_FILE = join(dir, "svc.json");
    try {
      service.writeServiceFile(join(dir, "svc.json"));
      expect(readServiceInfo()?.url).toBe(service.url);
    } finally {
      delete process.env.IDNMA_OPENCODE_SERVICE_FILE;
    }
  });
});

describe("ensureService", () => {
  const info: ServiceInfo = { url: "http://127.0.0.1:1", pid: 123, password: "pw-test-not-secret" };

  test("returns a readable file with a live pid without starting anything", async () => {
    let starts = 0;
    const got = await ensureService({ read: () => info, isAlive: () => true, start: () => void starts++ });
    expect(got).toEqual(info);
    expect(starts).toBe(0);
  });

  test("starts the service once when the pid is dead, then returns the rewritten file", async () => {
    let starts = 0;
    let current: ServiceInfo | undefined = info;
    const fresh: ServiceInfo = { ...info, pid: 456 };
    const got = await ensureService({
      read: () => current,
      isAlive: (pid) => pid === 456,
      start: () => {
        starts++;
        current = fresh;
      },
      sleep: async () => {},
    });
    expect(got).toEqual(fresh);
    expect(starts).toBe(1);
  });

  test("starts the service when the file is missing", async () => {
    let current: ServiceInfo | undefined;
    const got = await ensureService({
      read: () => current,
      isAlive: () => true,
      start: () => {
        current = info;
      },
      sleep: async () => {},
    });
    expect(got).toEqual(info);
  });

  test("waits through a stale file until the pid it names is alive", async () => {
    let reads = 0;
    const fresh: ServiceInfo = { ...info, pid: 456 };
    const got = await ensureService({
      read: () => (++reads < 4 ? info : fresh),
      isAlive: (pid) => pid === 456,
      start: () => {},
      sleep: async () => {},
    });
    expect(got).toEqual(fresh);
  });

  test("gives up with undefined after timeoutMs of injected sleeps", async () => {
    let starts = 0;
    const sleeps: number[] = [];
    const got = await ensureService({
      read: () => undefined,
      isAlive: () => false,
      start: () => void starts++,
      sleep: async (ms) => void sleeps.push(ms),
      timeoutMs: 1000,
    });
    expect(got).toBeUndefined();
    expect(starts).toBe(1);
    expect(sleeps.every((ms) => ms === 200)).toBe(true);
    expect(sleeps.length).toBe(5);
  });
});

describe("createOpencodeClient", () => {
  test("sends Basic opencode:<password> and reads /api/info without envelope", async () => {
    const { service, info } = serve();
    const received: Array<string | null> = [];
    service.handle("GET", "/api/info", (req) => {
      received.push(req.authorization);
      return { status: 200, body: { version: "2.2.0", pid: 1, urls: [] } };
    });
    expect(await createOpencodeClient(info).info()).toEqual({ version: "2.2.0" });
    expect(received).toEqual(["Basic " + Buffer.from("opencode:pw-test-not-secret").toString("base64")]);
  });

  test("a wrong password raises OpencodeHttpError 401 with the tag", async () => {
    const { info } = serve();
    const client = createOpencodeClient({ ...info, password: "pw-wrong-not-secret" });
    const error = await client.info().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(401);
    expect((error as OpencodeHttpError).tag).toBe("UnauthorizedError");
    expect((error as OpencodeHttpError).message).toContain("Authentication required");
  });

  test("getSession returns undefined on 404 and the session otherwise", async () => {
    const { service, info } = serve();
    const client = createOpencodeClient(info);
    expect(await client.getSession("ses_missing")).toBeUndefined();
    service.handle("GET", "/api/session/ses_a", () => ({
      status: 200,
      body: { data: { id: "ses_a", parentID: "ses_p", model: { providerID: "opencode", id: "big-pickle", variant: "default" } } },
    }));
    expect(await client.getSession("ses_a")).toMatchObject({ id: "ses_a", parentID: "ses_p", model: { providerID: "opencode", id: "big-pickle" } });
  });

  test("prompt on an unknown session raises 404 with the SessionNotFoundError tag", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session/ses_x/prompt", () => ({
      status: 404,
      body: { _tag: "SessionNotFoundError", sessionID: "ses_x", message: "Session not found: ses_x" },
    }));
    const error = await createOpencodeClient(info)
      .prompt("ses_x", { text: "hi", delivery: "queue", metadata: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(404);
    expect((error as OpencodeHttpError).tag).toBe("SessionNotFoundError");
    expect((error as OpencodeHttpError).message).toContain("Session not found: ses_x");
  });

  test("prompt sends text, delivery and metadata and returns the inbox id", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session/ses_a/prompt", () => ({ status: 200, body: { data: { id: "msg_inbox1", sessionID: "ses_a" } } }));
    const got = await createOpencodeClient(info).prompt("ses_a", {
      text: "hello",
      delivery: "steer",
      metadata: { idnma: { from: "peer", msgId: "m-1" } },
    });
    expect(got).toEqual({ inboxID: "msg_inbox1" });
    expect(service.requests.at(-1)?.body).toEqual({ text: "hello", delivery: "steer", metadata: { idnma: { from: "peer", msgId: "m-1" } } });
  });

  test("createSession sends exactly location and model, and omits model when absent", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session", () => ({ status: 200, body: { data: { id: "ses_new" } } }));
    const client = createOpencodeClient(info);
    const session = await client.createSession({ directory: "/w", model: { providerID: "opencode", id: "big-pickle" } });
    expect(session.id).toBe("ses_new");
    expect(service.requests.at(-1)?.body).toEqual({ location: { directory: "/w" }, model: { providerID: "opencode", id: "big-pickle" } });
    await client.createSession({ directory: "/w" });
    expect(service.requests.at(-1)?.body).toEqual({ location: { directory: "/w" } });
    expect(Object.keys(service.requests.at(-1)?.body as object)).not.toContain("model");
    await client.createSession({ id: "ses_chosen", directory: "/w" });
    expect(service.requests.at(-1)?.body).toEqual({ location: { directory: "/w" }, id: "ses_chosen" });
  });

  test("listSessions queries directory and order=desc", async () => {
    const { service, info } = serve();
    service.handle("GET", "/api/session", () => ({ status: 200, body: { data: [{ id: "ses_1" }, { id: "ses_2" }], cursor: {} } }));
    const sessions = await createOpencodeClient(info).listSessions("/w");
    expect(sessions.map((s) => s.id)).toEqual(["ses_1", "ses_2"]);
    const query = service.requests.at(-1)?.query;
    expect(query?.get("directory")).toBe("/w");
    expect(query?.get("order")).toBe("desc");
  });

  test("listModels queries location[directory] and returns the data array", async () => {
    const { service, info } = serve();
    service.handle("GET", "/api/model", () => ({
      status: 200,
      body: { data: [{ id: "m", modelID: "m", providerID: "p", variants: [{ id: "high", settings: {} }] }] },
    }));
    const models = await createOpencodeClient(info).listModels("/w");
    expect(service.requests.at(-1)?.query.get("location[directory]")).toBe("/w");
    expect(models).toHaveLength(1);
    expect(models[0]?.variants?.[0]?.id).toBe("high");
  });

  test("switchModel posts { model } to /model", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session/ses_a/model", () => ({ status: 204 }));
    await createOpencodeClient(info).switchModel("ses_a", { providerID: "opencode", id: "big-pickle", variant: "high" });
    expect(service.requests.at(-1)?.body).toEqual({ model: { providerID: "opencode", id: "big-pickle", variant: "high" } });
  });

  test("cancelInbox sends DELETE on the inbox item", async () => {
    const { service, info } = serve();
    service.handle("DELETE", "/api/session/ses_a/inbox/msg_i1", () => ({ status: 204 }));
    await createOpencodeClient(info).cancelInbox("ses_a", "msg_i1");
    expect(service.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/session/ses_a/inbox/msg_i1" });
  });

  test("activeSessions returns the keys of data", async () => {
    const { service, info } = serve();
    const client = createOpencodeClient(info);
    service.handle("GET", "/api/session/active", () => ({ status: 200, body: { data: {} } }));
    expect(await client.activeSessions()).toEqual(new Set());
    service.handle("GET", "/api/session/active", () => ({ status: 200, body: { data: { ses_a: { type: "running" }, ses_b: { type: "running" } } } }));
    expect(await client.activeSessions()).toEqual(new Set(["ses_a", "ses_b"]));
  });

  test("a non-2xx without JSON body raises with no tag", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session/ses_a/model", () => ({ status: 500 }));
    const error = await createOpencodeClient(info)
      .switchModel("ses_a", { providerID: "p", id: "m" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(500);
    expect((error as OpencodeHttpError).tag).toBeUndefined();
    expect((error as OpencodeHttpError).serviceMessage).toBeUndefined();
  });

  test("keeps the message field of the error body on its own, without method or path", async () => {
    const { service, info } = serve();
    service.handle("POST", "/api/session/ses_a/model", () => ({ status: 500, body: { message: "service en panne" } }));
    const error = await createOpencodeClient(info)
      .switchModel("ses_a", { providerID: "p", id: "m" })
      .catch((e: unknown) => e);
    expect((error as OpencodeHttpError).serviceMessage).toBe("service en panne");
    expect((error as OpencodeHttpError).message).toContain("POST /api/session/ses_a/model");
  });

  test("a service that never answers raises status 0 within a second", async () => {
    const { service, info } = serve();
    service.handle("GET", "/api/info", () => new Promise(() => {}));
    const started = Date.now();
    const error = await createOpencodeClient(info, { requestTimeoutMs: 50 })
      .info()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a refused connection raises status 0", async () => {
    const { service, info } = serve();
    service.stop();
    const error = await createOpencodeClient(info)
      .info()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
  });
});
