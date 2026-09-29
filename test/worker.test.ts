import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64Encode } from "../src/bytes";
import type { Env } from "../src/env";
import worker, { localDay } from "../src/index";
import { Phone, call, sse } from "./client";

const chat = { messages: [{ role: "user", content: "Make egg fried rice." }] };
const ideas = {
  requestId: "set-1",
  request: "Something easy when I'm tired",
  ingredients: ["eggs", "rice"],
  tools: ["frying pan"],
  ideas: [{ title: "Egg fried rice", summary: "One pan, 15 minutes" }, { title: "Rice porridge" }],
};

function jev(choice: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { pick: { type: "choice", choice, confidence: 0.8, probabilities: { idea_1: 0.1, idea_2: 0.9 } } },
  }), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe("routing", () => {
  it("serves health, redirects home, and rejects the rest", async () => {
    expect((await call(new Request("https://plates.test/health"))).status).toBe(200);
    const home = await call(new Request("https://plates.test/"));
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("https://github.com/katagaki/PlatesCloud");
    expect((await call(new Request("https://plates.test/v1/chat/completions"))).status).toBe(405);
    expect((await call(new Request("https://plates.test/v1/nothing", { method: "POST" }))).status).toBe(404);
  });

  it("says so when a setting is missing", async () => {
    const request = new Request("https://plates.test/v1/challenge", { method: "POST" });
    const response = await worker.fetch(request, { ...env, CHALLENGE_SECRET: "", AI: { run: async () => null } } as Env);
    expect(response.status).toBe(503);
  });

  it("hands out challenges", async () => {
    const response = await call(new Request("https://plates.test/v1/challenge", { method: "POST" }));
    expect(((await response.json()) as { challenge: string }).challenge).toMatch(/^[A-Za-z0-9_-]{75}$/);
  });

  it("works out the cook's day from their offset", () => {
    const now = Date.UTC(2026, 8, 28, 20, 0);
    expect(localDay(0, now)).toBe("2026-09-28");
    expect(localDay(540, now)).toBe("2026-09-29");
    expect(localDay(-480, now)).toBe("2026-09-28");
  });
});

describe("attest", () => {
  it("rejects a stale challenge before reading the attestation", async () => {
    const response = await call(new Request("https://plates.test/v1/attest", {
      method: "POST",
      body: JSON.stringify({ keyId: base64Encode(new Uint8Array(32)), attestation: "AA==", challenge: "nope" }),
    }));
    expect(response.status).toBe(401);
  });
});

