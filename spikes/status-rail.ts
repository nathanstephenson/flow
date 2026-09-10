/**
 * A Session Host with four Agent Sessions parked in the four states the rail has to tell apart,
 * so the dot, the Subagent mark and the ordering can be looked at rather than only asserted.
 *
 * Driven through `FakeBackend` directly because the states it needs — a Permission Prompt open, a
 * Subagent backgrounded — are things a backend does to a session, and no HTTP route asks a backend
 * to do them.
 */
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve } from "../src/daemon/server.ts";
import { ShellRegistry } from "../src/daemon/shell.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { manifestOf } from "../src/web/manifest.ts";

const root = "/tmp/scratch-rail";
const store = new TranscriptStore(root);
const config = new ConfigStore(root);
const backend = new FakeBackend();
const host = new SessionHost({ store, retention: config.retention });
host.registerBackend(backend);

const gap = () => new Promise((resolve) => setTimeout(resolve, 5));

// Idle: a finished turn, and the plainest row there is.
const idle = await host.create({ scope: "/workspace/idle-one", backend: "fake" });
const idleSession = backend.latest;
await host.send(idle, "Tidy the imports in the parser", "now");
idleSession.say("Done — three unused imports removed.");
idleSession.completeTurn();
await gap();

// Running: a turn in flight, mid-stream.
const running = await host.create({ scope: "/workspace/running-one", backend: "fake" });
const runningSession = backend.latest;
await host.send(running, "Refactor the reducer", "now");
runningSession.say("Reading the reducer", false);
await gap();

// Awaiting: blocked on a Permission Prompt, which is the state that had a colour and no producer.
const awaiting = await host.create({ scope: "/workspace/awaiting-one", backend: "fake" });
const awaitingSession = backend.latest;
await host.send(awaiting, "Run the migration", "now");
awaitingSession.askPermission("Bash", { command: "npm run migrate" });
await gap();

// Idle with background Subagents: idle, because the model is (ADR 0016), and marked all the same.
const background = await host.create({ scope: "/workspace/background-one", backend: "fake" });
const backgroundSession = backend.latest;
await host.send(background, "Explore the codebase", "now");
const first = backgroundSession.beginSubagent("Explore", "sweep the daemon");
const second = backgroundSession.beginSubagent("Explore", "sweep the web client");
first.launch();
second.launch();
backgroundSession.completeTurn();
await gap();

const running_ = await serve({
  host,
  token: "spike-token",
  shells: new ShellRegistry(),
  config,
  store,
  assets: manifestOf("web/dist"),
  scope: process.cwd(),
  port: 4460,
});

// Keep the Running one streaming, which is the condition the rail used to reorder under: every one
// of these restamps `updatedAt`, and none of them may move the row.
let chunk = 0;
setInterval(() => {
  chunk += 1;
  runningSession.say(`still working, chunk ${chunk}`, false);
}, 200);

console.log(JSON.stringify({ url: running_.url, token: "spike-token" }));
console.log(
  JSON.stringify(
    host.list().map((s) => ({
      title: s.title,
      status: s.status,
      activeSubagents: s.activeSubagents,
      restingAt: s.restingAt,
    })),
    null,
    2,
  ),
);
