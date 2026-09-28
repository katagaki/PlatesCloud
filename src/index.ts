import { checkChallenge, issueChallenge, verifyAttestation } from "./attest";
import { base64Decode, base64UrlEncode } from "./bytes";
import { type Pick, askJev, parseDecision } from "./decide";
import { Device, type Kind } from "./device";
import { type Env, appId, limit } from "./env";
import { GRANITE_MODEL, completion, completionStream, parseChat } from "./granite";

export { Device };

const HOMEPAGE = "https://github.com/katagaki/PlatesCloud";
const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function failure(status: number, message: string, headers: HeadersInit = {}): Response {
  return json({ error: message }, status, headers);
}

export function localDay(offsetMinutes: number, now = Date.now()): string {
  return new Date(now + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function offset(request: Request): number | null {
  const value = Number(request.headers.get("X-Plates-UTC-Offset") ?? "0");
  return Number.isInteger(value) && value >= -720 && value <= 840 ? value : null;
}

async function body(request: Request): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length <= MAX_BODY_BYTES ? bytes : null;
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function device(env: Env, keyId: Uint8Array): DurableObjectStub<Device> {
  return env.DEVICE.get(env.DEVICE.idFromName(base64UrlEncode(keyId)));
}

async function authenticated(request: Request, env: Env, bytes: Uint8Array): Promise<DurableObjectStub<Device> | Response> {
  const app = appId(env);
  if (!app) return failure(503, "not configured");
  const keyId = base64Decode(request.headers.get("X-Plates-Key-Id") ?? "");
  const assertion = base64Decode(request.headers.get("X-Plates-Assertion") ?? "");
  if (!keyId || keyId.length !== 32 || !assertion || assertion.length === 0) return failure(401, "missing assertion");
  const stub = device(env, keyId);
  if (!(await stub.authenticate(assertion, bytes, app))) return failure(401, "assertion rejected");
  return stub;
}

async function challenge(env: Env): Promise<Response> {
  if (!env.CHALLENGE_SECRET) return failure(503, "not configured");
  return json({ challenge: await issueChallenge(env.CHALLENGE_SECRET) });
}

async function attest(request: Request, env: Env): Promise<Response> {
  const app = appId(env);
  if (!app || !env.CHALLENGE_SECRET || !env.APP_ATTEST_ENVIRONMENT) return failure(503, "not configured");
  const bytes = await body(request);
  const input = bytes ? parse(bytes) : undefined;
  const { keyId, attestation, challenge } = (input ?? {}) as { [key: string]: unknown };
  if (typeof keyId !== "string" || typeof attestation !== "string" || typeof challenge !== "string") {
    return failure(400, "keyId, attestation, and challenge are required");
  }
  if (!(await checkChallenge(env.CHALLENGE_SECRET, challenge))) return failure(401, "challenge expired or invalid");
  const id = base64Decode(keyId);
  const object = base64Decode(attestation);
  if (!id || id.length !== 32 || !object) return failure(400, "keyId and attestation must be base64");
  let point: Uint8Array;
  try {
    point = await verifyAttestation(object, id, challenge, app, env.APP_ATTEST_ENVIRONMENT);
  } catch (error) {
    return failure(401, `attestation rejected: ${(error as Error).message}`);
  }
  if (!(await device(env, id).register(point))) return failure(409, "key already registered");
  return json({ registered: true });
}

async function metered(
  stub: DurableObjectStub<Device>,
  kind: Kind,
  day: string,
  most: number,
  requestId: string | undefined,
  work: (remaining: number) => Promise<Response>,
  cached?: (answer: Pick, remaining: number) => Response,
): Promise<Response> {
  const reservation = await stub.reserve(kind, day, most, requestId);
  const headers = { "X-Plates-Remaining": String(reservation.remaining) };
  if (!reservation.allowed) return failure(429, "daily limit reached", headers);
  if (reservation.answer !== undefined && cached) return cached(reservation.answer, reservation.remaining);
  try {
    return await work(reservation.remaining);
  } catch (error) {
    await stub.release(kind, day);
    return failure(502, (error as Error).message, { "X-Plates-Remaining": String(reservation.remaining + 1) });
  }
}

async function write(request: Request, env: Env): Promise<Response> {
  const most = limit(env.WRITE_DAILY_LIMIT);
  if (most === null) return failure(503, "not configured");
  const minutes = offset(request);
  const bytes = await body(request);
  if (minutes === null || !bytes) return failure(400, "bad request");
  const chat = parseChat(parse(bytes));
  if (typeof chat === "string") return failure(400, chat);
  const stub = await authenticated(request, env, bytes);
  if (stub instanceof Response) return stub;
  return metered(stub, "write", localDay(minutes), most, undefined, async (remaining) => {
    const result = await env.AI.run(GRANITE_MODEL, chat);
    const headers = { "X-Plates-Remaining": String(remaining) };
    if (chat.stream) {
      if (!(result instanceof ReadableStream)) throw new Error("granite returned no stream");
      return new Response(completionStream(result), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...headers },
      });
    }
    return json(completion(result), 200, headers);
  });
}

async function decide(request: Request, env: Env): Promise<Response> {
  const most = limit(env.DECIDE_DAILY_LIMIT);
  if (most === null || !env.JEV_API_KEY) return failure(503, "not configured");
  const key = env.JEV_API_KEY;
  const minutes = offset(request);
  const bytes = await body(request);
  if (minutes === null || !bytes) return failure(400, "bad request");
  const decision = parseDecision(parse(bytes));
  if (typeof decision === "string") return failure(400, decision);
  const stub = await authenticated(request, env, bytes);
  if (stub instanceof Response) return stub;
  const day = localDay(minutes);
  return metered(
    stub, "decide", day, most, decision.requestId,
    async (remaining) => {
      const pick = await askJev(decision, key);
      await stub.remember("decide", day, decision.requestId, pick);
      return json({ ...pick, remaining }, 200, { "X-Plates-Remaining": String(remaining) });
    },
    (answer, remaining) => json({ ...answer, remaining }, 200, { "X-Plates-Remaining": String(remaining) }),
  );
}

async function remaining(request: Request, env: Env): Promise<Response> {
  const most = limit(env.DECIDE_DAILY_LIMIT);
  if (most === null) return failure(503, "not configured");
  const minutes = offset(request);
  const bytes = await body(request);
  if (minutes === null || !bytes) return failure(400, "bad request");
  const stub = await authenticated(request, env, bytes);
  if (stub instanceof Response) return stub;
  return json({ remaining: await stub.remaining("decide", localDay(minutes), most) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/" && url.search === "") return Response.redirect(HOMEPAGE, 302);
    if (request.method !== "POST") return failure(405, "method not allowed");
    switch (url.pathname) {
      case "/v1/challenge":
        return challenge(env);
      case "/v1/attest":
        return attest(request, env);
      case "/v1/chat/completions":
        return write(request, env);
      case "/v1/decide":
        return decide(request, env);
      case "/v1/decide/remaining":
        return remaining(request, env);
      default:
        return failure(404, "not found");
    }
  },
};
