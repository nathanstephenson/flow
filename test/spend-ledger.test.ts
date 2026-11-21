import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend, type FakeSession } from "../src/backend/fake/index.ts";
import type { AgentBackend } from "../src/backend/types.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { SpendLedger } from "../src/daemon/spend-ledger.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { summariseToName } from "../src/daemon/summariser.ts";
import type { Spend } from "../src/protocol/events.ts";

const DAY = 24 * 60 * 60 * 1000;

function spend(costUSD: number, tokens = costUSD * 100, id = "model-a"): Spend {
  return { tokens, cached: 0, costUSD, models: [{ id, tokens, cached: 0, costUSD }] };
}

describe("Spend Ledger", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ready(): SpendLedger {
    const ledger = new SpendLedger(root);
    ledger.finishBackfill();
    return ledger;
  }

  it("counts what a running total added", () => {
    const ledger = ready();
    ledger.record("session", "a", undefined, spend(1));
    ledger.record("session", "a", undefined, spend(1));
    ledger.record("session", "a", undefined, spend(3));
    ledger.record("session", "b", undefined, spend(2));

    const { lifetime } = ledger.summary();
    assert.equal(lifetime.costUSD, 5);
    assert.deepEqual(lifetime.sources, [{ source: "session", tokens: 500, cached: 0, costUSD: 5 }]);
  });

  it("counts a total that went down as a new count", () => {
    const ledger = ready();
    ledger.record("session", "a", undefined, spend(3));
    ledger.record("session", "a", undefined, spend(1));
    ledger.record("session", "a", undefined, spend(2));

    assert.equal(ledger.summary().lifetime.costUSD, 5);
    assert.equal(new SpendLedger(root).summary().lifetime.costUSD, 5);
  });

  it("splits by model, highest cost first", () => {
    const ledger = ready();
    ledger.record("session", "a", undefined, {
      tokens: 300, cached: 50, costUSD: 4,
      models: [{ id: "cheap", tokens: 200, cached: 50, costUSD: 1 }, { id: "dear", tokens: 100, cached: 0, costUSD: 3 }],
    });

    assert.deepEqual(ledger.summary().lifetime.models.map((model) => model.id), ["dear", "cheap"]);
  });

  it("keeps the last totals after a restart", () => {
    ready().record("session", "a", undefined, spend(2));
    const reloaded = new SpendLedger(root);
    reloaded.record("session", "a", undefined, spend(3));

    assert.equal(reloaded.summary().lifetime.costUSD, 3);
  });

  it("puts each change in the windows that contain it", () => {
    const ledger = ready();
    const now = Date.now();
    ledger.record("session", "a", undefined, spend(1), new Date(now - 40 * DAY).toISOString());
    ledger.record("session", "a", undefined, spend(3), new Date(now - 10 * DAY).toISOString());
    ledger.record("session", "a", undefined, spend(7), new Date(now - 2 * DAY).toISOString());
    ledger.record("session", "a", undefined, spend(15), new Date(now - 1000).toISOString());

    const summary = ledger.summary(now);
    assert.deepEqual([summary.day.costUSD, summary.week.costUSD, summary.month.costUSD, summary.lifetime.costUSD], [8, 12, 14, 15]);
  });

  it("puts each change in a time bucket of its window", () => {
    const ledger = ready();
    const now = Date.now();
    ledger.record("session", "a", undefined, spend(1), new Date(now - 90 * 60 * 1000).toISOString());
    ledger.record("session", "a", undefined, spend(3), new Date(now - 1000).toISOString());

    const { day, week, month, lifetime } = ledger.summary(now);
    assert.deepEqual([day.buckets.length, week.buckets.length, month.buckets.length], [24, 28, 30]);
    assert.equal(day.buckets[22]!.models[0]!.costUSD, 1);
    assert.equal(day.buckets[23]!.models[0]!.costUSD, 2);
    assert.equal(Date.parse(day.buckets[0]!.start), now - DAY);
    assert.equal(lifetime.buckets.length, 1);
  });

  it("makes lifetime buckets weekly when daily would be too many", () => {
    const ledger = ready();
    const now = Date.now();
    ledger.record("session", "a", undefined, spend(1), new Date(now - 100 * DAY).toISOString());

    const { buckets } = ledger.summary(now).lifetime;
    assert.equal(buckets.length, 15);
    assert.equal(Date.parse(buckets[1]!.start) - Date.parse(buckets[0]!.start), 7 * DAY);
  });

  it("drops a torn final line and keeps writing after it", () => {
    ready().record("session", "a", undefined, spend(1));
    appendFileSync(join(root, "spend-ledger.jsonl"), '{"at":');
    const ledger = new SpendLedger(root);
    ledger.record("session", "a", undefined, spend(2));

    assert.equal(new SpendLedger(root).summary().lifetime.costUSD, 2);
  });
});

