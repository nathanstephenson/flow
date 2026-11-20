import { useEffect, useRef, useState } from "react";
import { workflowApi } from "./workflow-api.ts";

export function useScheduleMutation() {
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  async function mutate<T>(path: string, method: string, body: unknown, onSaved: (result: T) => void) {
    const signal = lifetime.current!.signal;
    setBusy(true);
    setError("");
    try {
      const result = await workflowApi<T>(path, method, body, signal);
      if (!signal.aborted) onSaved(result);
    } catch (error) {
      if (!signal.aborted) setError(String(error));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return { busy, error, mutate };
}
