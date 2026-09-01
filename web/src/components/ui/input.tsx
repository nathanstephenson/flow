import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Input, which is a native input plus Field integration. Mono by default: everything this
 * app asks anyone to type is verbatim — a Scope path, a search term, a message — and none of it is
 * prose about the app.
 */
export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
  return (
    <BaseInput
      className={cn(
        "h-7 w-full rounded-sm border border-(--color-line) bg-(--color-inset) px-2 font-mono text-xs " +
          "text-(--color-fg-strong) placeholder:text-(--color-fg-faint) focus:border-(--color-line-strong)",
        className,
      )}
      {...props}
    />
  );
}
