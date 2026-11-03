import { errorMessage, logEvent } from "../log.ts";
import { OpencodeHttpError, type ServiceInfo } from "./service.ts";

/** Un événement du service : `type` et charge utile `data` (l'enveloppe `id`, `created`, `location`, `durable` n'est pas relayée). */
export interface OpencodeEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Les événements dont le courrier de la doublure a besoin (le service ne relaie que ceux-là, plus `server.connected`). */
export const COURIER_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.text.ended",
  "session.step.ended",
] as const;

/** Délai pour obtenir les en-têtes ; le flux lui-même n'a pas de délai. */
const HEADERS_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Charge d'une trame SSE : les lignes `data:` jointes ; `undefined` pour une trame de commentaires seuls. */
function frameData(frame: string): string | undefined {
  const lines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    lines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Ouvre `GET /api/event` filtré sur `types`. La promesse tient aux en-têtes en 200 ; un autre statut
 * la rejette en `OpencodeHttpError` (`status` 0 si le service ne répond pas). `onClose` est appelé une
 * fois quand le serveur ferme ou que la lecture échoue, jamais après `close()`.
 */
export async function openEventStream(o: {
  info: ServiceInfo;
  types: readonly string[];
  onEvent(e: OpencodeEvent): void;
  onClose(error?: unknown): void;
  fetchImpl?: typeof fetch;
}): Promise<{ close(): void }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = new URL("/api/event", o.info.url);
  for (const type of o.types) url.searchParams.append("types", type);

  const controller = new AbortController();
  const headersTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: "Basic " + Buffer.from(`opencode:${o.info.password}`).toString("base64"),
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new OpencodeHttpError(0, `GET /api/event: ${errorMessage(error)}`);
  } finally {
    clearTimeout(headersTimer);
  }

  if (res.status !== 200 || !res.body) {
    let tag: string | undefined;
    try {
      const json: unknown = JSON.parse(await res.text());
      if (isRecord(json) && typeof json._tag === "string") tag = json._tag;
    } catch {
      // Corps vide ou non JSON : le statut suffit.
    }
    throw new OpencodeHttpError(res.status, `GET /api/event: HTTP ${res.status}`, tag);
  }

  let closedByCaller = false;
  let closeReported = false;
  const reportClose = (error?: unknown): void => {
    if (closedByCaller || closeReported) return;
    closeReported = true;
    o.onClose(error);
  };

  const dispatch = (frame: string): void => {
    const payload = frameData(frame);
    if (payload === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      // Longueur seule : le contenu peut porter du texte de message.
      logEvent("opencode-event-invalid", { length: payload.length });
      return;
    }
    try {
      o.onEvent({ type: parsed.type, data: isRecord(parsed.data) ? parsed.data : {} });
    } catch (error) {
      logEvent("opencode-event-handler-failed", { type: parsed.type, error: errorMessage(error) });
    }
  };

  const reader = res.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          dispatch(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      reportClose();
    } catch (error) {
      reportClose(error);
    }
  })();

  return {
    close() {
      closedByCaller = true;
      controller.abort();
      reader.cancel().catch(() => {});
    },
  };
}
