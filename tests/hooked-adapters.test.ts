import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agyAdapter, agyFinalAnswer } from "../src/hooked/agy.ts";
import { grokAdapter } from "../src/hooked/grok.ts";
import { DOORBELL_BYTES } from "../src/hooked/signals.ts";

const FIXTURES = "tests/fixtures/hooks";
const TRANSCRIPT = `${FIXTURES}/agy-transcript-doorbell-turn.jsonl`;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}.json`, "utf8")) as Record<string, unknown>;
}

let tmp: string;
const savedConfigDir = process.env.IDNMA_CONFIG_DIR;

beforeEach(() => {
  tmp = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(tmp, "config");
  mkdirSync(process.env.IDNMA_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = savedConfigDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("grok adapter", () => {
  test("grok doorbell prompt is a turn start that cannot deliver", () => {
    const signal = grokAdapter.signal("UserPromptSubmit", fixture("grok-user-prompt-submit-doorbell"));
    expect(signal).toMatchObject({ kind: "turn-start", prompt: "📨 idnma read", canDeliver: false });
  });

  test("grok end_turn stop carries the final answer", () => {
    const signal = grokAdapter.signal("Stop", fixture("grok-stop-end-turn"));
    expect(signal.kind).toBe("turn-end");
    if (signal.kind !== "turn-end") throw new Error("unexpected signal");
    expect(signal.outcome).toBe("completed");
    expect(signal.reliableIdle).toBe(true);
    expect(signal.answer).toBe("MANGUE-42");
    expect(grokAdapter.finalAnswer(signal)).toBe("MANGUE-42");
  });

  test("grok shutdown stop is ignored", () => {
    expect(grokAdapter.signal("Stop", fixture("grok-stop-shutdown"))).toEqual({ kind: "ignore" });
  });

  test("grok tool events and notifications", () => {
    expect(grokAdapter.signal("PreToolUse", fixture("grok-pre-tool-use")).kind).toBe("busy");
    expect(grokAdapter.signal("PostToolUse", fixture("grok-post-tool-use")).kind).toBe("mid-turn");
    expect(grokAdapter.signal("PostToolUseFailure", fixture("grok-post-tool-use")).kind).toBe("mid-turn");
    expect(grokAdapter.signal("SessionStart", fixture("grok-session-start")).kind).toBe("session-start");
    expect(grokAdapter.signal("Notification", fixture("grok-notification-idle")).kind).toBe("idle");
    expect(grokAdapter.signal("Notification", { notificationType: "permission_prompt" }).kind).toBe("busy");
    expect(grokAdapter.signal("Notification", { notificationType: "auth_required" })).toEqual({ kind: "unknown", reason: "auth_required" });
    // Le type part au journal : un libellé libre y est remplacé.
    expect(grokAdapter.signal("Notification", { notificationType: "Mot de passe : hunter2" })).toEqual({ kind: "unknown", reason: "other" });
    expect(grokAdapter.signal("Notification", {})).toEqual({ kind: "unknown" });
    expect(grokAdapter.signal("SomethingElse", {}).kind).toBe("ignore");
    expect(grokAdapter.signal("StopCancelled", {})).toMatchObject({
      kind: "turn-end",
      outcome: "interrupted",
      reliableIdle: false,
    });
    expect(grokAdapter.signal("StopFailure", { error: "rate_limit" })).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      reliableIdle: false,
      detail: "rate_limit",
    });
    expect(grokAdapter.signal("StopFailure", { error: "rate_limit", errorDetails: "429 too many" })).toMatchObject({
      detail: "429 too many",
    });
  });

  test("grok subagent events are ignored", () => {
    const post = { ...fixture("grok-post-tool-use"), subagentType: "explore" };
    const stop = { ...fixture("grok-stop-end-turn"), subagentType: "explore" };
    expect(grokAdapter.signal("PostToolUse", post)).toEqual({ kind: "ignore" });
    expect(grokAdapter.signal("Stop", stop)).toEqual({ kind: "ignore" });
  });

  test("grok permission_prompt is busy even from a subagent, other subagent notifications stay ignored", () => {
    const permission = { notificationType: "permission_prompt", subagentType: "explore" };
    expect(grokAdapter.signal("Notification", permission).kind).toBe("busy");
    expect(grokAdapter.signal("Notification", { ...fixture("grok-notification-idle"), subagentType: "explore" })).toEqual({
      kind: "ignore",
    });
    expect(grokAdapter.signal("Notification", { notificationType: "other", subagentType: "explore" })).toEqual({
      kind: "ignore",
    });
  });

  test("grok end_turn with background tasks is not a reliable rest", () => {
    const busy = grokAdapter.signal("Stop", { ...fixture("grok-stop-end-turn"), backgroundTasks: [{ id: "bg-1" }] });
    expect(busy).toMatchObject({ kind: "turn-end", outcome: "completed", reliableIdle: false });
    const clean = grokAdapter.signal("Stop", { ...fixture("grok-stop-end-turn"), backgroundTasks: [] });
    expect(clean).toMatchObject({ kind: "turn-end", reliableIdle: true });
    const absent = fixture("grok-stop-end-turn");
    delete absent.backgroundTasks;
    expect(grokAdapter.signal("Stop", absent)).toMatchObject({ kind: "turn-end", reliableIdle: true });
  });

  test("grok signals carry the session id as conversation id", () => {
    const sessionId = fixture("grok-stop-end-turn").sessionId as string;
    expect(grokAdapter.signal("SessionStart", fixture("grok-session-start")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("UserPromptSubmit", fixture("grok-user-prompt-submit-doorbell")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("PreToolUse", fixture("grok-pre-tool-use")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("PostToolUse", fixture("grok-post-tool-use")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("Stop", fixture("grok-stop-end-turn")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("Notification", fixture("grok-notification-idle")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("StopCancelled", fixture("grok-stop-end-turn")).conversationId).toBe(sessionId);
    expect(grokAdapter.signal("Notification", { notificationType: "idle_prompt" })).not.toHaveProperty("conversationId");
  });

  test("grok turn signals carry the promptId", () => {
    const submit = fixture("grok-user-prompt-submit-doorbell");
    const stop = fixture("grok-stop-end-turn");
    expect(grokAdapter.signal("UserPromptSubmit", submit).promptId).toBe(submit.promptId as string);
    expect(grokAdapter.signal("Stop", stop).promptId).toBe(stop.promptId as string);
  });
});

describe("agy adapter", () => {
  test("agy doorbell invocation is a turn start that can deliver", () => {
    const payload = fixture("agy-pre-invocation-doorbell");
    const signal = agyAdapter.signal("PreInvocation", payload);
    expect(signal).toMatchObject({ kind: "turn-start", prompt: "📨 idnma read", canDeliver: true });
    expect(signal.conversationId).toBe(payload.conversationId as string);
  });

  test("agy later invocation is mid-turn", () => {
    expect(agyAdapter.signal("PreInvocation", fixture("agy-pre-invocation-after-injection")).kind).toBe("mid-turn");
    expect(agyAdapter.signal("SessionStart", fixture("agy-session-start")).kind).toBe("busy");
    expect(agyAdapter.signal("PostToolUse", fixture("agy-post-tool-use")).kind).toBe("ignore");
  });

  test("agy stop maps termination reasons", () => {
    const stop = agyAdapter.signal("Stop", fixture("agy-stop-doorbell-turn"));
    expect(stop).toMatchObject({ kind: "turn-end", outcome: "completed", reliableIdle: true });
    expect(typeof (stop as { transcriptPath?: unknown }).transcriptPath).toBe("string");
    expect(stop.conversationId).toBe(fixture("agy-stop-doorbell-turn").conversationId as string);

    for (const terminationReason of ["TERMINAL_STEP_TYPE", "INJECTED_RESPONSE", "TERMINAL_CUSTOM_HOOK"]) {
      expect(agyAdapter.signal("Stop", { terminationReason, fullyIdle: true })).toMatchObject({
        kind: "turn-end",
        outcome: "completed",
        reliableIdle: false,
      });
    }
    expect(agyAdapter.signal("Stop", { terminationReason: "NO_TOOL_CALL", fullyIdle: false })).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      reliableIdle: false,
    });
    expect(agyAdapter.signal("Stop", { terminationReason: "USER_CANCELED" })).toMatchObject({
      kind: "turn-end",
      outcome: "interrupted",
      reliableIdle: false,
    });
    expect(agyAdapter.signal("Stop", { terminationReason: "ERROR", error: "quota" })).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      reliableIdle: false,
      detail: "quota",
    });
    expect(agyAdapter.signal("Stop", { terminationReason: "ERROR", error: "" })).toMatchObject({
      outcome: "failed",
      detail: "ERROR",
    });
  });

  test("agy stop without a termination reason has no detail", () => {
    const bare = agyAdapter.signal("Stop", {});
    expect(bare).toMatchObject({ kind: "turn-end", outcome: "failed", reliableIdle: false });
    expect(bare).not.toHaveProperty("detail");
    expect(agyAdapter.signal("Stop", { error: "", terminationReason: "" })).not.toHaveProperty("detail");
    expect(agyAdapter.signal("Stop", { error: "quota" })).toMatchObject({ detail: "quota" });
  });

  test("agy mid-turn invocations carry the last user input", () => {
    const payload = fixture("agy-pre-invocation-after-injection");
    expect(agyAdapter.signal("PreInvocation", payload)).toMatchObject({
      kind: "mid-turn",
      userInput: payload.lastUserInput as string,
    });
    expect(agyAdapter.signal("PreInvocation", { ...payload, lastUserInput: "" })).not.toHaveProperty("userInput");
  });

  test("agy final answer is read from the transcript", () => {
    expect(agyFinalAnswer(TRANSCRIPT)).toBe("MANGUE-42\nKIWI-17");
    const end = agyAdapter.signal("Stop", { ...fixture("agy-stop-doorbell-turn"), transcriptPath: TRANSCRIPT });
    if (end.kind !== "turn-end") throw new Error("unexpected signal");
    expect(agyAdapter.finalAnswer(end)).toBe("MANGUE-42\nKIWI-17");
  });

  test("agy final answer skips an unreadable line", () => {
    const lines = readFileSync(TRANSCRIPT, "utf8").split("\n").filter((line) => line !== "");
    const last = lines.pop() as string;
    const path = join(tmp, "broken.jsonl");
    writeFileSync(path, [...lines, "{coupée", last].join("\n") + "\n");
    expect(agyFinalAnswer(path)).toBe("MANGUE-42\nKIWI-17");
  });

  test("agy final answer never returns a previous turn's answer", () => {
    const lines = readFileSync(TRANSCRIPT, "utf8").split("\n").filter((line) => line !== "");
    // Le step 3 porte une réponse non vide, mais elle précède la dernière entrée utilisateur explicite.
    expect(JSON.parse(lines[3] as string).content).toBeTruthy();
    const path = join(tmp, "partial.jsonl");
    writeFileSync(path, lines.slice(0, 7).join("\n") + "\n");
    expect(agyFinalAnswer(path)).toBeUndefined();
  });

  test("agy final answer of a missing transcript is undefined", () => {
    expect(agyFinalAnswer(join(tmp, "missing.jsonl"))).toBeUndefined();
    const end = agyAdapter.signal("Stop", { terminationReason: "NO_TOOL_CALL" });
    if (end.kind !== "turn-end") throw new Error("unexpected signal");
    expect(agyAdapter.finalAnswer(end)).toBeUndefined();
  });
});

describe("shared contract", () => {
  test("adapter text limits", () => {
    // Grok coupe à 10 000 caractères : la limite de la doublure reste strictement dessous.
    expect(grokAdapter.textLimit).toBeGreaterThan(0);
    expect(grokAdapter.textLimit).toBeLessThan(10_000);
    expect(agyAdapter.textLimit).toBe(Number.POSITIVE_INFINITY);
  });

  test("replies have the harness shapes", () => {
    expect(grokAdapter.deliveryReply("PostToolUse", "t")).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "t" },
    });
    expect(agyAdapter.deliveryReply("PreInvocation", "t")).toEqual({ injectSteps: [{ userMessage: "t" }] });
    expect(grokAdapter.continueReply("t")).toEqual({ decision: "block", reason: "t" });
    expect(agyAdapter.continueReply("t")).toEqual({ decision: "continue", reason: "t" });
  });

  test("doorbell bytes are exact", () => {
    expect(Buffer.from(DOORBELL_BYTES).toString("hex")).toBe("f09f93a82069646e6d6120726561640d");
  });
});
