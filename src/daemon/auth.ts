import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Session Host's bearer token (ADR 0004).
 *
 * Tools are pre-approved, so an authenticated client can run arbitrary commands as the user. The
 * token is therefore treated as a credential: 0600 on disk, and compared in constant time.
 */
export function readOrCreateToken(stateRoot: string): string {
  const path = join(stateRoot, "token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // No token yet.
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
