export function validSecretName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

export type SecretMetadata = { name: string };
export type SecretWrite = { value: string };
