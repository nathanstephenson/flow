import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";

import { ShellRegistry } from "../src/daemon/shell.ts";
import type { ShellSummary } from "../src/protocol/shells.ts";

/**
 * The Shells, against a real pty.
 *
 * A real one rather than a fake, because everything worth asserting here is about the pty's
 * behaviour and not about the bookkeeping around it: that the Scrollback replays to a reattaching
 * client, that detaching is not killing, and that killFor reaches every Shell beside one Agent
 * Session. A fake pty would let all four pass while the feature was broken.
 */

/** Collects output until `match` appears, so a test never depends on chunk boundaries. */
function collector(): { chunks: string[]; text(): string; sink: { output(c: Buffer): void; exit(): void } } {
  const chunks: string[] = [];
  let exited = false;
  return {
    chunks,
    text: () => chunks.join(""),
    sink: {
      output: (chunk: Buffer) => chunks.push(chunk.toString("utf8")),
      exit: () => {
        exited = true;
        void exited;
      },
    },
  };
}

async function waitFor(read: () => string, needle: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(read())}`);
}

describe("a build that cannot load a pty", () => {
  // The single-executable build is this case: a SEA blob cannot contain a native addon, and the
  // `import("node-pty")` it keeps resolves against the path baked in at build time, which is not
  // there on the machine the binary is shipped to. The promise is that this degrades — /api/config
  // says `shell: false` and the web client hides the control — rather than throwing somewhere odd.
  const unavailable = () => new ShellRegistry({ loadPty: () => Promise.reject(new Error("no addon")) });

  it("reports itself unavailable rather than throwing", async () => {
    assert.equal(await unavailable().available(), false);
  });

  it("refuses to create a Shell, and says why", async () => {
    await assert.rejects(
      unavailable().create({ sessionId: "s1", cwd: tmpdir() }),
      /cannot open a Shell/,
    );
  });

  it("does not retry the failed load on every call", async () => {
    let attempts = 0;
    const shells = new ShellRegistry({
      loadPty: () => {
        attempts += 1;
        return Promise.reject(new Error("no addon"));
      },
    });
    await shells.available();
    await shells.available();
    assert.equal(attempts, 1);
  });
});

describe("Shells", () => {
  it("runs a command in the Agent Session's Scope and streams its output", async (t) => {
    const shells = new ShellRegistry();
    if (!(await shells.available())) return t.skip("no pty in this environment");
    t.after(() => shells.killAll());

    const shell = await shells.create({ sessionId: "s1", cwd: tmpdir(), cols: 80, rows: 24 });
    const watcher = collector();
    shells.attach(shell.id, watcher.sink);

    shells.write(shell.id, Buffer.from("echo scope-is-$PWD\r"));
    await waitFor(watcher.text, `scope-is-${tmpdir()}`);
  });

  it("replays the Scrollback to a client that reattaches, and detaching does not kill", async (t) => {
    const shells = new ShellRegistry();
    if (!(await shells.available())) return t.skip("no pty in this environment");
    t.after(() => shells.killAll());

    const shell = await shells.create({ sessionId: "s1", cwd: tmpdir() });
    const first = collector();
    const detach = shells.attach(shell.id, first.sink);
    shells.write(shell.id, Buffer.from("echo before-detach\r"));
    await waitFor(first.text, "before-detach");

    // Closing the pane is hide, not kill: the Shell must still be there to write to.
    detach();
    const second = collector();
    shells.attach(shell.id, second.sink);

    assert.match(second.text(), /before-detach/, "reattach should replay the Scrollback");
    shells.write(shell.id, Buffer.from("echo after-reattach\r"));
    await waitFor(second.text, "after-reattach");
  });

  it("exits every Shell beside a Settled Agent Session, and leaves the others alone", async (t) => {
    const shells = new ShellRegistry();
    if (!(await shells.available())) return t.skip("no pty in this environment");
    t.after(() => shells.killAll());

    // Two on one Agent Session, because a Shell is not identified by the Agent Session it sits
    // beside — killFor has to reach both.
    const doomed: ShellSummary[] = [
      await shells.create({ sessionId: "settled", cwd: tmpdir() }),
      await shells.create({ sessionId: "settled", cwd: tmpdir() }),
    ];
    const survivor = await shells.create({ sessionId: "other", cwd: tmpdir() });

    shells.killFor("settled");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && doomed.some((shell) => shells.get(shell.id))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const shell of doomed) assert.equal(shells.get(shell.id), undefined);
    assert.ok(shells.get(survivor.id), "a Shell beside another Agent Session must survive");
  });

  it("keeps the Scrollback bounded rather than growing without limit", async (t) => {
    const shells = new ShellRegistry();
    if (!(await shells.available())) return t.skip("no pty in this environment");
    t.after(() => shells.killAll());

    const shell = await shells.create({ sessionId: "s1", cwd: tmpdir() });
    const watcher = collector();
    shells.attach(shell.id, watcher.sink);

    // Comfortably more than the 256 KiB limit. The end marker is *computed* by the shell rather
    // than typed, because a pty echoes the command line back — waiting for a literal marker would
    // match the echo and let this test pass without any output ever being produced.
    shells.write(
      shell.id,
      Buffer.from("for i in $(seq 1 20000); do echo aaaaaaaaaaaaaaaaaaaaaaaa; done; echo FLOOD-$((20+3))\r"),
    );
    await waitFor(watcher.text, "FLOOD-23", 60000);

    const replayed = collector();
    shells.attach(shell.id, replayed.sink);
    const bytes = Buffer.byteLength(replayed.text(), "utf8");
    assert.ok(bytes > 64 * 1024, `only ${bytes} bytes replayed; the flood did not happen`);
    assert.ok(bytes <= 512 * 1024, `Scrollback replayed ${bytes} bytes; it is meant to be bounded`);
    assert.match(replayed.text(), /FLOOD-23/, "the most recent output must survive the trim");
  });
});
