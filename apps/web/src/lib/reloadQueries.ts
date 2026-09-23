/**
 * AFTER A CHANGE THAT WORKED, THE PAGE RELOADS WHAT IT SHOWS (tour of 23 Sep 2026).
 *
 * Apollo calls a mutation's `onCompleted` and drops what it returns. An
 * `async` onCompleted that awaited a refetch left a failed reload as an
 * unhandled rejection, and whatever was written after the await — the
 * success toast, closing the dialog — never happened, although the change
 * itself was done. The guard `src/__tests__/apolloCallbacks.test.ts` keeps
 * `onCompleted` from being async again.
 *
 * So the reload runs on its own and nothing waits for it. If it fails the
 * person is told: a GraphQL or network error by the error link, as every one
 * is; anything else by `showError`, which skips what the link already said.
 */
import { showError } from '@/lib/showError'

export function reloadQueries(...refetches: Array<() => Promise<unknown>>): void {
  for (const refetch of refetches) void refetch().catch((e: unknown) => { showError(e) })
}
