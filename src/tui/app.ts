import type { Connection } from "../client/connection.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import type { SessionSummary } from "../protocol/commands.ts";
import { isPrintable, KEY, splitKeys } from "./keys.ts";
import { effortChoices, modelChoices, renderFrame, type Overlay, type UiState } from "./render.ts";

/**
 * The terminal client. It speaks only to a Connection — never to a Session Host directly — which is
 * what keeps the TUI and the web UI honest about being the same kind of client.
 */

export type TuiOptions = {
  connection: Connection;
  scope: string;
  backend: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

export async function runTui(options: TuiOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  let sessions: SessionSummary[] = await options.connection.listSessions();
  let selected: string | undefined = sessions[0]?.id;
  let view: ViewState = initialState();
  let input = "";
  let overlay: Overlay = { kind: "none" };
  let notice: string | undefined;
  let unsubscribe: (() => void) | undefined;

  const draw = (): void => {
    const ui: UiState = { sessions, selected, view, input, overlay, ...(notice ? { notice } : {}) };
    const frame = renderFrame(ui, { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.write(`[H[2J${frame.join("\r\n")}`);
  };

  const attach = (sessionId: string): void => {
    unsubscribe?.();
    selected = sessionId;
    view = initialState();
    unsubscribe = options.connection.subscribe({
      sessionId,
      since: 0,
      onEntry: (entry) => {
        view = reduce(view, entry);
        draw();
      },
      onError: (error) => {
        notice = error.message;
        draw();
      },
    });
    draw();
  };

  const refreshSessions = async (): Promise<void> => {
    sessions = await options.connection.listSessions();
  };

  const newSession = async (): Promise<void> => {
    const id = await options.connection.command<string>({
      type: "create",
      scope: options.scope,
      backend: options.backend,
    });
    await refreshSessions();
    attach(id);
  };

  if (selected) attach(selected);
  else await newSession();

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.on("resize", draw);

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      unsubscribe?.();
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("[H[2J");
      resolve();
    };

    // Chunks are processed one at a time. handleKey is async, so without this a chunk arriving
    // mid-walk would interleave with the previous one and keys would be applied out of order.
    let pending: Promise<void> = Promise.resolve();
    stdin.on("data", (chunk: string) => {
      pending = pending.then(async () => {
        try {
          for (const key of splitKeys(chunk)) {
            if (await handleKey(key)) {
              finish();
              return;
            }
          }
        } catch (error) {
          notice = error instanceof Error ? error.message : String(error);
          draw();
        }
      });
    });
  });

  /** Returns true when the app should exit. */
  async function handleKey(key: string): Promise<boolean> {
    if (key === KEY.ctrlC) return true;

    if (overlay.kind !== "none") {
      await handleOverlayKey(key);
      draw();
      return false;
    }

    if (key === KEY.ctrlS) {
      await refreshSessions();
      const index = sessions.findIndex((session) => session.id === selected);
      overlay = { kind: "sessions", index: Math.max(0, index) };
    } else if (key === KEY.ctrlP) {
      overlay = { kind: "models", index: 0 };
    } else if (key === KEY.ctrlE) {
      overlay = { kind: "effort", index: Math.max(0, effortChoices(view).indexOf(view.effort ?? "off")) };
    } else if (key === KEY.escape) {
      if (selected) await options.connection.command({ type: "abort", sessionId: selected });
    } else if (key === KEY.enter || key === KEY.newline) {
      await submit();
    } else if (key === KEY.backspace || key === KEY.backspaceAlt) {
      input = input.slice(0, -1);
    } else if (isPrintable(key)) {
      input += key;
    }

    draw();
    return false;
  }

  async function handleOverlayKey(key: string): Promise<void> {
    // Snapshot the overlay: TypeScript cannot narrow a mutable closure variable across a guard.
    const current = overlay;
    if (current.kind === "none") return;

    if (key === KEY.escape) {
      overlay = { kind: "none" };
      return;
    }

    const length =
      current.kind === "sessions"
        ? sessions.length
        : current.kind === "effort"
          ? effortChoices(view).length
          : modelChoices(view.capabilities).length;

    if (key === KEY.up) {
      overlay = { ...current, index: Math.max(0, current.index - 1) };
      return;
    }
    if (key === KEY.down) {
      overlay = { ...current, index: Math.min(length - 1, current.index + 1) };
      return;
    }
    if (key === "n" && current.kind === "sessions") {
      overlay = { kind: "none" };
      await newSession();
      return;
    }
    if (key !== KEY.enter && key !== KEY.newline) return;

    if (current.kind === "sessions") {
      const chosen = sessions[current.index];
      overlay = { kind: "none" };
      if (chosen) attach(chosen.id);
      return;
    }

    if (current.kind === "effort") {
      const effort = effortChoices(view)[current.index];
      overlay = { kind: "none" };
      if (effort && selected) {
        await options.connection.command({ type: "set_effort", sessionId: selected, effort });
        notice = `effort → ${effort}`;
      }
      return;
    }

    const choice = modelChoices(view.capabilities)[current.index];
    overlay = { kind: "none" };
    if (choice && selected) {
      await options.connection.command({ type: "set_model", sessionId: selected, modelId: choice.model.id });
      notice = `model → ${choice.model.label ?? choice.model.id}`;
    }
  }

  async function submit(): Promise<void> {
    const text = input.trim();
    if (!text || !selected) return;
    input = "";
    // Typing while the agent works queues rather than interrupts; steering is a deliberate act.
    const when = view.status === "running" ? "after_turn" : "now";
    await options.connection.command({ type: "send", sessionId: selected, text, when });
  }
}
