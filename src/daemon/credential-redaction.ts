// Known credential values are replaced in keys as well as values, including common
// escaped/URL-encoded spellings. Never persist transport configuration in a workflow.
export function redactCredentials<T>(value: T, credentials: readonly string[]): T {
  const { redact } = credentialTextRedactor(credentials);
  const visit = (item: unknown): unknown => typeof item === 'string' ? redact(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [redact(key), visit(value)])) : item;
  return visit(value) as T;
}

function credentialTextRedactor(credentials: readonly string[]): { redact: (value: string) => string; inspect: (value: string, work: number) => string } {
  const patterns = [...new Set(credentials.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  // A replacement must not itself contain a credential. This matters for credentials such as
  // "REDACTED", which would otherwise survive inside the conventional marker.
  const replacement = ["[REDACTED]", "[FILTERED]", "<hidden>", ""].find(candidate => patterns.every(pattern => !candidate.includes(pattern)))!;
  const lookahead = patterns.reduce((maximum, pattern) => Math.max(maximum, pattern.length - 1), 0);
  return {
    redact: value => patterns.reduce((result, secret) => result.split(secret).join(replacement), value),
    inspect: (value, work) => {
      if (value.length <= work) return value;
      const inspected = value.slice(0, work + lookahead);
      // Include a credential which straddles the work boundary, but nothing after it. Redacting
      // the entire lookahead is unsafe: several long matches can shrink enough that output reaches
      // a credential fragment at the end of that lookahead.
      let end = work;
      for (;;) {
        let extended = end;
        for (const pattern of patterns) {
          const start = inspected.lastIndexOf(pattern, end - 1);
          if (start >= 0 && start < end && start + pattern.length > extended) extended = start + pattern.length;
        }
        if (extended === end) break;
        end = Math.min(extended, inspected.length);
      }
      return inspected.slice(0, end);
    },
  };
}

export const credentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|bearer|auth[-_]?token)/i;
const namingCredentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer|token)/i;

export function credentialJsonSerializer(credentials: readonly string[]): (value: unknown, limit: number) => string {
  const { redact, inspect } = credentialTextRedactor(credentials);
  return (value: unknown, limit: number): string => {
    let remaining = limit;
    // Output limits do not bound omitted fields or the input scanned before encoding.
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
        const inspected = inspect(item, work);
        consume(Math.min(item.length, work));
        return emit(JSON.stringify(redact(inspected)));
      }
      if (item === null || typeof item !== "object") {
        consume(1);
        return emit(redact(JSON.stringify(item) ?? "null"));
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
        if (!remaining || work <= 0) break;
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        const inspected = inspect(key, work);
        consume(Math.min(key.length, work));
        if (namingCredentialKey.test(inspected)) continue;
        result += emit(index++ ? "," : "") + emit(JSON.stringify(redact(inspected)) + ":") + visit((item as Record<string, unknown>)[key]);
      }
      return result + emit("}");
    };
    return visit(value);
  };
}
