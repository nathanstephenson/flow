import type { PlanLimitWindow, PlanLimitWindows } from "../../protocol/plan-limits.ts";
import { anthropicPlanLimits, type AnthropicUsage } from "../plan-limits.ts";

type CodexWindow = { used_percent: number; limit_window_seconds: number; reset_at: number } | null | undefined;
type CodexRateLimit = { primary_window?: CodexWindow; secondary_window?: CodexWindow } | null | undefined;

export type CodexUsage = {
  rate_limit?: CodexRateLimit;
  additional_rate_limits?: { limit_name: string; rate_limit?: CodexRateLimit }[] | null;
};

export async function fetchAnthropicPlanLimits(token: string, signal?: AbortSignal): Promise<PlanLimitWindows | undefined> {
  const usage = await getJson<AnthropicUsage>("https://api.anthropic.com/api/oauth/usage",
    { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal);
  const limits = anthropicPlanLimits(usage);
  return limits && { provider: "Anthropic", ...limits };
}

export async function fetchCodexPlanLimits(token: string, signal?: AbortSignal): Promise<PlanLimitWindows | undefined> {
  const usage = await getJson<CodexUsage>("https://chatgpt.com/backend-api/wham/usage",
    { authorization: `Bearer ${token}`, "chatgpt-account-id": codexAccountId(token), "user-agent": "codex-cli" }, signal);
  return codexPlanLimits(usage);
}

export function codexPlanLimits(usage: CodexUsage): PlanLimitWindows | undefined {
  const short = codexWindow("", usage.rate_limit?.primary_window);
  const long = codexWindow("", usage.rate_limit?.secondary_window);
  if (!short || !long) return undefined;
  const others = (usage.additional_rate_limits ?? []).flatMap((limit) => [
    codexWindow(`${limit.limit_name} `, limit.rate_limit?.primary_window),
    codexWindow(`${limit.limit_name} `, limit.rate_limit?.secondary_window),
  ]).filter((window) => window !== undefined);
  return { provider: "Codex", short, long, others };
}

function codexWindow(prefix: string, window: CodexWindow): PlanLimitWindow | undefined {
  if (!window) return undefined;
  const hours = window.limit_window_seconds / 3600;
  const span = hours < 24 ? `${Math.round(hours)}-hour` : `${Math.round(hours / 24)}-day`;
  return { label: `${prefix}${span}`, utilization: window.used_percent, resetsAt: new Date(window.reset_at * 1000).toISOString() };
}

function codexAccountId(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, { chatgpt_account_id?: string } | undefined>;
  const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!id) throw new Error("No ChatGPT account ID in the Codex token");
  return id;
}

async function getJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json() as T;
}
