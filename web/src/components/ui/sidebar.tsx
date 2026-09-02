import { cva, type VariantProps } from "class-variance-authority";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

import { Separator } from "@/components/ui/separator.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * A HAND-WRITTEN SUBSET of shadcn/ui's `sidebar` component. This is *not* the file
 * `npx shadcn@latest add sidebar` produces, so do not `shadcn diff` it and expect silence.
 *
 * Why hand-written: ui.shadcn.com is unreachable from the environment this was built in (the npm
 * registry routes, nothing else does), so neither the CLI nor the registry JSON could be fetched.
 * Everything here is therefore written to be *replaceable*: the exported part names, the `data-slot`
 * and `data-sidebar` attributes, the `--sidebar-*` tokens (already stock in web/src/index.css) and
 * the composition shape all match upstream, so when ui.shadcn.com is reachable again the fetched
 * file can overwrite this one and `agent-session-sidebar.tsx` keeps compiling.
 *
 * DELIBERATELY OMITTED, because GoodHarness binds loopback and is a desktop tool — none of this
 * would ever run, and it is most of the upstream file:
 *
 * - the mobile off-canvas Sheet mode (`isMobile`, `openMobile`, `setOpenMobile`, `SIDEBAR_WIDTH_MOBILE`),
 *   and with it the `sheet` component this app therefore does not need;
 * - the collapsible icon mode — so `Sidebar` implements only upstream's `collapsible="none"` branch,
 *   and every `group-data-[collapsible=icon]:*` class is dropped rather than compiled dead;
 * - `SidebarRail`, `SidebarTrigger`, `SidebarInset`, `SidebarMenuSkeleton` (and `skeleton`),
 *   `SidebarMenuSub*`, `SidebarInput`, `SidebarMenuBadge`, the keyboard shortcut that toggles the
 *   rail, and the `sidebar_state` cookie;
 * - `asChild` on every part except `SidebarGroupLabel`, and `tooltip` on `SidebarMenuButton` (a
 *   tooltip only exists upstream to label a row collapsed to an icon). Both omissions are safe for a
 *   drop-in: upstream is a superset, so app code that compiles against this compiles against that.
 *
 * One structural deviation to know about: `SidebarProvider` keeps upstream's wrapper element but
 * drops its `min-h-svh` for `h-full min-h-0`, because the rail is a cell in an already-full-height
 * app-shell grid rather than the page's own flex root.
 */

const SIDEBAR_WIDTH = "16rem";

/**
 * A stand-in for `@radix-ui/react-slot`, which this app does not depend on and should not start to
 * for one call site. Only `SidebarGroupLabel asChild` needs it — that is upstream's own documented
 * shape for a collapsible group, and the Settled group is one.
 */
function Slot({ children, className, ...props }: ComponentProps<"div">) {
  if (!isValidElement<{ className?: string | undefined }>(children)) return null;
  return cloneElement(children, {
    ...props,
    ...children.props,
    className: cn(className, children.props.className),
  });
}

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;

  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      else setUncontrolled(next);
    },
    [onOpenChange],
  );
  const toggleSidebar = useCallback(() => setOpen(!open), [open, setOpen]);

  const value = useMemo<SidebarContextValue>(
    () => ({ state: open ? "expanded" : "collapsed", open, setOpen, toggleSidebar }),
    [open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": SIDEBAR_WIDTH, ...style } as CSSProperties}
        className={cn("group/sidebar-wrapper flex h-full min-h-0 w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/**
 * Upstream's `collapsible="none"` branch, and only that branch. `collapsible` is still in the
 * signature so the app states which mode it is asking for and a drop-in of the upstream file is a
 * no-op; anything else here would render an expanded rail anyway, which is why it is not an error.
 */
export function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "none",
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "none";
}) {
  // Asserts the provider, as upstream does before it reads any of the collapse state.
  useSidebar();
  return (
    <div
      data-slot="sidebar"
      data-side={side}
      data-variant={variant}
      data-collapsible={collapsible}
      className={cn("flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

export function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 " +
          "outline-hidden ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear " +
          "focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

const sidebarMenuButton = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm " +
    "outline-hidden ring-sidebar-ring transition-[width,height,padding] " +
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 " +
    "active:bg-sidebar-accent active:text-sidebar-accent-foreground " +
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 " +
    "group-has-data-[sidebar=menu-action]/menu-item:pr-8 " +
    "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground " +
    "data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground " +
    "[&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent " +
          "hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: { default: "h-8 text-sm", sm: "h-7 text-xs", lg: "h-12 text-sm" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function SidebarMenuButton({
  isActive = false,
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof sidebarMenuButton> & { isActive?: boolean }) {
  return (
    <button
      type={type}
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size ?? "default"}
      data-active={isActive}
      className={cn(sidebarMenuButton({ variant, size }), className)}
      {...props}
    />
  );
}

/**
 * A second control *inside* a row, which is the whole reason this rail is a Sidebar and not a
 * `Tabs` — `role="tab"` forbids interactive descendants.
 */
export function SidebarMenuAction({
  className,
  showOnHover = false,
  type = "button",
  ...props
}: ComponentProps<"button"> & { showOnHover?: boolean }) {
  return (
    <button
      type={type}
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 " +
          "text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform " +
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 " +
          "peer-hover/menu-button:text-sidebar-accent-foreground " +
          "peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=sm]/menu-button:top-1 " +
          "peer-data-[size=lg]/menu-button:top-2.5 [&>svg]:size-4 [&>svg]:shrink-0",
        showOnHover &&
          "opacity-0 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground " +
            "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 " +
            "data-[state=open]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarSeparator({ className, ...props }: ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  );
}
