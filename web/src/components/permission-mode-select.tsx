import type { AgentPermissionMode } from "../../../src/protocol/events.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { QUIET_TRIGGER } from "@/lib/quiet-trigger.ts";

export function PermissionModeSelect({ backend, value, disabled, onChange }: {
  backend: string | undefined;
  value: AgentPermissionMode;
  disabled?: boolean;
  onChange: (mode: AgentPermissionMode) => void;
}) {
  if (backend !== "pi" && backend !== "claude") return null;
  return <Select value={value} disabled={disabled} onValueChange={(mode) => {
    if (mode === "ask" || mode === "always" || (backend === "claude" && mode === "auto")) onChange(mode);
  }}>
    <SelectTrigger aria-label="Permissions" size="sm" className={QUIET_TRIGGER}>
      <SelectValue>{value === "ask" ? "Ask" : value === "auto" ? "Auto" : "Always"}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="ask">Ask</SelectItem>
      {backend === "claude" && <SelectItem value="auto">Auto</SelectItem>}
      <SelectItem value="always">Always</SelectItem>
    </SelectContent>
  </Select>;
}
