import { useState } from "react";

import { SettingsGroup } from "@/components/settings-parts.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { notificationsSupported, setNotificationsEnabled, useNotificationsEnabled } from "@/notifications.ts";

export function NotificationSettings() {
  const enabled = useNotificationsEnabled();
  const [blocked, setBlocked] = useState(() => notificationsSupported && Notification.permission === "denied");

  const toggle = async (on: boolean): Promise<void> => {
    if (on && (await Notification.requestPermission()) !== "granted") {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    setNotificationsEnabled(on);
  };

  return (
    <SettingsGroup title="Notifications" description="This browser only.">
      <label className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-1">
          <span className="text-sm">Notify when an Agent Session needs attention</span>
          <span className="text-xs text-muted-foreground">
            {!notificationsSupported
              ? "This browser does not allow notifications on this address. Use localhost or HTTPS."
              : blocked
                ? "Blocked in browser settings."
                : "Only while the Flow tab is hidden."}
          </span>
        </span>
        <Switch
          checked={enabled && !blocked}
          disabled={!notificationsSupported}
          onCheckedChange={(on) => void toggle(on)}
        />
      </label>
    </SettingsGroup>
  );
}
