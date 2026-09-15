// Known credential values are replaced in keys as well as values, including common
// escaped/URL-encoded spellings. Never persist transport configuration in a workflow.
export function redactCredentials<T>(value: T, credentials: readonly string[]): T {
  const patterns = credentials.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)]).sort((a, b) => b.length - a.length);
  const text = (value: string) => patterns.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
  const visit = (item: unknown): unknown => typeof item === 'string' ? text(item) : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [text(key), visit(value)])) : item;
  return visit(value) as T;
}
export const credentialKey = /(?:authorization|cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|bearer|auth[-_]?token)/i;
