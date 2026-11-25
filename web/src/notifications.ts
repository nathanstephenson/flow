import { useEffect, useSyncExternalStore } from "react";

import { useHost } from "@/host.tsx";
import { formatRoute } from "@/presentation/route.ts";

const KEY = "flow.notifications";
const listeners = new Set<() => void>();

export const notificationsSupported = typeof window !== "undefined" && "Notification" in window;

export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, read);
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // The choice still applies until the page reloads.
  }
  for (const listener of listeners) listener();
}

export function useAttentionNotifications(): void {
  const { connection } = useHost();
  const enabled = useNotificationsEnabled();

  useEffect(() => {
    if (!enabled || !notificationsSupported) return;
    return connection.subscribeAttention((raised) => {
      if (!document.hidden || Notification.permission !== "granted") return;
      const notification = new Notification(raised.title, { body: raised.reason, tag: raised.sessionId });
      notification.onclick = () => {
        window.focus();
        window.location.hash = formatRoute({ sessionId: raised.sessionId });
        notification.close();
      };
    });
  }, [connection, enabled]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
