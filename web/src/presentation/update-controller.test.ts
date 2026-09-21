import assert from "node:assert/strict";
import { test } from "node:test";

import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
import {
  OPEN_BROWSER_UPDATE_CHECK_MS,
  UPDATE_RECOVERY_POLL_MS,
  UPDATE_RECONNECT_POLL_MS,
  updateDetail,
  updatePresentation,
} from "./update.ts";
import { UpdateController, type UpdateControllerOptions } from "./update-controller.ts";

const available: WebUpdateStatus = {
  installedVersion: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  eligibility: { state: "eligible" },
};

const updating: WebUpdateStatus = {
  ...available,
  operation: {
    id: "operation-1",
    state: "updating",
    previousVersion: "1.0.0",
    targetVersion: "2.0.0",
    startedAt: "then",
    message: "Starting the guarded npm update.",
  },
};

const succeeded: WebUpdateStatus = {
  installedVersion: "2.0.0",
  latestVersion: "2.0.0",
  updateAvailable: false,
  eligibility: { state: "eligible" },
  operation: {
    id: "operation-1",
    state: "succeeded",
    previousVersion: "1.0.0",
    targetVersion: "2.0.0",
    installedVersion: "2.0.0",
    startedAt: "then",
    finishedAt: "later",
  },
};

test("provider lifecycle treats an accepted POST with a lost body as ambiguous and only polls GET", async () => {
  const scheduler = new ManualScheduler();
  let gets = 0;
  let posts = 0;
  const succeededOperations: string[] = [];
  const controller = createController(scheduler, {
    getStatus: async () => response(++gets === 1 ? available : succeeded),
    beginUpdate: async () => {
      posts++;
      return {
        ok: true,
        status: 202,
        json: async () => { throw new Error("response body lost"); },
      };
    },
    onSucceeded: id => { succeededOperations.push(id); },
  });

  controller.start();
  await flushAsync();
  assert.equal(controller.snapshot.view, "ready");

  await controller.begin("2.0.0");
  assert.equal(controller.snapshot.view, "reconnecting");
  assert.equal(posts, 1);
  assert.equal(scheduler.nextTimeoutDelay(), UPDATE_RECONNECT_POLL_MS);

  scheduler.runNextTimeout();
  await flushAsync();
  assert.equal(posts, 1, "an ambiguous mutation is never retried");
  assert.equal(gets, 2);
  assert.equal(controller.snapshot.view, "ready");
  assert.equal(controller.snapshot.status?.operation?.state, "succeeded");
  assert.deepEqual(succeededOperations, ["operation-1"]);
  assert.equal(scheduler.nextTimeoutDelay(), undefined);
  controller.stop();
});

test("provider hourly checks retain reconnect lifecycle through a long outage and host return", async () => {
  const scheduler = new ManualScheduler();
  let hostReachable = true;
  let gets = 0;
  let posts = 0;
  const controller = createController(scheduler, {
    getStatus: async () => {
      gets++;
      if (!hostReachable) throw new Error("host unavailable");
      return response(gets === 1 ? available : succeeded);
    },
    beginUpdate: async () => {
      posts++;
      return response(updating, 202);
    },
  });

  controller.start();
  await flushAsync();
  assert.equal(scheduler.intervalDelay(), OPEN_BROWSER_UPDATE_CHECK_MS);
  await controller.begin("2.0.0");
  hostReachable = false;

  scheduler.runNextTimeout();
  await flushAsync();
  assert.equal(controller.snapshot.view, "reconnecting");

  scheduler.nowMs = OPEN_BROWSER_UPDATE_CHECK_MS;
  scheduler.runInterval();
  await flushAsync();
  assert.equal(controller.snapshot.view, "recovery-needed", "the hourly callback must consult the current lifecycle");
  assert.equal(scheduler.nextTimeoutDelay(), UPDATE_RECOVERY_POLL_MS);
  const recoveryPresentation = updatePresentation(
    controller.snapshot.status,
    controller.snapshot.view,
    controller.snapshot.transportError,
  );
  const recoveryDetail = updateDetail(
    recoveryPresentation,
    controller.snapshot.status,
    controller.snapshot.transportError ? { transportError: controller.snapshot.transportError } : {},
  );
  assert.match(recoveryDetail, /Reconnect below/);
  assert.match(recoveryDetail, /repair the private global npm installation manually/);
  assert.match(recoveryDetail, /Last known update status: Starting the guarded npm update/);

  await controller.check(true);
  assert.equal(controller.snapshot.view, "recovery-needed", "manual discovery must not disarm an ambiguous lifecycle");
  assert.equal(posts, 1);

  hostReachable = true;
  scheduler.runNextTimeout();
  await flushAsync();
  assert.equal(controller.snapshot.view, "ready");
  assert.equal(controller.snapshot.status?.operation?.state, "succeeded");
  assert.equal(scheduler.nextTimeoutDelay(), undefined);
  assert.equal(posts, 1, "reconnection only checks status; it never retries mutation");
  controller.stop();
});

function createController(
  scheduler: ManualScheduler,
  overrides: Pick<UpdateControllerOptions, "getStatus" | "beginUpdate"> & Partial<Pick<UpdateControllerOptions, "onSucceeded">>,
): UpdateController {
  return new UpdateController({
    ...overrides,
    now: () => scheduler.nowMs,
    setTimeout: (callback, delayMs) => scheduler.setTimeout(callback, delayMs),
    clearTimeout: handle => scheduler.clearTimeout(handle),
    setInterval: (callback, delayMs) => scheduler.setInterval(callback, delayMs),
    clearInterval: handle => scheduler.clearInterval(handle),
  });
}

function response(body: WebUpdateStatus, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

class ManualScheduler {
  nowMs = 0;
  private nextId = 1;
  private readonly timeouts = new Map<number, { callback: () => void; at: number; delay: number }>();
  private readonly intervals = new Map<number, { callback: () => void; delay: number }>();

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, at: this.nowMs + delay, delay });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  nextTimeoutDelay(): number | undefined {
    return [...this.timeouts.values()].sort((a, b) => a.at - b.at)[0]?.delay;
  }

  intervalDelay(): number | undefined {
    return this.intervals.values().next().value?.delay;
  }

  runNextTimeout(): void {
    const next = [...this.timeouts.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
    assert.ok(next, "expected a pending timeout");
    const [id, task] = next;
    this.timeouts.delete(id);
    this.nowMs = Math.max(this.nowMs, task.at);
    task.callback();
  }

  runInterval(): void {
    const interval = this.intervals.values().next().value;
    assert.ok(interval, "expected an hourly interval");
    interval.callback();
  }
}
