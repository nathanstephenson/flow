import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../src/backend/fake/index.ts";
import {
  DEFAULT_CHROME_FONT,
  DEFAULT_MONOSPACE_FONT,
  DEFAULT_SETTLED_RETENTION,
  loadConfig,
  parseDuration,
} from "../src/daemon/config.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { reduceAll } from "../src/client/reduce.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Settling, and the retention window that reaps what has been settled (ADR 0006). */
describe("settling and reaping", () => {
  let root: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-"));
    store = new TranscriptStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function hostWith(retention: number | "never"): Promise<{ host: SessionHost; backend: FakeBackend }> {
    const backend = new FakeBackend();
    const host = new SessionHost({ store, retention });
    host.registerBackend(backend);
    await host.load();
    return { host, backend };
  }

  it("stops the Backend Session and records Settled without ending the Agent Session", async () => {
    const { host, backend } = await hostWith(DAY);
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    const session = backend.latest;

    await host.settle(id);

    assert.equal(session.disposed, true);
    assert.equal(host.statusOf(id), "settled");
    assert.equal(host.logFor(id).since(0).at(-1)?.event.type, "session_settled");
  });

  it("un-settles on send, continuing the same Presentation Transcript", async () => {
    const { host } = await hostWith(DAY);
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.send(id, "before", "now");
    await host.settle(id);

    await host.send(id, "after", "now");

    assert.equal(host.statusOf(id), "running");
    const types = host.logFor(id).since(0).map((entry) => entry.event.type);
    assert.ok(types.includes("session_settled"));
    assert.ok(types.lastIndexOf("revived") > types.indexOf("session_settled"));
    // The transcript continues rather than restarting: both messages are still in it.
    const said = host
      .logFor(id)
      .since(0)
      .flatMap((entry) => (entry.event.type === "user_message" ? [entry.event.text] : []));
    assert.deepEqual(said, ["before", "after"]);
  });

  it("reaps a Settled Agent Session once its window has passed", async () => {
    const { host } = await hostWith(DAY);
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.settle(id);

    assert.deepEqual(host.reap(Date.now() + DAY - 1000), [], "still inside the window");
    assert.ok(existsSync(store.sessionDir(id)));

    assert.deepEqual(host.reap(Date.now() + DAY + 1000), [id]);
    assert.equal(existsSync(store.sessionDir(id)), false, "the session directory is gone");
    assert.deepEqual(host.list(), [], "and it is gone from the rail");
  });

  it("leaves Agent Sessions that were never settled alone, however old", async () => {
    const { host } = await hostWith(DAY);
    const idle = await host.create({ scope: "/tmp/scope", backend: "fake" });
    const dormant = await host.create({ scope: "/tmp/scope", backend: "fake" });
    const ended = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.dispose(ended);
    await host.shutdown();

    assert.deepEqual(host.reap(Date.now() + 365 * DAY), []);
    for (const id of [idle, dormant, ended]) assert.ok(existsSync(store.sessionDir(id)));
  });

  it("never reaps when retention is disabled", async () => {
    const { host } = await hostWith("never");
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.settle(id);

    assert.deepEqual(host.reap(Date.now() + 365 * DAY), []);
    assert.ok(existsSync(store.sessionDir(id)));
  });

  it("keeps a session Settled across a restart, so the clock is not reset by a daemon bounce", async () => {
    const first = await hostWith(DAY);
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.settle(id);

    const second = await hostWith(DAY);
    assert.equal(second.host.statusOf(id), "settled");
    assert.deepEqual(second.host.reap(Date.now() + DAY + 1000), [id]);
  });

  it("sweeps on load, so a host that was off catches up on the way in", async () => {
    const first = await hostWith(DAY);
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.settle(id);
    // Backdate the settle so the window has already passed by the time the next host loads.
    const meta = store.readMeta(id);
    assert.ok(meta);
    store.writeMeta({ ...meta, updatedAt: new Date(Date.now() - 2 * DAY).toISOString() });

    const second = await hostWith(DAY);

    assert.deepEqual(second.host.list(), []);
    assert.equal(existsSync(store.sessionDir(id)), false);
  });

  /**
   * Regression: settling mid-turn used to leave turn_started unclosed, so the restart path appended
   * turn_ended *after* session_settled — and a trailing turn_ended reduces to idle, leaving the rail
   * and the pane disagreeing about the same Agent Session.
   */
  it("closes an interrupted turn, so a restart still reduces to settled", async () => {
    const first = await hostWith(DAY);
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    await first.host.settle(id);

    const types = first.host.logFor(id).since(0).map((entry) => entry.event.type);
    assert.equal(types.at(-1), "session_settled");
    assert.equal(types.at(-2), "turn_ended", "the interrupted turn is closed before the Settle");

    const second = await hostWith(DAY);
    assert.equal(second.host.statusOf(id), "settled");
    assert.equal(
      reduceAll(second.host.logFor(id).since(0)).status,
      "settled",
      "what the client reduces must agree with what the host reports",
    );
  });

  it("sinks Settled Agent Sessions to the bottom of the list", async () => {
    const { host } = await hostWith(DAY);
    const older = await host.create({ scope: "/tmp/a", backend: "fake" });
    const newer = await host.create({ scope: "/tmp/b", backend: "fake" });

    // Settling `older` is the most recent activity, so a plain recency sort would float it to the
    // top — exactly the session its owner is done with.
    await host.settle(older);

    assert.deepEqual(
      host.list().map((summary) => summary.id),
      [newer, older],
    );
    assert.equal(host.list().at(-1)?.status, "settled");
  });

  it("refuses to settle an Agent Session that has ended", async () => {
    const { host } = await hostWith(DAY);
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.dispose(id);
    await assert.rejects(() => host.settle(id), /has ended/);
  });

  it("accepts a settle command over the wire", async () => {
    const { host } = await hostWith(DAY);
    const id = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.execute({ type: "settle", sessionId: id });
    assert.equal(host.statusOf(id), "settled");
  });
});

