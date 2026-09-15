import { useState } from "react";
import type { McpConnection } from "../../../src/protocol/mcp.ts";
import { useHost } from "@/host.tsx";
import { SettingsGroup, useSaveSettings } from "./settings-parts.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { signInMcp } from "./mcp-actions.ts";
import { toast } from "./ui/toaster.tsx";

export default function McpSettings() {
  const { config } = useHost();
  const { save, saving } = useSaveSettings();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("[]");
  const [oauth, setOauth] = useState(false);
  const [enabledByDefault, setEnabled] = useState(true);
  const reset = () => {
    setEditing(undefined);
    setName("");
    setTarget("");
    setArgs("[]");
    setOauth(false);
    setEnabled(true);
  };
  const connections = config.mcp ?? [];
  return (
    <SettingsGroup
      title="MCP connections"
      description="Tools only. Changes apply when the next Backend Session opens. Local commands run on this machine with your access. OAuth uses one identity per connection on this machine."
    >
      <ul className="divide-y">
        {connections.map((connection) => (
          <li
            key={connection.id}
            className="flex flex-wrap items-center gap-2 py-2"
          >
            <span className="min-w-0 flex-1 text-sm">{connection.name}</span>
            {connection.transport === "http" && connection.oauth && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void signInMcp(connection.id)}
              >
                Sign in
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(connection.id);
                setName(connection.name);
                setTransport(connection.transport);
                setTarget(
                  connection.transport === "http"
                    ? connection.url
                    : connection.command,
                );
                setArgs(
                  connection.transport === "stdio"
                    ? JSON.stringify(connection.args)
                    : "[]",
                );
                setOauth(connection.transport === "http" && connection.oauth);
                setEnabled(connection.enabledByDefault);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={saving}
              onClick={() =>
                void save(
                  {
                    mcp: connections.filter(
                      (entry) => entry.id !== connection.id,
                    ),
                  },
                  "Connection deleted",
                )
              }
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          let connection: McpConnection;
          const common = {
            id: editing ?? crypto.randomUUID(),
            name,
            enabledByDefault,
          };
          try {
            const parsed: unknown = transport === "stdio" ? JSON.parse(args) : [];
            if (
              !Array.isArray(parsed) ||
              parsed.some((value) => typeof value !== "string")
            )
              throw new Error();
            connection =
              transport === "http"
                ? { ...common, transport, url: target, oauth }
                : {
                    ...common,
                    transport,
                    command: target,
                    args: parsed as string[],
                  };
          } catch {
            toast.error("Arguments must be a JSON array of strings");
            return;
          }
          void save(
            {
              mcp: [
                ...connections.filter((entry) => entry.id !== editing),
                connection,
              ],
            },
            "Connection saved",
          ).then((saved) => {
            if (saved) reset();
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          Name
          <Input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Select
          value={transport}
          onValueChange={(value) => {
            if (value === "stdio" || value === "http") setTransport(value);
          }}
        >
          <SelectTrigger aria-label="Transport">
            <SelectValue>{() => transport === "stdio" ? "Local command" : "Remote HTTP"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">Local command</SelectItem>
            <SelectItem value="http">Remote HTTP</SelectItem>
          </SelectContent>
        </Select>
        <label className="grid gap-1 text-sm">
          {transport === "http" ? "URL" : "Command"}
          <Input
            required
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        {transport === "stdio" ? (
          <label className="grid gap-1 text-sm">
            Arguments (JSON array)
            <Input
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={oauth} onCheckedChange={setOauth} />
            Use OAuth
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={enabledByDefault} onCheckedChange={setEnabled} />
          Selected by default for new Agent Sessions
        </label>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving} type="submit">
            {editing ? "Save" : "Add connection"}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={reset}>
            Discard
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}
