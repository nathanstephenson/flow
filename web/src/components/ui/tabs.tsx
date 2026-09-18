import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

function TabsList({
  className,
  activateOnFocus = true,
  ...props
}: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      activateOnFocus={activateOnFocus}
      className={cn(
        "inline-flex max-w-full items-center rounded-2xl bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium whitespace-nowrap outline-none select-none transition-[color,box-shadow] hover:bg-background/60 hover:text-foreground focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring/30 data-active:bg-background data-active:text-foreground data-active:shadow-sm data-active:ring-1 data-active:ring-border/60 data-active:hover:bg-background disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [[hidden]]:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
