import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  type LucideIcon,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";

import { toolKind, type ToolKind } from "@/presentation/tool-display.ts";
import { cn } from "@/lib/utils.ts";

const ICONS: Record<ToolKind, LucideIcon> = {
  shell: SquareTerminal,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  search: Search,
  list: FolderSearch,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
  mcp: Plug,
  other: Wrench,
};

export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[toolKind(name)];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}
