import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The usual shadcn class merger, and the one place to explain the colour convention every component
 * below follows.
 *
 * index.css is stock shadcn: the tokens are declared on `:root`/`.dark` and re-exported through
 * `@theme inline`, so every one of them has a real Tailwind utility — `bg-card`, `text-muted-foreground`,
 * `border-border`, `text-destructive`. Components write those and nothing else, so a component copied
 * out of the shadcn docs lands here unmodified.
 *
 * Where a colour has to be chosen at runtime — a status tone, a notice level — the class name would
 * be dynamic and Tailwind's scanner would never see it, so those go through `style={{ color:
 * "var(--color-…)" }}` instead. Still a token, never a literal. No component writes a hex or an oklch.
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
