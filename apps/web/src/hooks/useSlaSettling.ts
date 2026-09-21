/**
 * LO SLA SI CHIUDE UN ATTIMO DOPO IL TICKET.
 *
 * La transizione che risolve o chiude un ticket torna subito; lo SLA lo chiude
 * il motore SLA quando riceve l'evento, qualche istante dopo. La pagina
 * rileggeva il ticket una volta sola, al ritorno della transizione, e restava
 * con il badge di prima («SLA paused») finché non la si ricaricava (giro del
 * 14 set 2026). Qui, finché il ticket è concluso e lo SLA non risulta ancora
 * chiuso, la query si rilegge a intervalli brevi, per un tempo limitato.
 */
import { useEffect } from 'react'
import type { SlaStatusInfo } from '@/components/SlaBadge'

export const SLA_SETTLE_INTERVAL_MS = 3_000
export const SLA_SETTLE_MAX_MS = 30_000

/** True se lo SLA è ancora aperto su un ticket già concluso. */
export function slaStillSettling(sla: SlaStatusInfo | null | undefined, concluded: boolean): boolean {
  return !!sla && concluded && !sla.resolveMet && !sla.breached
}

export function useSlaSettling(
  sla: SlaStatusInfo | null | undefined,
  concluded: boolean,
  polling: { startPolling: (ms: number) => void; stopPolling: () => void },
): void {
  const settling = slaStillSettling(sla, concluded)
  const { startPolling, stopPolling } = polling
  useEffect(() => {
    if (!settling) return
    startPolling(SLA_SETTLE_INTERVAL_MS)
    const stop = setTimeout(stopPolling, SLA_SETTLE_MAX_MS)
    return () => { clearTimeout(stop); stopPolling() }
  }, [settling, startPolling, stopPolling])
}
