import { parseArgs } from "node:util";

import { ClaudeBackend } from "../backend/claude/index.ts";
import { FakeBackend } from "../backend/fake/index.ts";
import { PiBackend } from "../backend/pi/index.ts";
import { SessionHost } from "../daemon/host.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";

/**
 * M0 walking skeleton: create an Agent Session, send one prompt, render the Presentation
 * Transcript as it arrives. Host, adapter, log and reducer, composed the way the daemon will.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: "string", default: process.cwd() },
      backend: { type: "string", default: "claude" },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const prompt = positionals.join(" ").trim();
  if (values.help || !prompt) {
    console.log("usage: goodharness [--scope DIR] [--backend claude|pi|fake] [--model ID] \"<prompt>\"");
    return prompt ? 0 : 1;
  }

  const host = new SessionHost();
  host.registerBackend(new ClaudeBackend());
  host.registerBackend(new PiBackend());
  host.registerBackend(new FakeBackend());

  const sessionId = await host.create({
    scope: values.scope ?? process.cwd(),
    backend: values.backend ?? "claude",
    ...(values.model ? { modelId: values.model } : {}),
  });

  const log = host.logFor(sessionId);
  let state: ViewState = initialState();
  let rendered = 0;
  let done: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const unsubscribe = log.subscribe((entry) => {
    state = reduce(state, entry);
    rendered = render(state, rendered);
    if (entry.event.type === "turn_ended") done?.();
  });

  for (const entry of log.since(0)) state = reduce(state, entry);

  await host.send(sessionId, prompt, "now");
  await finished;

  render(state, rendered, true);
  unsubscribe();
  await host.dispose(sessionId);
  return 0;
}

/**
 * Print entries settled since the last render. The final entry is held back while the turn runs,
 * because assistant text arrives as snapshots that keep growing; `flush` releases it at turn end.
 */
function render(state: ViewState, alreadyRendered: number, flush = false): number {
  const settled = flush ? state.entries.length : state.entries.length - 1;
  for (let index = alreadyRendered; index < settled; index += 1) {
    const entry = state.entries[index];
    if (entry) console.log(format(entry));
  }
  return Math.max(alreadyRendered, settled);
}

function format(entry: NonNullable<ViewState["entries"][number]>): string {
  switch (entry.kind) {
    case "user":
      return `\n> ${entry.text}`;
    case "assistant":
      return `\n${entry.text}`;
    case "thinking":
      return `\n[thinking] ${entry.text}`;
    case "tool":
      return `  · ${entry.name} (${entry.status})`;
    case "notice":
      return `  ! ${entry.level}: ${entry.text}`;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
