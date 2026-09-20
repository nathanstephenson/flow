// Known credential values are replaced in keys as well as values, including common
// escaped/URL-encoded spellings. Never persist transport configuration in a workflow.
export function redactCredentials<T>(value: T, credentials: readonly string[]): T {
  const { redact } = credentialTextRedactor(credentials);
  const visit = (item: unknown): unknown => typeof item === 'string' ? redact(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [redact(key), visit(value)])) : item;
  return visit(value) as T;
}

function credentialTextRedactor(credentials: readonly string[]): { redact: (value: string) => string; lookahead: number } {
  const patterns = [...new Set(credentials.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  // A replacement must not itself contain a credential. This matters for credentials such as
  // "REDACTED", which would otherwise survive inside the conventional marker.
  const replacement = ["[REDACTED]", "[FILTERED]", "<hidden>", ""].find(candidate => patterns.every(pattern => !candidate.includes(pattern)))!;
  return {
    redact: value => patterns.reduce((result, secret) => result.split(secret).join(replacement), value),
    lookahead: Math.max(0, ...patterns.map(pattern => pattern.length - 1)),
  };
}

export const credentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|bearer|auth[-_]?token)/i;
const namingCredentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer|token)/i;

/** Compile credential spellings once for serialising several sections of one naming context. */
export function credentialJsonSerializer(credentials: readonly string[]): (value: unknown, limit: number) => string {
  const { redact, lookahead } = credentialTextRedactor(credentials);
  return (value: unknown, limit: number): string => {
  let remaining = limit;
  // Output budget alone is insufficient: omitted fields emit nothing, and a single string can be
  // arbitrarily large before redaction or JSON encoding. Charge all inspected input separately.
  let work = Math.max(4_096, limit * 4);
  const consume = (size: number): boolean => {
    if (work <= 0) return false;
    work -= Math.max(1, size);
    return true;
  };
  const emit = (text: string): string => {
    if (text.length <= remaining) { remaining -= text.length; return text; }
    const clipped = text.slice(0, Math.max(0, remaining - 1)) + (remaining ? "…" : "");
    remaining = 0;
    return clipped;
  };
  const visit = (item: unknown): string => {
    if (!remaining || work <= 0) return "";
    if (typeof item === "string") {
      // Inspect beyond the work cutoff far enough to recognize a credential that starts before it.
      // Only sanitized text is subsequently handed to the output truncator.
      const inspected = item.slice(0, work + lookahead);
      consume(Math.min(item.length, work));
      return emit(JSON.stringify(redact(inspected)));
    }
    if (item === null || typeof item !== "object") {
      consume(1);
      return emit(JSON.stringify(item) ?? "null");
    }
    if (Array.isArray(item) || Symbol.iterator in item) {
      let result = emit("[");
      let index = 0;
      for (const nested of item as Iterable<unknown>) {
        if (!remaining || !consume(1)) break;
        result += emit(index++ ? "," : "") + visit(nested);
      }
      return result + emit("]");
    }
    let result = emit("{");
    let index = 0;
    for (const key in item) {
      if (!remaining || !consume(key.length + 1)) break;
      if (!Object.prototype.hasOwnProperty.call(item, key) || namingCredentialKey.test(key)) continue;
      result += emit(index++ ? "," : "") + emit(JSON.stringify(redact(key)) + ":") + visit((item as Record<string, unknown>)[key]);
    }
    return result + emit("}");
  };
  return visit(value);
  };
}

/** Serialise without first cloning an arbitrarily large execution history. */
export function boundedCredentialJson(value: unknown, credentials: readonly string[], limit: number): string {
  return credentialJsonSerializer(credentials)(value, limit);
}
