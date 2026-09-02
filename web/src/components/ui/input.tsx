import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/** Base UI's Input — a native input plus Field integration — wearing shadcn's stock input classes. */
export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
  return (
    <BaseInput
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base " +
          "shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary " +
          "selection:text-primary-foreground placeholder:text-muted-foreground " +
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
          "disabled:pointer-events-none disabled:opacity-50 md:text-sm dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}
