import { useCallback } from "react";
import { X } from "lucide-react";

import { useHost } from "@/host.tsx";
import { SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";

/**
 * The Standing Authorisations: tools this machine runs without asking, and how to take one back.
 *
 * **The list exists because the grant is coarse.** `permissions.allow` holds tool *names*, not
 * rules — it cannot say `Bash(git:*)` or "this MCP server, read tools only" — so one Allow on
 * `mcp__gdrive__trash_file` authorises every future deletion, in every Agent Session, for good. That
 * is the trade ADR 0018 made, and this page is the half of it that makes the trade honest: a grant
 * nobody can see is a grant nobody can revoke.
 *
 * So there is no way to *add* one here, deliberately. A Standing Authorisation is granted by
 * answering a Permission Prompt with Always — in the moment, with the call and its arguments on
 * screen — and a text field here would let someone authorise a tool they have never seen run.
 * Revoking is the only direction this page goes.
 */
export function PermissionsSettings() {
  const { config } = useHost();
  const { save } = useSaveSettings();

  const allow = config.permissions?.allow ?? [];

  /**
   * Write the list that should remain.
   *
   * `allow` replaces rather than merges (src/protocol/settings.ts), so a removal sends the whole
   * list — which is the point: a merged list would make a revocation indistinguishable from an
   * omission, and the thing left un-revoked would be a tool the machine goes on running unasked.
   */
  const revoke = useCallback(
    (name: string): void => {
      void save(
        { permissions: { allow: allow.filter((granted) => granted !== name) } },
        `${name} will be asked about again.`,
      );
    },
    [allow, save],
  );

  return (
    <SettingsGroup
      title={`Always allowed · ${allow.length}`}
      description={
        allow.length === 0
          ? "Nothing yet. Answering a Permission Prompt with “Always allow on this machine” adds a tool here, and it is never asked about again until you take it back."
          : "These run in every Agent Session without asking. Revoking one means the next call is asked about again — it does not undo anything already done."
      }
    >
      {allow.length === 0 ? null : (
        <div className="flex flex-col">
          {allow.map((name) => (
            <div
              key={name}
              className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0"
            >
              {/* Monospace: a tool name is an identifier the backend chose, not prose. */}
              <span className="min-w-0 truncate font-mono text-xs">{name}</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${name}`} onClick={() => revoke(name)}>
                <X aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}
