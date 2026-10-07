// The HTTP side: POST /api/ask and GET /api/health, with an input cap, a per-IP rate limit and a cap
// on questions in flight. Errors go out as one plain sentence; details stay in the server log.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { type AskInput, type AskOutput, type Turn } from "./ask.js";

export interface Limits {
  /** Characters in a question. */
  maxQuestion: number;
  /** Bytes in a request body. */
  maxBody: number;
  /** Earlier turns kept, and characters in each. */
  maxHistory: number;
  maxTurn: number;
  /** Questions per IP per window. */
  ratePerWindow: number;
  windowMs: number;
  /** Questions answered at once, across every IP. */
  maxInFlight: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxQuestion: 500,
  maxBody: 16_384,
  maxHistory: 6,
  maxTurn: 1_500,
  ratePerWindow: 8,
  windowMs: 60_000,
  maxInFlight: 4,
};

export interface ServerOptions {
  answer: (input: AskInput) => Promise<AskOutput>;
  limits?: Partial<Limits>;
  /** Read the client's IP from the last X-Forwarded-For entry, for use behind our own proxy. */
  trustProxy?: boolean;
  /** An origin allowed to call the API from a browser on another host. */
  allowOrigin?: string;
  health?: () => Record<string, unknown>;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A fixed window counter per key. */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new HttpError(413, "That request is too long.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "That request is too long.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The request body as an AskInput, or a 400 saying what is wrong. */
export function parseAsk(body: string, limits: Limits): AskInput {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Send JSON with a question.");
  }
  if (typeof raw !== "object" || raw === null) throw new HttpError(400, "Send JSON with a question.");
  const r = raw as Record<string, unknown>;
  if (typeof r.question !== "string" || r.question.trim() === "") throw new HttpError(400, "Ask a question.");
  const question = r.question.trim();
  if (question.length > limits.maxQuestion) throw new HttpError(400, `Keep the question under ${limits.maxQuestion} characters.`);
  let market: string | undefined;
  if (r.market !== undefined && r.market !== null) {
    if (typeof r.market !== "string" || r.market.length > 100) throw new HttpError(400, "The market should be a short id or pair.");
    market = r.market.trim() || undefined;
  }
  let history: Turn[] | undefined;
  if (r.history !== undefined && r.history !== null) {
    if (!Array.isArray(r.history)) throw new HttpError(400, "The history should be a list of turns.");
    history = r.history.slice(-limits.maxHistory).map((t) => {
      const turn = t as Record<string, unknown>;
      if ((turn?.role !== "user" && turn?.role !== "assistant") || typeof turn.text !== "string") throw new HttpError(400, "Each turn needs a role and a text.");
      return { role: turn.role, text: turn.text.slice(0, limits.maxTurn) };
    });
  }
  return { question, market, history };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function askServer(opts: ServerOptions): Server {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const allow = rateLimiter(limits.ratePerWindow, limits.windowMs, opts.now);
  let inFlight = 0;
  const cors: Record<string, string> = opts.allowOrigin
    ? { "access-control-allow-origin": opts.allowOrigin, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" }
    : {};

  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "OPTIONS" && opts.allowOrigin) {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (path === "/api/health" && req.method === "GET") {
        send(res, 200, { ok: true, ...opts.health?.() }, cors);
        return;
      }
      if (path !== "/api/ask") throw new HttpError(404, "Not found.");
      if (req.method !== "POST") throw new HttpError(405, "Use POST.");
      if (!allow(clientIp(req, opts.trustProxy ?? false))) {
        send(res, 429, { error: "Too many questions. Try again in a minute." }, { ...cors, "retry-after": String(Math.ceil(limits.windowMs / 1000)) });
        return;
      }
      const input = parseAsk(await readBody(req, limits.maxBody), limits);
      if (inFlight >= limits.maxInFlight) throw new HttpError(503, "Busy right now. Try again shortly.");
      inFlight++;
      try {
        send(res, 200, await opts.answer(input), cors);
      } finally {
        inFlight--;
      }
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message }, cors);
        return;
      }
      // Only the error's name and message reach the log, and nothing reaches the client.
      console.error(`ask failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      if (!res.headersSent) send(res, 502, { error: "The answer could not be worked out right now. Try again." }, cors);
    }
  });
}