describe("config", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (body: string): void => writeFileSync(join(root, "config.json"), body);

  it("reads a duration", () => {
    write(JSON.stringify({ retention: { settled: "36h" } }));
    assert.deepEqual(loadConfig(root).config.retention.settled, 36 * 60 * 60 * 1000);
  });

  it("reads 'never' as reaping disabled", () => {
    write(JSON.stringify({ retention: { settled: "never" } }));
    assert.equal(loadConfig(root).config.retention.settled, "never");
  });

  it("defaults to a day when there is no config file", () => {
    const { config, warning } = loadConfig(root);
    assert.equal(config.retention.settled, DEFAULT_SETTLED_RETENTION);
    assert.equal(warning, undefined, "an absent config file is normal, not a warning");
  });

  /** A typo must not stop the daemon that owns your transcripts from starting. */
  it("falls back to the default and warns on a malformed file", () => {
    write("{ not json");
    const { config, warning } = loadConfig(root);
    assert.equal(config.retention.settled, DEFAULT_SETTLED_RETENTION);
    assert.match(warning ?? "", /valid JSON/);
  });

  it("falls back to the default and warns on an unreadable duration", () => {
    write(JSON.stringify({ retention: { settled: "1 fortnight" } }));
    const { config, warning } = loadConfig(root);
    assert.equal(config.retention.settled, DEFAULT_SETTLED_RETENTION);
    assert.match(warning ?? "", /duration/);
  });

  it("parses durations, and rejects what is not one", () => {
    assert.equal(parseDuration("90m"), 90 * 60 * 1000);
    assert.equal(parseDuration("36h"), 36 * 60 * 60 * 1000);
    assert.equal(parseDuration("1d"), DAY);
    assert.equal(parseDuration("30s"), 30_000);
    for (const junk of ["", "1", "d", "1w", "-1d", "one day", "1dd"]) {
      assert.equal(parseDuration(junk), undefined, `expected ${junk} to be rejected`);
    }
  });

  /**
   * The fonts, which exist so a Shell can render a Powerline prompt: those separators live in the
   * Private Use Area and no stock system font has them, so the reader has to be able to name one
   * that does.
   */
  describe("fonts", () => {
    it("reads both typefaces", () => {
      write(JSON.stringify({ fonts: { chrome: "Berkeley Mono", monospace: "MesloLGS NF, monospace" } }));
      const { config, warning } = loadConfig(root);
      assert.equal(config.fonts.chrome, "Berkeley Mono");
      assert.equal(config.fonts.monospace, "MesloLGS NF, monospace");
      assert.equal(warning, undefined);
    });

    it("defaults each one independently, so naming only the mono font is enough", () => {
      write(JSON.stringify({ fonts: { monospace: "'Hack Nerd Font', monospace" } }));
      const { config, warning } = loadConfig(root);
      assert.equal(config.fonts.monospace, "'Hack Nerd Font', monospace");
      assert.equal(config.fonts.chrome, DEFAULT_CHROME_FONT, "an unset typeface keeps its default");
      assert.equal(warning, undefined);
    });

    it("ships a default monospace stack that names the fonts a Powerline prompt needs", () => {
      const { config } = loadConfig(root);
      assert.match(config.fonts.monospace, /Nerd Font|MesloLGS/, "tofu out of the box otherwise");
    });

    it("refuses a value that is not a font-family list, and says which field", () => {
      write(JSON.stringify({ fonts: { chrome: "red; background: url(http://evil)" } }));
      const { config, warning } = loadConfig(root);
      assert.equal(config.fonts.chrome, DEFAULT_CHROME_FONT);
      assert.match(warning ?? "", /fonts\.chrome/);
    });

    it("refuses a non-string and an empty string", () => {
      write(JSON.stringify({ fonts: { chrome: 12, monospace: "   " } }));
      const { config, warning } = loadConfig(root);
      assert.equal(config.fonts.chrome, DEFAULT_CHROME_FONT);
      assert.equal(config.fonts.monospace, DEFAULT_MONOSPACE_FONT);
      assert.match(warning ?? "", /fonts\.chrome/);
      assert.match(warning ?? "", /fonts\.monospace/);
    });

    /** One bad section must not cost the other its value: they are parsed independently. */
    it("keeps a good retention alongside a bad font, and warns about the font only", () => {
      write(JSON.stringify({ retention: { settled: "36h" }, fonts: { monospace: "}{" } }));
      const { config, warning } = loadConfig(root);
      assert.equal(config.retention.settled, 36 * 60 * 60 * 1000);
      assert.equal(config.fonts.monospace, DEFAULT_MONOSPACE_FONT);
      assert.match(warning ?? "", /fonts\.monospace/);
      assert.doesNotMatch(warning ?? "", /duration/);
    });
  });
});
