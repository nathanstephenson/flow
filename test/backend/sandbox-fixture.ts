import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SandboxSupport } from "../../src/isolation/sandbox.ts";

/** A provider whose exec runs the command on this machine and logs every provider call. */
export function fakeProvider(t: TestContext, createScript = 'cp "$1" "$LOG/spec.json"; echo create >> "$LOG/calls"', removeScript = 'echo "remove $1" >> "$LOG/calls"') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-sandbox-worker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = join(root, "scope"), state = join(root, "state", "sessions", "s1", "backend"), log = join(root, "log");
  for (const dir of [scope, state, log]) mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nLOG=${JSON.stringify(log)}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const support: SandboxSupport = {
    supported: true, path: join(root, "provider.json"),
    provider: {
      version: 1, nodePath: process.execPath, claudePath: "/bin/false",
      probe: [script("probe", "true")],
      create: [script("create", createScript), "{spec}"],
      exec: [script("exec", 'echo "exec $1 $2" >> "$LOG/calls"; printf "%s\\n" "$@" > "$LOG/argv"; cd "$2" || exit 1; shift 3; exec "$@"'), "{name}", "{cwd}", "--"],
      remove: [script("remove", removeScript), "{name}"],
    },
  };
  return { support, scope, state, stateRoot: join(root, "state"),
    calls: () => readFileSync(join(log, "calls"), "utf8").trim().split("\n"),
    argv: () => readFileSync(join(log, "argv"), "utf8").trim().split("\n"),
    spec: () => JSON.parse(readFileSync(join(log, "spec.json"), "utf8")) as {
      schemaVersion: string; name: string; workspace: string; additionalWorkspaces: { path: string; readOnly: boolean }[]; env: object;
    } };
}

/** Writes a native Claude install: `<root>/versions/<version>` with an ELF header, and `<root>/bin/claude` linked to it. */
export function fakeHostClaude(root: string, version: string, machine = process.arch === "arm64" ? 183 : 62) {
  const versions = join(root, "versions"), link = join(root, "bin", "claude");
  mkdirSync(versions, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  const header = Buffer.alloc(64);
  header.write("\x7fELF", "latin1");
  header[4] = 2; header[5] = 1;
  header.writeUInt16LE(machine, 18);
  writeFileSync(join(versions, version), header, { mode: 0o755 });
  rmSync(link, { force: true });
  symlinkSync(join(versions, version), link);
  return { link, executable: join(realpathSync(versions), version), versions: realpathSync(versions) };
}
