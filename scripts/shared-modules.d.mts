/** The src/client modules the web bundle must be built from rather than reimplement. */
export const SHARED_MODULES: readonly string[];

/** Throws unless every shared module is in the built bundle's module graph. */
export function assertSharedModules(graph: ReadonlySet<string>): void;
