import { SlidersHorizontal } from "lucide-react";
import { useRef, type ReactNode } from "react";

import type { ComposerActions } from "@/composer-actions.ts";
import type { Chrome } from "@/store/contract.ts";
import { ContextUsageMeter } from "@/components/context-usage-meter.tsx";
import { TurnStrip, type TurnStripControls } from "@/components/turn-strip.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet.tsx";

export function TurnOptionsButton({ chrome, actions, controls, onReturnFocus }: {
  chrome: Chrome;
  actions: ComposerActions;
  controls: TurnStripControls | undefined;
  onReturnFocus: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Sheet>
      <SheetTrigger render={<Button ref={trigger} type="button" variant="ghost" size="icon" aria-label="Turn options" />}>
        <SlidersHorizontal aria-hidden />
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
        finalFocus={() => {
          if (trigger.current?.isConnected) return trigger.current;
          onReturnFocus();
          return false;
        }}>
        <SheetHeader className="pr-16">
          <SheetTitle>Turn options</SheetTitle>
          <SheetDescription>Controls and information for the next turn.</SheetDescription>
        </SheetHeader>
        <TurnStrip chrome={chrome} actions={actions} {...controls} layout="drawer" />
      </SheetContent>
    </Sheet>
  );
}

export function TurnSummary({ chrome, children }: { chrome: Chrome; children: ReactNode }) {
  const model = chrome.model?.label ?? chrome.model?.id ?? "model";
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-border/40 px-3 py-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate" title={model}>{model}</span>
      {children}
      <div className="w-full min-w-0 max-w-32 justify-self-end">
        <ContextUsageMeter usage={chrome.contextUsage} compacting={chrome.compacting} />
      </div>
    </div>
  );
}
