/**
 * LEAVING A PAGE WITH CHANGES NOT SAVED ASKS FIRST (review of 23 Sep 2026).
 *
 * The workflow designer keeps its edits locally until «Save changes»: the
 * back arrow, a sidebar link or closing the tab threw them all away, without a
 * word — the app had no guard anywhere. This one asks on an in-app navigation
 * (the data router's blocker) and lets the browser ask when the tab is closed
 * or reloaded. A navigation the page itself already confirmed passes
 * `state: { leaveConfirmed: true }` and is not asked twice.
 */
import { useContext, useEffect } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'
import { useConfirm } from '@/hooks/useConfirm'

interface Props {
  /** There are changes that leaving would lose. */
  when:  boolean
  title: string
  body:  string
  /** The label of the button that leaves. */
  confirmLabel: string
}

export function UnsavedChangesGuard({ when, title, body, confirmLabel }: Props) {
  // The browser's own question on close or reload: its text is the browser's.
  useEffect(() => {
    if (!when) return
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [when])
  // The blocker exists only under a data router (the app); a plain router (a test) has none.
  const inDataRouter = useContext(UNSAFE_DataRouterContext) != null
  return inDataRouter ? <RouteBlocker when={when} title={title} body={body} confirmLabel={confirmLabel} /> : null
}

function RouteBlocker({ when, title, body, confirmLabel }: Props) {
  const confirm = useConfirm()
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    when
    && currentLocation.pathname !== nextLocation.pathname
    && (nextLocation.state as { leaveConfirmed?: boolean } | null)?.leaveConfirmed !== true)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    void confirm({ title, body, confirmLabel, danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()))
  }, [blocker, confirm, title, body, confirmLabel])
  return null
}
