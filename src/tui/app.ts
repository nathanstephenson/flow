import type { Connection } from "../client/connection.ts";
import { effortChoices, modelChoices } from "../client/model-choices.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import { sessionLabel } from "../client/session-label.ts";
import { canSettle } from "../client/status.ts";
import type { SessionSummary } from "../protocol/commands.ts";
import { isPrintable, KEY, splitKeys } from "./keys.ts";
import { renderFrame, type Overlay, type UiState } from "./render.ts";

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
    const ui: UiState = {
      sessions,
      selected,
      view,
      input,
      overlay,
      now: Date.now(),
      ...(notice ? { notice } : {}),
    };
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

  const newSession = async (worktree?: { from: string }): Promise<void> => {
    try {
      const id = await options.connection.command<string>({
        type: "create",
        scope: options.scope,
        backend: options.backend,
        ...(worktree === undefined ? {} : { worktree }),
      });
      await refreshSessions();
      attach(id);
    } catch (error) {
      // A worktree the host would not cut leaves no Agent Session at all, so there is nothing to
      // attach to and the reason is all there is to say.
      notice = error instanceof Error ? error.message : "could not start an Agent Session";
    }
  };

  /** The Scope of an Agent Session, for asking git about it. */
  const scopeOf = (sessionId: string | undefined): string | undefined =>
    sessions.find((session) => session.id === sessionId)?.scope;

  /**
   * Open the branch list, having asked for it first.
   *
   * Asked at the moment it is opened rather than held, because it changes outside GoodHarness — the
   * same reason `/api/branches` is a query. A Scope that is not a repository opens nothing and says
   * so, which is this client's version of hiding the control.
   */
  const openBranches = async (purpose: "switch" | "cut", scope: string | undefined): Promise<void> => {
    if (scope === undefined) return;
    let list;
    try {
      list = await options.connection.branches(scope);
    } catch (error) {
      notice = error instanceof Error ? error.message : "could not read branches";
      return;
    }
    if (!list.repository) {
      notice = `${scope} is not a git repository`;
      return;
    }

    const head = list.head?.detached ? undefined : list.head?.name;
    overlay = {
      kind: "branches",
      purpose,
      branches: list.branches,
      index: Math.max(0, head ? list.branches.indexOf(head) : 0),
      ...(head === undefined ? {} : { head }),
    };
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
    } else if (key === KEY.ctrlG) {
      await openBranches("switch", scopeOf(selected));
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
          : current.kind === "branches"
            ? current.branches.length
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
    if (key === "w" && current.kind === "sessions") {
      // A worktree needs a branch to be cut from, and the TUI has no text entry outside the prompt
      // line — so the base is picked from a list, and the new branch's name is derived by the host.
      await openBranches("cut", options.scope);
      return;
    }
    if (key === "s" && current.kind === "sessions") {
      const chosen = sessions[current.index];
      // A Settled Agent Session has nothing to Settle and an Ended one refuses, so offer neither.
      if (!chosen || !canSettle(chosen.status)) return;
      await options.connection.command({ type: "settle", sessionId: chosen.id });
      await refreshSessions();
      // Stay in the list rather than attaching. Settling is filing something away, not choosing
      // what to work on next, and the settled session has just sunk to the bottom anyway.
      overlay = { kind: "sessions", index: Math.min(current.index, Math.max(0, sessions.length - 1)) };
      notice = `settled ${sessionLabel(chosen)}`;
      return;
    }
    if (key !== KEY.enter && key !== KEY.newline) return;

    if (current.kind === "sessions") {
      const chosen = sessions[current.index];
      overlay = { kind: "none" };
      if (chosen) attach(chosen.id);
      return;
    }

    if (current.kind === "branches") {
      const branch = current.branches[current.index];
      const { purpose } = current;
      overlay = { kind: "none" };
      if (!branch) return;

      if (purpose === "cut") {
        await newSession({ from: branch });
        return;
      }
      if (!selected) return;
      try {
        await options.connection.command({ type: "switch_branch", sessionId: selected, branch });
        notice = `branch → ${branch}`;
      } catch (error) {
        // A refusal carries the reason — a turn in flight, or git's own words about a checkout it
        // would not make — and it is the whole of what is worth showing.
        notice = error instanceof Error ? error.message : `could not switch to ${branch}`;
      }
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
    // Always after_turn, never derived from our own status. The Session Host marks a turn in flight
    // when it dispatches rather than when the backend reports turn_started, and only after_turn is
    // guarded by that flag — so a client that believed itself idle on the strength of turn_started
    // would prompt a busy backend and bypass the Steering Queue ADR 0002 exists to own. after_turn
    // already means "queue if busy, else dispatch now", so it is identical in every other case.
    // "now" stays in the protocol for a deliberate interrupt-and-steer, which is not this.
    await options.connection.command({ type: "send", sessionId: selected, text, when: "after_turn" });
  }
}
