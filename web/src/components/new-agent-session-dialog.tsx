import { useEffect, useRef, useState } from "react";

import { useCommand } from "@/agent-sessions.tsx";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";

/**
 * Starting an Agent Session: a Scope and a backend, both prefilled.
 *
 * The backend is a real choice for the first time. The UI this replaces silently hardcoded the first
 * registered backend while the Session Host had been offering the whole list all along, so which
 * backend you got depended on the host's registration order and nothing you could see.
 *
 * **A model cannot be offered here.** `create` accepts a `modelId`, but `Capabilities` arrive on
 * `session_started` *per Agent Session* — so at this moment the list of models does not exist yet.
 * Guessing one would mean guessing which backend's ids are valid. The model picker in the pane header
 * is the first honest moment to choose.
 *
 * Two fields, so `useState` and no form library: there is no validation graph here, only a string and
 * a choice from a list the host gave us.
 */
export function NewAgentSessionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionId: string) => void;
}) {
  const { config } = useHost();
  const run = useCommand();
  const [scope, setScope] = useState(config.scope);
  const [backend, setBackend] = useState(config.backends[0] ?? "");
  const [creating, setCreating] = useState(false);
  const create = useRef<HTMLButtonElement | null>(null);

  // Reopening offers the host's defaults again rather than whatever was typed and abandoned.
  useEffect(() => {
    if (!open) return;
    setScope(config.scope);
    setBackend(config.backends[0] ?? "");
  }, [open, config.scope, config.backends]);

  const submit = async (): Promise<void> => {
    if (creating || scope.trim() === "" || backend === "") return;
    setCreating(true);
    // `create` resolves to the new Agent Session's id as a bare string (SessionHost.create), not to
    // an object wrapping it.
    const created = await run<string>({ type: "create", scope: scope.trim(), backend });
    setCreating(false);
    if (created === undefined) return;
    onOpenChange(false);
    onCreated(created);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        // `n` then Enter starts one, which keeps the one-gesture feel of the old shortcut while
        // making the Scope and the backend visible and changeable before anything is spent.
        initialFocus={create}
      >
        <DialogTitle>New Agent Session</DialogTitle>
        <DialogDescription>
          It is bound to this Scope for its whole life, and the backend cannot be changed afterwards.
        </DialogDescription>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)">Scope</span>
            <Input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder="/path/to/the/working/directory"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)">Backend</span>
            <Select
              value={backend}
              onValueChange={(value) => {
                if (typeof value === "string") setBackend(value);
              }}
            >
              <SelectTrigger className="h-7 w-full justify-between px-2 text-xs">
                <SelectValue>{() => backend}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {config.backends.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={create}
            variant="accent"
            size="sm"
            disabled={creating || scope.trim() === "" || backend === ""}
            onClick={() => void submit()}
          >
            {creating ? "starting…" : "Start"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
