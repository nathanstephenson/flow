import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real repositories for the tests that need one.
 *
 * Shared rather than repeated in each file, because three of them build the same thing and the
 * identity fields below are easy to get subtly wrong: without them `git commit` fails on a machine
 * with no configured user, which is most CI containers.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

export function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  });
}

/** A repository with one commit on `main`, plus any extra branches asked for. */
export function repository(parent: string, name: string, branches: string[] = []): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "--initial-branch=main", "--quiet");
  writeFileSync(join(path, "README.md"), "# test\n");
  git(path, "add", ".");
  git(path, "commit", "--quiet", "-m", "first");
  for (const branch of branches) git(path, "branch", branch);
  return path;
}

/** A repository with no commits, whose HEAD points at a branch that does not exist yet. */
export function unbornRepository(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "--initial-branch=main", "--quiet");
  return path;
}

export function githubRemote(parent: string, repo: string): string {
  const bare = join(parent, "remote.git");
  mkdirSync(bare);
  git(bare, "init", "--bare", "--quiet");
  const ssh = join(parent, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$last" in git-upload-pack*) exec git-upload-pack '${bare}';; *) exec git-receive-pack '${bare}';; esac\n`);
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  process.env.GIT_SSH_VARIANT = "ssh";
  git(repo, "remote", "add", "origin", "git@github.com:test/repo.git");
  return bare;
}
