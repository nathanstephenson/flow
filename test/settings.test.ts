import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOrCreateToken } from "../src/daemon/auth.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";
import {
  DEFAULT_CHROME_FONT,
  DEFAULT_MONOSPACE_FONT,
  DEFAULT_SETTLED_RETENTION,
  formatDuration,
  parseDuration,
} from "../src/daemon/config.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import type { Settings } from "../src/protocol/settings.ts";

/**
 * The Settings, from the file up to the wire.
 *
 * Two rules carry most of this: reading is lenient and writing is strict, and there is exactly one
 * copy of a Setting in the process. The second is why the reaper is handed `ConfigStore.retention`
 * rather than a number — the test at the bottom is the one that would catch a regression to a
 * snapshot, which would present as "my change only applies after a restart".
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("the Settings on disk", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-settings-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<string, unknown>;

  it("reports the defaults when there is no file, in the units a person typed", () => {
    const store = new ConfigStore(root);
    assert.deepEqual(store.view(), {
      retention: { settled: "1d" },
      fonts: { chrome: DEFAULT_CHROME_FONT, monospace: DEFAULT_MONOSPACE_FONT },
    });
    assert.equal(store.warning, undefined, "an absent file is normal, not a warning");
  });

  it("writes a patch through and reports the merged result", () => {
    const store = new ConfigStore(root);
    const updated = store.update({ fonts: { monospace: "'Hack Nerd Font', monospace" } });

    assert.equal(updated.fonts.monospace, "'Hack Nerd Font', monospace");
    assert.equal(updated.fonts.chrome, DEFAULT_CHROME_FONT, "an untouched field keeps its value");
    assert.equal(updated.retention.settled, "1d");
    // And on disk, so the next daemon agrees with this one.
    assert.deepEqual(new ConfigStore(root).view(), updated);
  });

  it("merges section by section, so saving one does not revert the other", () => {
    const store = new ConfigStore(root);
    store.update({ retention: { settled: "36h" } });
    store.update({ fonts: { chrome: "Berkeley Mono" } });

    const view = store.view();
    assert.equal(view.retention.settled, "36h", "the earlier save survived the later one");
    assert.equal(view.fonts.chrome, "Berkeley Mono");
  });

  /**
   * Someone hand-writes a key this daemon has never heard of. Editing a font in a browser must not
   * be what deletes it — a read-modify-write against the file is the only way that holds.
   */
  it("preserves a key it does not know about", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ experiment: { widgets: 3 } }));
    new ConfigStore(root).update({ fonts: { chrome: "Berkeley Mono" } });

    assert.deepEqual(file().experiment, { widgets: 3 });
  });

  it("refuses a value rather than warning and keeping the old one", () => {
    const store = new ConfigStore(root);
    assert.throws(
      () => store.update({ fonts: { chrome: "red; background: url(http://evil)" } }),
      /fonts\.chrome/,
    );
    // Nothing changed, and nothing was written: a refused patch is not a partial one.
    assert.equal(store.view().fonts.chrome, DEFAULT_CHROME_FONT);
    assert.throws(() => file(), "a refused patch must not create the file");
  });

  it("refuses a duration it cannot read, and a zero one", () => {
    const store = new ConfigStore(root);
    assert.throws(() => store.update({ retention: { settled: "1 fortnight" } }), /duration/);
    // Zero parses, and would reap every Settled Agent Session on the next sweep. "never" is how you
    // say "do not reap"; zero is how you say it by accident.
    assert.throws(() => store.update({ retention: { settled: "0s" } }), /longer than zero/);
    assert.equal(store.current().retention.settled, DEFAULT_SETTLED_RETENTION);
  });

  it("refuses a field it does not recognise, rather than silently ignoring it", () => {
    // A setting that reports success and does not stick is the failure this prevents.
    const store = new ConfigStore(root);
    assert.throws(() => store.update({ fonts: { serif: "Georgia" } } as never), /serif/);
    assert.throws(() => store.update({ theme: "dark" } as never), /theme/);
  });

  it("accepts 'never', which is how reaping is switched off", () => {
    const store = new ConfigStore(root);
    assert.equal(store.update({ retention: { settled: "never" } }).retention.settled, "never");
    assert.equal(store.current().retention.settled, "never");
  });

  it("still starts, and still says why, when the file is malformed", () => {
    writeFileSync(join(root, "config.json"), "{ not json");
    const store = new ConfigStore(root);
    assert.match(store.warning ?? "", /valid JSON/);
    assert.equal(store.view().retention.settled, "1d", "the defaults stand");
  });
});

