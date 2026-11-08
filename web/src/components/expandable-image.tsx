import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/utils.ts";

/** A thumbnail that opens the image at its natural size, scaled down only to fit the window. */
export function ExpandableImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={alt ? `Open ${alt}` : "Open image"}
            className="cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        }
      >
        <img src={src} alt={alt} className={cn("block", className)} />
      </DialogTrigger>
      <DialogContent className="w-auto max-w-[calc(100vw-2rem)] gap-0 p-2 sm:max-w-[calc(100vw-2rem)]">
        <DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
        <img src={src} alt={alt} className="max-h-[calc(100dvh-3rem)] max-w-full rounded-md object-contain" />
      </DialogContent>
    </Dialog>
  );
}
