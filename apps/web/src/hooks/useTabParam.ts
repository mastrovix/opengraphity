import { useSearchParams } from 'react-router-dom'

/**
 * THE OPEN TAB LIVES IN THE ADDRESS (26 Sep 2026, review of the pages).
 *
 * `?tab=diagnosis`: a link can open a ticket on the right tab, a refresh keeps
 * it, and the tab survives a round trip to another page. The first tab is not
 * written (the plain address opens it), and a change of tab replaces the entry
 * instead of adding one: Back leaves the page, it does not walk the tabs. A
 * value the page does not know opens the first tab.
 */
export function useTabParam<K extends string>(keys: readonly K[], fallback: K): [K, (next: K) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = raw !== null && (keys as readonly string[]).includes(raw) ? raw as K : fallback
  const setTab = (next: K) => {
    const p = new URLSearchParams(params)
    if (next === fallback) p.delete('tab')
    else p.set('tab', next)
    setParams(p, { replace: true })
  }
  return [tab, setTab]
}
