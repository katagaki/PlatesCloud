import { DurableObject } from "cloudflare:workers";
import { verifyAssertion } from "./attest";
import type { Pick } from "./decide";
import type { Env } from "./env";

export type Kind = "write" | "decide";

interface Usage {
  day: string;
  count: number;
  answers: [string, Pick][];
}

export interface Reservation {
  allowed: boolean;
  remaining: number;
  answer?: Pick;
}

const KEPT_ANSWERS = 20;

export class Device extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY)");
  }

  private unlimited(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM flags WHERE name = 'unlimited'").toArray().length > 0;
  }

  async register(point: Uint8Array): Promise<boolean> {
    if (await this.ctx.storage.get("point")) return false;
    await this.ctx.storage.put({ point, counter: 0 });
    return true;
  }

  async authenticate(assertion: Uint8Array, clientData: Uint8Array, appId: string): Promise<boolean> {
    let passed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const point = await this.ctx.storage.get<Uint8Array>("point");
      if (!point) return;
      const last = (await this.ctx.storage.get<number>("counter")) ?? 0;
      try {
        const counter = await verifyAssertion(assertion, clientData, point, appId, last);
        await this.ctx.storage.put("counter", counter);
        passed = true;
      } catch {
        passed = false;
      }
    });
    return passed;
  }

  private async usage(kind: Kind, day: string): Promise<Usage> {
    const stored = await this.ctx.storage.get<Usage>(`usage:${kind}`);
    return stored && stored.day === day ? stored : { day, count: 0, answers: [] };
  }

  async reserve(kind: Kind, day: string, limit: number, requestId?: string): Promise<Reservation> {
    const usage = await this.usage(kind, day);
    const cached = requestId ? usage.answers.find(([id]) => id === requestId) : undefined;
    if (cached) return { allowed: true, remaining: Math.max(0, limit - usage.count), answer: cached[1] };
    if (this.unlimited()) return { allowed: true, remaining: Math.max(0, limit - usage.count) };
    if (usage.count >= limit) return { allowed: false, remaining: 0 };
    usage.count += 1;
    await this.ctx.storage.put(`usage:${kind}`, usage);
    return { allowed: true, remaining: limit - usage.count };
  }

  async release(kind: Kind, day: string): Promise<void> {
    const usage = await this.usage(kind, day);
    if (usage.count === 0 || this.unlimited()) return;
    usage.count -= 1;
    await this.ctx.storage.put(`usage:${kind}`, usage);
  }

  async remember(kind: Kind, day: string, requestId: string, answer: Pick): Promise<void> {
    const usage = await this.usage(kind, day);
    usage.answers = [...usage.answers.filter(([id]) => id !== requestId), [requestId, answer] as [string, Pick]].slice(-KEPT_ANSWERS);
    await this.ctx.storage.put(`usage:${kind}`, usage);
  }

  async remaining(kind: Kind, day: string, limit: number): Promise<number> {
    return Math.max(0, limit - (await this.usage(kind, day)).count);
  }
}