describe("writing", () => {
  it("refuses a request without a valid assertion", async () => {
    const phone = await Phone.create();
    expect((await phone.post("/v1/chat/completions", chat, { assertion: "AAAA" })).status).toBe(401);
    const stranger = await Phone.create(false);
    expect((await stranger.post("/v1/chat/completions", chat)).status).toBe(401);
  });

  it("refuses a replayed assertion", async () => {
    const phone = await Phone.create();
    const body = new TextEncoder().encode(JSON.stringify(chat));
    const assertion = await phone.assertion(body);
    expect((await phone.post("/v1/chat/completions", chat, { assertion })).status).toBe(200);
    expect((await phone.post("/v1/chat/completions", chat, { assertion })).status).toBe(401);
  });

  it("returns Granite's answer in the Chat Completions shape", async () => {
    const phone = await Phone.create();
    const run = vi.fn(async () => ({ response: "Egg Fried Rice" }));
    const response = await phone.post("/v1/chat/completions", { ...chat, temperature: 0.2 }, { ai: { run } });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Egg Fried Rice");
    expect(response.headers.get("X-Plates-Remaining")).toBe("2");
    expect(run).toHaveBeenCalledWith("@cf/ibm-granite/granite-4.0-h-micro", {
      messages: chat.messages, max_tokens: 1400, temperature: 0.2, stream: false,
    });
  });

  it("streams Granite's text as chat completion chunks", async () => {
    const phone = await Phone.create();
    const run = async () => sse({ response: "Egg " }, { response: "Fried Rice" });
    const response = await phone.post("/v1/chat/completions", { ...chat, stream: true }, { ai: { run } });
    const text = await response.text();
    const contents = text.split("\n\n").filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "").join("");
    expect(contents).toBe("Egg Fried Rice");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("stops at the daily limit and gives back a failed write", async () => {
    const phone = await Phone.create();
    const broken = { run: async () => { throw new Error("granite is down"); } };
    expect((await phone.post("/v1/chat/completions", chat, { ai: broken })).status).toBe(502);
    for (let i = 0; i < 3; i++) expect((await phone.post("/v1/chat/completions", chat)).status).toBe(200);
    const over = await phone.post("/v1/chat/completions", chat);
    expect(over.status).toBe(429);
    expect(over.headers.get("X-Plates-Remaining")).toBe("0");
  });

  it("uses a limit set in the device's storage over the default", async () => {
    const phone = await Phone.create();
    await runInDurableObject(phone.stub(), (_, state) => {
      state.storage.sql.exec("INSERT INTO limits (kind, daily) VALUES ('write', 5), ('decide', 'lots')");
    });
    for (let i = 4; i >= 0; i--) {
      const response = await phone.post("/v1/chat/completions", chat);
      expect(response.headers.get("X-Plates-Remaining")).toBe(String(i));
    }
    expect((await phone.post("/v1/chat/completions", chat)).status).toBe(429);
    expect(await (await phone.post("/v1/decide/remaining", {})).json()).toEqual({ remaining: 2 });
  });

  it("rejects messages it will not pass on", async () => {
    const phone = await Phone.create();
    expect((await phone.post("/v1/chat/completions", { messages: [] })).status).toBe(400);
    expect((await phone.post("/v1/chat/completions", { ...chat, max_tokens: 5000 })).status).toBe(400);
    expect((await phone.post("/v1/chat/completions", { messages: [{ role: "tool", content: "x" }] })).status).toBe(400);
  });
});

describe("deciding", () => {
  it("asks Jev and returns the pick with what is left today", async () => {
    const phone = await Phone.create();
    const fetch = jev("idea_2");
    const response = await phone.post("/v1/decide", ideas);
    expect(await response.json()).toEqual({ index: 1, confidence: 0.8, probabilities: [0.1, 0.9], remaining: 1 });
    const sent = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(fetch.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions.pick.criteria).toEqual({ idea_1: "Egg fried rice", idea_2: "Rice porridge" });
    expect(sent.state.ideas.idea_1).toEqual({ title: "Egg fried rice", summary: "One pan, 15 minutes" });
  });

  it("answers a retried set from memory without counting it again", async () => {
    const phone = await Phone.create();
    const fetch = jev("idea_1");
    await phone.post("/v1/decide", ideas);
    const again = await phone.post("/v1/decide", ideas);
    expect(((await again.json()) as { index: number; remaining: number })).toMatchObject({ index: 0, remaining: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows the limit each day, per device, and not a failed pick", async () => {
    const phone = await Phone.create();
    jev("idea_1", 500);
    expect((await phone.post("/v1/decide", ideas)).status).toBe(502);
    vi.restoreAllMocks();
    jev("idea_1");
    expect((await phone.post("/v1/decide", { ...ideas, requestId: "a" })).status).toBe(200);
    expect((await phone.post("/v1/decide", { ...ideas, requestId: "b" })).status).toBe(200);
    expect((await phone.post("/v1/decide", { ...ideas, requestId: "c" })).status).toBe(429);
    const remaining = await phone.post("/v1/decide/remaining", {});
    expect(await remaining.json()).toEqual({ remaining: 0 });
    const other = await Phone.create();
    expect((await other.post("/v1/decide", { ...ideas, requestId: "d" })).status).toBe(200);
  });

  it("rejects a pick outside the ideas", async () => {
    const phone = await Phone.create();
    jev("idea_9");
    expect((await phone.post("/v1/decide", ideas)).status).toBe(502);
  });

  it("rejects bad offsets and bad sets", async () => {
    const phone = await Phone.create();
    expect((await phone.post("/v1/decide", ideas, { offset: 2000 })).status).toBe(400);
    expect((await phone.post("/v1/decide", { ...ideas, ideas: [ideas.ideas[0]] })).status).toBe(400);
  });
});
