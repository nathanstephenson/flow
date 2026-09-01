import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The usual shadcn class merger, and the one place to explain the colour convention every component
 * below follows.
 *
 * The palette in index.css lives in `@layer base` on `:root`/`.light` rather than inside `@theme`,
 * because a themeable variable cannot also be a Tailwind theme key without being declared twice.
 * The consequence is that there is no `bg-surface` utility to write, so colours are spelled
 * `bg-(--color-surface)` — Tailwind v4's CSS-variable shorthand. That is not a workaround but the
 * stricter option: it is impossible to write a colour literal in this form, so a hex code in a
 * component is visible on sight.
 *
 * Where a colour has to be chosen at runtime — a status tone, a notice level — the class name would
 * be dynamic and Tailwind's scanner would never see it, so those go through `style={{ color:
 * "var(--color-…)" }}` instead. Still a token, never a literal.
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
