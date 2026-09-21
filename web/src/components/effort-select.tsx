import type { EffortLevel } from "../../../src/protocol/events.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";

const UNSET_EFFORT = "__unset_effort__";

/**
 * Constrained Effort control for persisted configuration.
 *
 * An invalid saved value remains visible in the closed trigger and as a disabled explanatory row;
 * it is never selectable. Callers decide whether unset is meaningful and whether discovery is ready.
 */
export function ConfiguredEffortSelect({
  value,
  levels,
  ariaLabel,
  allowUnset = false,
  disabled = false,
  onChange,
}: {
  value: EffortLevel | "";
  levels: readonly EffortLevel[];
  ariaLabel: string;
  allowUnset?: boolean;
  disabled?: boolean;
  onChange: (value: EffortLevel | "") => void;
}) {
  const invalid = value !== "" && !levels.includes(value);
  return (
    <Select
      value={value || (allowUnset ? UNSET_EFFORT : null)}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChange(next === UNSET_EFFORT ? "" : next as EffortLevel);
      }}
    >
      <SelectTrigger className="w-full" size="sm" aria-label={ariaLabel} aria-invalid={invalid || undefined}>
        <SelectValue>{value || "Use backend default"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowUnset ? <SelectItem value={UNSET_EFFORT}>Use backend default</SelectItem> : null}
        {invalid ? <SelectItem value={value} disabled>{value} (saved — unsupported)</SelectItem> : null}
        {levels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
