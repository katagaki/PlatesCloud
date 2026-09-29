import { DurableObject } from "cloudflare:workers";
import { verifyAssertion } from "./attest";
import type { Pick } from "./decide";
import type { Env } from "./env";

export type Kind = "write" | "decide";

export interface Reservation {
  allowed: boolean;
  remaining: number;
  answer?: Pick;
}

const KEPT_ANSWERS = 20;

export class Device extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS limits (kind TEXT PRIMARY KEY, daily INTEGER);
      CREATE TABLE IF NOT EXISTS key (id INTEGER PRIMARY KEY CHECK (id = 1), point BLOB NOT NULL, counter INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (kind TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS answers (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, day TEXT NOT NULL, answer TEXT NOT NULL);
    `);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private limit(kind: Kind, fallback: number): number {
    const daily = this.sql.exec("SELECT daily FROM limits WHERE kind = ?", kind).toArray()[0]?.daily;
    return Number.isSafeInteger(daily) && (daily as number) >= 0 ? (daily as number) : fallback;
  }

  private count(kind: Kind, day: string): number {
    return (this.sql.exec("SELECT count FROM usage WHERE kind = ? AND day = ?", kind, day).toArray()[0]?.count as number) ?? 0;
  }

  private setCount(kind: Kind, day: string, count: number): void {
    this.sql.exec("INSERT OR REPLACE INTO usage (kind, day, count) VALUES (?, ?, ?)", kind, day, count);
  }

  register(point: Uint8Array): boolean {
    if (this.sql.exec("SELECT 1 FROM key").toArray().length > 0) return false;
    this.sql.exec("INSERT INTO key (id, point, counter) VALUES (1, ?, 0)", point.slice().buffer);
    return true;
  }

  async authenticate(assertion: Uint8Array, clientData: Uint8Array, appId: string): Promise<boolean> {
    let passed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const row = this.sql.exec("SELECT point, counter FROM key").toArray()[0];
      if (!row) return;
      try {
        const counter = await verifyAssertion(assertion, clientData, new Uint8Array(row.point as ArrayBuffer), appId, row.counter as number);
        this.sql.exec("UPDATE key SET counter = ?", counter);
        passed = true;
      } catch {
        passed = false;
      }
    });
    return passed;
  }

  reserve(kind: Kind, day: string, fallback: number, requestId?: string): Reservation {
    const limit = this.limit(kind, fallback);
    const count = this.count(kind, day);
    const cached = requestId
      ? this.sql.exec("SELECT answer FROM answers WHERE request_id = ? AND kind = ? AND day = ?", requestId, kind, day).toArray()[0]
      : undefined;
    if (cached) return { allowed: true, remaining: Math.max(0, limit - count), answer: JSON.parse(cached.answer as string) };
    if (count >= limit) return { allowed: false, remaining: 0 };
    this.setCount(kind, day, count + 1);
    return { allowed: true, remaining: limit - count - 1 };
  }

  release(kind: Kind, day: string): void {
    const count = this.count(kind, day);
    if (count > 0) this.setCount(kind, day, count - 1);
  }

  remember(kind: Kind, day: string, requestId: string, answer: Pick): void {
    this.sql.exec("DELETE FROM answers WHERE day != ?", day);
    this.sql.exec("INSERT OR REPLACE INTO answers (request_id, kind, day, answer) VALUES (?, ?, ?, ?)", requestId, kind, day, JSON.stringify(answer));
    this.sql.exec("DELETE FROM answers WHERE rowid NOT IN (SELECT rowid FROM answers ORDER BY rowid DESC LIMIT ?)", KEPT_ANSWERS);
  }

  remaining(kind: Kind, day: string, fallback: number): number {
    return Math.max(0, this.limit(kind, fallback) - this.count(kind, day));
  }
}
