import { useHost } from "@/host.tsx";
import { toolLabel } from "@/presentation/tool-name.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

export function ToolName({ name }: { name: string }) {
  const label = toolLabel(name, useHost().config.mcp);
  if (!label) return name;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        {label.connection} › {label.tool}
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
