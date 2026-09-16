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
import { useWorkflowResource } from "./workflow-api.ts";
import { toast } from "./ui/toaster.tsx";

type HeaderRow = { name: string; kind: "value" | "secret"; value: string };

export default function McpSettings() {
  const { config } = useHost();
  const { save, saving } = useSaveSettings();
  const secrets = useWorkflowResource<{ names: string[] }>("/api/secrets");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const patchHeader = (index: number, patch: Partial<HeaderRow>) =>
    setHeaders((rows) =>
      rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
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
    setHeaders([]);
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
                setHeaders(
                  connection.transport === "http"
                    ? Object.entries(connection.headers).map(
                        ([name, source]) =>
                          "secret" in source
                            ? { name, kind: "secret" as const, value: source.secret }
                            : { name, kind: "value" as const, value: source.value },
                      )
                    : [],
                );
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
          const rows = headers.filter((row) => row.name.trim() && row.value);
          if (new Set(rows.map((row) => row.name.trim())).size !== rows.length) {
            toast.error("Header names must be unique");
            return;
          }
          const headerMap = Object.fromEntries(
            rows.map((row) => [
              row.name.trim(),
              row.kind === "secret"
                ? { secret: row.value }
                : { value: row.value },
            ]),
          );
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
                ? { ...common, transport, url: target, oauth, headers: headerMap }
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
          <>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={oauth} onCheckedChange={setOauth} />
              Use OAuth
            </label>
            <div className="grid gap-2">
              <span className="text-sm">Headers</span>
              <p className="text-muted-foreground text-xs">
                A secret keeps the value on this machine. A literal value is
                stored in the Settings file and is readable by anything signed
                in to Flow.
                {oauth &&
                  headers.some(
                    (row) => row.name.trim().toLowerCase() === "authorization",
                  ) &&
                  " OAuth is on, so its token replaces the Authorization header."}
              </p>
              {headers.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while being typed
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Header name"
                    placeholder="Header name"
                    className="min-w-32 flex-1"
                    value={row.name}
                    onChange={(event) =>
                      patchHeader(index, { name: event.target.value })
                    }
                  />
                  <Select
                    value={row.kind}
                    onValueChange={(value) => {
                      if (value === "value" || value === "secret")
                        patchHeader(index, { kind: value, value: "" });
                    }}
                  >
                    <SelectTrigger aria-label="Header source" className="w-36">
                      <SelectValue>
                        {() => (row.kind === "secret" ? "Secret" : "Value")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="secret">Secret</SelectItem>
                      <SelectItem value="value">Value</SelectItem>
                    </SelectContent>
                  </Select>
                  {row.kind === "secret" ? (
                    <Select
                      value={row.value}
                      onValueChange={(value) =>
                        patchHeader(index, { value: value ?? "" })
                      }
                    >
                      <SelectTrigger
                        aria-label="Header secret"
                        className="min-w-32 flex-1"
                      >
                        <SelectValue>
                          {() => row.value || "Choose a secret"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.data?.names.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label="Header value"
                      placeholder="Value"
                      className="min-w-32 flex-1"
                      value={row.value}
                      onChange={(event) =>
                        patchHeader(index, { value: event.target.value })
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    type="button"
                    onClick={() =>
                      setHeaders((rows) =>
                        rows.filter((_, at) => at !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                type="button"
                className="justify-self-start"
                onClick={() =>
                  setHeaders((rows) => [
                    ...rows,
                    { name: "", kind: "secret", value: "" },
                  ])
                }
              >
                Add header
              </Button>
            </div>
          </>
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
