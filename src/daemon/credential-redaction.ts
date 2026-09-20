// Known credential values are replaced in keys as well as values, including common
// escaped/URL-encoded spellings. Never persist transport configuration in a workflow.
export function redactCredentials<T>(value: T, credentials: readonly string[]): T {
  const text = credentialTextRedactor(credentials);
  const visit = (item: unknown): unknown => typeof item === 'string' ? text(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [text(key), visit(value)])) : item;
  return visit(value) as T;
}

/** Omit credential-shaped naming fields and redact known values before truncation. */
export function redactCredentialContext<T>(value: T, credentials: readonly string[]): T {
  const text = credentialTextRedactor(credentials);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !namingCredentialKey.test(key))
      .map(([key, nested]) => [text(key), visit(nested)]));
  };
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
    const array = Array.isArray(item);
    let result = emit(array ? "[" : "{");
    const entries = array ? item.map((nested, index) => [String(index), nested] as const) : Object.entries(item).filter(([key]) => !namingCredentialKey.test(key));
    for (let index = 0; index < entries.length && remaining; index += 1) {
      const [key, nested] = entries[index]!;
      result += emit(index ? "," : "");
      if (!array) result += emit(JSON.stringify(redact(key)) + ":");
      result += visit(nested);
    }
    return result + emit(array ? "]" : "}");
  };
  return visit(value);
}
