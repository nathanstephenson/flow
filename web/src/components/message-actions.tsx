import { GitBranch, Undo2 } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import type { RewindRestore } from "../../../src/protocol/events.ts";
import { Button } from "@/components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

/**
 * What a user message's Rewind and Fork buttons can do. A context because `TranscriptEntryProps` is
 * fixed by contract (see transcript-entry.tsx). Undefined members hide their button.
 */
export type MessageActions = {
  rewind?: { files: boolean; blocked: string | undefined; run: (userMessageId: string, restore: RewindRestore) => void };
  fork?: { worktree: boolean; run: (userMessageId: string, worktree: boolean) => void };
  openSession?: (sessionId: string) => void;
};

const MessageActionsContext = createContext<MessageActions>({});

export const MessageActionsProvider = MessageActionsContext.Provider;

export function useOpenSession(): ((sessionId: string) => void) | undefined {
  return useContext(MessageActionsContext).openSession;
}

export function MessageActionButtons({ userMessageId }: { userMessageId: string }) {
  const { rewind, fork } = useContext(MessageActionsContext);
  return (
    <>
      {rewind ? (
        <ActionMenu icon={<Undo2 aria-hidden />} label={rewind.blocked ?? "Rewind to before this message"} disabled={rewind.blocked !== undefined}>
          <DropdownMenuItem onClick={() => rewind.run(userMessageId, "conversation")}>Conversation</DropdownMenuItem>
          {rewind.files ? (
            <>
              <DropdownMenuItem onClick={() => rewind.run(userMessageId, "files")}>Code</DropdownMenuItem>
              <DropdownMenuItem onClick={() => rewind.run(userMessageId, "both")}>Both</DropdownMenuItem>
            </>
          ) : null}
        </ActionMenu>
      ) : null}
      {fork ? (
        <ActionMenu icon={<GitBranch aria-hidden />} label="Fork from before this message">
          <DropdownMenuItem onClick={() => fork.run(userMessageId, false)}>Same Scope</DropdownMenuItem>
          {fork.worktree ? <DropdownMenuItem onClick={() => fork.run(userMessageId, true)}>New Worktree</DropdownMenuItem> : null}
        </ActionMenu>
      ) : null}
    </>
  );
}

function ActionMenu({ icon, label, disabled = false, children }: { icon: ReactNode; label: string; disabled?: boolean; children: ReactNode }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={disabled}
              render={<Button variant="ghost" size="icon-xs" aria-label={label}>{icon}</Button>}
            />
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="min-w-40">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