describe("a duration round-trips", () => {
  it("comes back in the largest unit that divides evenly", () => {
    assert.equal(formatDuration(DAY), "1d");
    assert.equal(formatDuration(36 * HOUR), "36h");
    assert.equal(formatDuration(90 * 60 * 1000), "90m");
    assert.equal(formatDuration(30_000), "30s");
  });

  it("survives the trip through parseDuration, which is what the settings page depends on", () => {
    for (const ms of [1000, 30_000, 90 * 60 * 1000, HOUR, 36 * HOUR, DAY, 7 * DAY]) {
      assert.equal(parseDuration(formatDuration(ms)), ms, `${ms} did not round-trip`);
    }
  });

  it("does not pretend a sub-second value is a whole unit", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(500), "0.5s");
  });
});

describe("the Settings over the wire", () => {
  let root: string;
  let running: RunningServer;
  let token: string;
  let config: ConfigStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "goodharness-settings-http-"));
    token = readOrCreateToken(root);
    config = new ConfigStore(root);
    running = await serve({ host: new SessionHost(), token, config });
  });

  afterEach(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  const put = (body: unknown): Promise<Response> =>
    fetch(`${running.url}/api/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const get = async (): Promise<Settings> => {
    const response = await fetch(`${running.url}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await response.json()) as Settings;
  };

  it("reports the Settings alongside the rest of the config", async () => {
    const body = await get();
    assert.deepEqual(body.retention, { settled: "1d" });
    assert.equal(body.fonts.monospace, DEFAULT_MONOSPACE_FONT);
  });

  it("takes a patch and reports the result back", async () => {
    const response = await put({ fonts: { chrome: "Berkeley Mono" } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Settings).fonts.chrome, "Berkeley Mono");

    // The next GET agrees, which is only true because serve() reads through the store rather than
    // holding the copy it was handed at startup.
    assert.equal((await get()).fonts.chrome, "Berkeley Mono");
  });

  it("answers 400 with the offending field, not 500 and not a silent 200", async () => {
    const response = await put({ retention: { settled: "1 fortnight" } });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /retention\.settled/);
    assert.equal((await get()).retention.settled, "1d", "nothing changed");
  });

  it("is behind the same gate as everything else", async () => {
    const response = await fetch(`${running.url}/api/config`, {
      method: "PUT",
      body: JSON.stringify({ fonts: { chrome: "Berkeley Mono" } }),
    });
    assert.equal(response.status, 401);
  });
});

/**
 * The reason `retention` is a function and not a number.
 *
 * The reaper is handed `ConfigStore.retention` so it asks at each sweep. Copy the value in at
 * construction instead and this test fails — which is exactly the bug a reader would report as
 * "changing retention did nothing until I restarted the daemon".
 */
describe("a retention change reaches a running host", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-settings-reap-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies at the next sweep, without a restart", async () => {
    const config = new ConfigStore(root);
    config.update({ retention: { settled: "never" } });

    const host = new SessionHost({ retention: config.retention });
    const { FakeBackend } = await import("../src/backend/fake/index.ts");
    host.registerBackend(new FakeBackend());
    const sessionId = await host.create({ scope: root, backend: "fake" });
    await host.settle(sessionId);

    const wellPast = Date.now() + 10 * DAY;
    assert.deepEqual(host.reap(wellPast), [], "'never' means never");

    config.update({ retention: { settled: "1h" } });
    assert.deepEqual(host.reap(wellPast), [sessionId], "the sweep read the new window");
  });
});
