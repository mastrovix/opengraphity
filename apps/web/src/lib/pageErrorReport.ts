/**
 * PAGE ERRORS REACH THE SERVER LOG (review of 23 Sep 2026).
 *
 * Every route has `errorElement: <RouteError />`, and a data router catches
 * a page's render error there — before the app's `ErrorBoundary`, the only
 * component that reported to `clientLogger`. A TypeError in a detail page
 * showed «Unexpected error» to the person and nothing to the Logs page or to
 * Autoanalisi. The errors outside React (an event handler that throws, a
 * promise nobody awaits) were not reported anywhere either.
 */
import { isRouteErrorResponse } from 'react-router-dom'
import { clientLogger } from './clientLogger'
import { errorMessage } from './showError'

const stackOf = (error: unknown): string | undefined => (error instanceof Error ? error.stack?.slice(0, 500) : undefined)

/** The error a route caught. A 404 is an address nobody has, not a broken page: not reported. */
export function reportRouteError(error: unknown, path: string): void {
  if (isRouteErrorResponse(error) && error.status === 404) return
  clientLogger.error(`Route error: ${errorMessage(error)}`, { path, stack: stackOf(error) })
}

/** The errors no component catches; returns the function that stops listening. */
export function listenForUncaughtErrors(target: Window = window): () => void {
  const onError = (e: ErrorEvent) => {
    clientLogger.error(`Uncaught error: ${errorMessage(e.error ?? e.message)}`, { path: target.location.pathname, stack: stackOf(e.error) })
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    clientLogger.error(`Unhandled rejection: ${errorMessage(e.reason)}`, { path: target.location.pathname, stack: stackOf(e.reason) })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
