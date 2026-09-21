/**
 * L'inizio pianificato della validazione o del deploy di un CI, dal suo piano.
 *
 * Giro del 14 set 2026: validazione e deploy si chiudevano il 14 settembre
 * con le finestre pianificate il 15 e il 16, senza una parola. Non si blocca
 * (un anticipo può essere legittimo) ma si chiede conferma, dicendo quando
 * la finestra comincia.
 */
import type { DeployStep } from '@/types/change'

export function plannedWindowStart(steps: readonly DeployStep[] | null | undefined, kind: 'validation' | 'deployment'): string | null {
  const starts = (steps ?? [])
    .map((s) => (kind === 'validation' ? s.validationWindow?.start : s.releaseWindow?.start))
    .filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  return starts[0] ?? null
}

/** True se oggi è prima dell'inizio pianificato. */
export function beforePlannedWindow(start: string | null, now = Date.now()): boolean {
  return !!start && now < Date.parse(start)
}
