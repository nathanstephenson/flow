/** Regenerate the embedded web asset module from web/dist. Needs a Vite build to have run first. */
export function buildAssets(sharedModules: readonly string[]): string;

/** sha256 over every source the embedded module is built from; used by the staleness test. */
export function sourceHash(): string;
