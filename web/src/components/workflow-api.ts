import { useEffect, useState } from "react";
import { authenticatedFetch } from "@/authentication.ts";

export async function workflowApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await authenticatedFetch(path, {
    method,
    signal,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}
export function useWorkflowResource<T>(
  path: string | undefined,
  interval = 3000,
) {
  const [snapshot, setSnapshot] = useState<{ path: string; data: T }>();
  const [error, setError] = useState("");
  useEffect(() => {
    setSnapshot(undefined);
    setError("");
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await workflowApi<T>(
          path,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSnapshot({ path, data: next });
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, interval);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, interval]);
  return { data: snapshot?.path === path ? snapshot?.data : undefined, error };
}
