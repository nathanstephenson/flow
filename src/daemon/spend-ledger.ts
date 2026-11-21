import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Spend } from "../protocol/events.ts";
import type { SpendSource, SpendSummary, SpendTotal, SpendWindow, SpendWindowName } from "../protocol/spend.ts";

type Reading = SpendTotal & { at: string; source: SpendSource; key: string; scope?: string; model: string };
type Delta = SpendTotal & { at: number; source: SpendSource; model: string };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOWS: Record<SpendWindowName, { span: number; bucket: number }> = {
  day: { span: DAY, bucket: HOUR }, week: { span: 7 * DAY, bucket: 6 * HOUR }, month: { span: 30 * DAY, bucket: DAY }, lifetime: { span: Infinity, bucket: 0 },
};
const LIFETIME_BUCKETS = [DAY, 7 * DAY, 30 * DAY];
const MAX_BARS = 60;

export class SpendLedger {
  private readonly path: string;
  private backfill: Reading[] | undefined;
  private readonly last = new Map<string, SpendTotal>();
  private readonly deltas: Delta[] = [];

  constructor(root: string) {
    this.path = join(root, "spend-ledger.jsonl");
    if (!existsSync(this.path)) {
      this.backfill = [];
      return;
    }
    const raw = readFileSync(this.path, "utf8");
    const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
    if (complete.length < raw.length) truncateSync(this.path, Buffer.byteLength(complete));
    for (const line of complete.split("\n")) if (line) this.apply(JSON.parse(line) as Reading);
  }

  get needsBackfill(): boolean {
    return this.backfill !== undefined;
  }

  record(source: SpendSource, key: string, scope: string | undefined, spend: Spend, at = new Date().toISOString()): void {
    const readings = spend.models.flatMap(({ id, tokens, cached, costUSD }): Reading[] => {
      const previous = this.last.get(JSON.stringify([key, id]));
      if (previous?.tokens === tokens && previous.cached === cached && previous.costUSD === costUSD) return [];
      return [{ at, source, key, ...(scope === undefined ? {} : { scope }), model: id, tokens, cached, costUSD }];
    });
    if (readings.length === 0) return;
    if (this.backfill) this.backfill.push(...readings);
    else write(this.path, "a", readings);
    for (const reading of readings) this.apply(reading);
  }

  finishBackfill(): void {
    if (!this.backfill) return;
    mkdirSync(dirname(this.path), { recursive: true });
    write(`${this.path}.tmp`, "w", this.backfill);
    renameSync(`${this.path}.tmp`, this.path);
    this.backfill = undefined;
  }

  summary(now = Date.now()): SpendSummary {
    const entries = Object.entries(WINDOWS).map(([name, { span, bucket }]) => [name, this.window(now, span, bucket)]);
    return Object.fromEntries(entries) as SpendSummary;
  }

  private apply(reading: Reading): void {
    const id = JSON.stringify([reading.key, reading.model]);
    const previous = this.last.get(id);
    const counted = previous && reading.tokens >= previous.tokens && reading.costUSD >= previous.costUSD ? previous : undefined;
    this.last.set(id, { tokens: reading.tokens, cached: reading.cached, costUSD: reading.costUSD });
    this.deltas.push({
      at: Date.parse(reading.at), source: reading.source, model: reading.model,
      tokens: reading.tokens - (counted?.tokens ?? 0),
      cached: reading.cached - (counted?.cached ?? 0),
      costUSD: reading.costUSD - (counted?.costUSD ?? 0),
    });
  }

  private window(now: number, span: number, bucket: number): SpendWindow {
    const since = now - span;
    const start = Number.isFinite(since) ? since : this.deltas.reduce((earliest, delta) => Math.min(earliest, delta.at), now);
    const size = bucket || LIFETIME_BUCKETS.find(size => (now - start) / size <= MAX_BARS) || LIFETIME_BUCKETS.at(-1)!;
    const count = Math.max(1, Math.ceil((now - start) / size));
    const first = now - count * size;
    const result: SpendWindow = {
      tokens: 0, cached: 0, costUSD: 0, models: [], sources: [],
      buckets: Array.from({ length: count }, (_, index) => ({ start: new Date(first + index * size).toISOString(), models: [] })),
    };
    for (const delta of this.deltas) {
      if (delta.at < since) continue;
      add(result, delta);
      const { models } = result.buckets[Math.min(count - 1, Math.max(0, Math.floor((delta.at - first) / size)))]!;
      add(find(models, model => model.id === delta.model, () => ({ id: delta.model, tokens: 0, cached: 0, costUSD: 0 })), delta);
      add(find(result.models, model => model.id === delta.model, () => ({ id: delta.model, tokens: 0, cached: 0, costUSD: 0 })), delta);
      add(find(result.sources, source => source.source === delta.source, () => ({ source: delta.source, tokens: 0, cached: 0, costUSD: 0 })), delta);
    }
    result.models.sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens);
    result.sources.sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens);
    return result;
  }
}

function write(path: string, flags: "a" | "w", readings: Reading[]): void {
  const fd = openSync(path, flags, 0o600);
  try { writeFileSync(fd, readings.map(reading => JSON.stringify(reading) + "\n").join("")); fsyncSync(fd); } finally { closeSync(fd); }
}

function add(total: SpendTotal, delta: SpendTotal): void {
  total.tokens += delta.tokens;
  total.cached += delta.cached;
  total.costUSD += delta.costUSD;
}

function find<T>(items: T[], match: (item: T) => boolean, create: () => T): T {
  const found = items.find(match);
  if (found) return found;
  const item = create();
  items.push(item);
  return item;
}
