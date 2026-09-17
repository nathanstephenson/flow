/** A completion observed during the initial tail read still owes one forward catch-up. */
export function pollAfterInitialLoad(completed: boolean, catchUpRequested: boolean): boolean {
  return !completed || catchUpRequested;
}
