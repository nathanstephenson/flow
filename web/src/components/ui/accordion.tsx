import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;
const AccordionItem = AccordionPrimitive.Item;

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, ...props }: AccordionPrimitive.Panel.Props) {
  return <AccordionPrimitive.Panel className={cn("pb-3", className)} {...props} />;
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
