// Known credential values are replaced in keys as well as values, including common
// escaped/URL-encoded spellings. Never persist transport configuration in a workflow.
export function redactCredentials<T>(value: T, credentials: readonly string[]): T {
  const text = credentialTextRedactor(credentials);
  const visit = (item: unknown): unknown => typeof item === 'string' ? text(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [text(key), visit(value)])) : item;
  return visit(value) as T;
}

function credentialTextRedactor(credentials: readonly string[]): (value: string) => string {
  const patterns = credentials.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)]).sort((a, b) => b.length - a.length);
  return value => patterns.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}

export const credentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|bearer|auth[-_]?token)/i;
const namingCredentialKey = /(?:authorization|cookie|password|passphrase|credential|secret|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer|token)/i;

/** Serialise without first cloning an arbitrarily large execution history. */
export function boundedCredentialJson(value: unknown, credentials: readonly string[], limit: number): string {
  const redact = credentialTextRedactor(credentials);
  let remaining = limit;
  const emit = (text: string): string => {
    if (text.length <= remaining) { remaining -= text.length; return text; }
    const clipped = text.slice(0, Math.max(0, remaining - 1)) + (remaining ? "…" : "");
    remaining = 0;
    return clipped;
  };
  const visit = (item: unknown): string => {
    if (!remaining) return "";
    if (typeof item === "string") return emit(JSON.stringify(redact(item)));
    if (item === null || typeof item !== "object") return emit(JSON.stringify(item) ?? "null");
    if (Array.isArray(item) || Symbol.iterator in item) {
      let result = emit("[");
      let index = 0;
      for (const nested of item as Iterable<unknown>) {
        if (!remaining) break;
        result += emit(index++ ? "," : "") + visit(nested);
      }
      return result + emit("]");
    }
    let result = emit("{");
    let index = 0;
    for (const key in item) {
      if (!remaining) break;
      if (!Object.prototype.hasOwnProperty.call(item, key) || namingCredentialKey.test(key)) continue;
      result += emit(index++ ? "," : "") + emit(JSON.stringify(redact(key)) + ":") + visit((item as Record<string, unknown>)[key]);
    }
    return result + emit("}");
  };
  return visit(value);
}