describe("Spend Ledger in the Session Host", () => {
  let root: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-"));
    store = new TranscriptStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function hostWith(backend = new FakeBackend()): Promise<{ host: SessionHost; backend: FakeBackend }> {
    const host = new SessionHost({ store, retention: DAY });
    host.registerBackend(backend);
    await host.load();
    return { host, backend };
  }

  it("keeps an Agent Session's Spend after it is Reaped", async () => {
    const { host, backend } = await hostWith();
    const id = await host.create({ scope: tmpdir(), backend: "fake" });
    backend.latest.reportSpend(spend(2));
    host.workflowSpend(id, "execution", spend(1, 50, "model-b"));
    await host.settle(id);
    assert.deepEqual(await host.reap(Date.now() + 2 * DAY), [id]);

    const { lifetime } = (await hostWith()).host.spendSummary()!;
    assert.equal(lifetime.costUSD, 3);
    assert.deepEqual(lifetime.sources.map((source) => source.source), ["session", "workflow"]);
  });

  it("does not copy the source's Spend into a Fork", async () => {
    const { host, backend } = await hostWith(new FakeBackend({ fork: true }));
    const id = await host.create({ scope: tmpdir(), backend: "fake" });
    await host.send(id, "first", "now");
    backend.latest.completeTurn();
    await host.send(id, "second", "now");
    backend.latest.reportSpend(spend(2));
    host.workflowSpend(id, "execution", spend(1));
    backend.latest.completeTurn();
    const second = host.logFor(id).since(0).findLast(({ event }) => event.type === "user_message")!.event;
    assert.equal(second.type, "user_message");

    const forkId = await host.fork(id, second.id);
    const copied = host.logFor(forkId).since(0).map(({ event }) => event);
    assert.equal(copied.some((event) => event.type === "workflow_spend" || (event.type === "context_usage" && event.spend)), false);
    assert.equal(backend.latest.priorSpend, undefined);
    assert.equal(host.spendSummary()!.lifetime.costUSD, 3);
  });

  it("fills a new Ledger once from existing transcripts, without fork prefixes", async () => {
    const at = new Date(Date.now() - 2 * DAY).toISOString();
    const write = (sessionId: string, events: Parameters<TranscriptStore["append"]>[0]["event"][]) => {
      store.writeMeta({ id: sessionId, scope: tmpdir(), backend: "fake", title: sessionId, createdAt: at, updatedAt: at } as Parameters<TranscriptStore["writeMeta"]>[0]);
      events.forEach((event, index) => store.append({ seq: index + 1, sessionId, at, event }));
    };
    write("source", [{ type: "context_usage", used: 1, window: 10, spend: spend(2) }, { type: "workflow_spend", executionId: "x", spend: spend(1) }]);
    write("fork", [
      { type: "context_usage", used: 1, window: 10, spend: spend(2) },
      { type: "forked", fromSessionId: "source", userMessageId: "m" },
      { type: "context_usage", used: 1, window: 10, spend: spend(4) },
    ]);

    const summary = (await hostWith()).host.spendSummary()!;
    assert.equal(summary.lifetime.costUSD, 7);
    assert.equal(summary.day.costUSD, 0);
    const lines = readFileSync(join(root, "spend-ledger.jsonl"), "utf8").trim().split("\n").length;
    await hostWith();
    assert.equal(readFileSync(join(root, "spend-ledger.jsonl"), "utf8").trim().split("\n").length, lines);
  });
});

describe("Summary Model Spend", () => {
  it("reports what naming cost", async () => {
    const fake = new FakeBackend();
    fake.autoReply = "Add retry to the uploader";
    const backend: AgentBackend = { name: fake.name, create: async (options) => {
      const session = await fake.create(options) as FakeSession;
      session.spend = spend(1);
      return session;
    } };
    const spent: Spend[] = [];

    const name = await summariseToName({ backend, modelId: "fake-1", text: "Fix the uploader", spent: (value) => spent.push(value) });

    assert.equal(name, "Add retry to the uploader");
    assert.deepEqual(spent, [spend(1)]);
  });
});
