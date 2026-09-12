import type { PullRequest } from "../../../src/protocol/publish.ts";
import type { PullRequestRef } from "../../../src/protocol/pull-request.ts";

export function pullRequestKey(pr: PullRequestRef): string {
  return `${pr.repo}#${pr.number}:${pr.id}`;
}

export function safePullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function readableStatus(value: string): string {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Unknown";
}

export function checkStatus(check: PullRequest["statusCheckRollup"][number]): string {
  return check.conclusion || check.state || check.status || "UNKNOWN";
}

export function checksSummary(checks: PullRequest["statusCheckRollup"]): string {
  if (!checks.length) return "No checks reported.";
  let passed = 0, failed = 0, pending = 0, other = 0;
  for (const check of checks) {
    const status = checkStatus(check).toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(status)) passed++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(status)) failed++;
    else if (["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"].includes(status)) pending++;
    else other++;
  }
  return [`${passed} passed`, `${failed} failed`, `${pending} pending`, ...(other ? [`${other} unknown`] : [])].join(" · ");
}

export type PullRequestLoadState<T> = { value: T | undefined; busy: boolean; error: string; success: string };

export class PullRequestLoader<T> {
  private active = true;
  private locked = false;
  private state: PullRequestLoadState<T> = { value: undefined, busy: false, error: "", success: "" };

  private load: () => Promise<T>;
  private changed: (state: PullRequestLoadState<T>) => void;

  constructor(load: () => Promise<T>, changed: (state: PullRequestLoadState<T>) => void) {
    this.load = load;
    this.changed = changed;
  }

  dispose() { this.active = false; }

  private update(patch: Partial<PullRequestLoadState<T>>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  private async read() {
    try { this.update({ value: await this.load(), error: "" }); }
    catch (error) { this.update({ error: `Pull request could not refresh. ${String(error)}` }); }
  }

  async refresh() {
    if (!this.active || this.locked) return;
    this.locked = true;
    this.update({ busy: true });
    try { await this.read(); }
    finally { this.locked = false; this.update({ busy: false }); }
  }

  async write(action: () => Promise<void>, success: string, confirmed: () => void, accepts: (value: T | undefined) => boolean = () => true) {
    if (!this.active || this.locked || !accepts(this.state.value)) return;
    this.locked = true;
    this.update({ busy: true, error: "", success: "" });
    try {
      await action();
      if (!this.active) return;
      confirmed();
      this.update({ success });
      await this.read();
    } catch (error) { this.update({ error: String(error) }); }
    finally { this.locked = false; this.update({ busy: false }); }
  }
}
