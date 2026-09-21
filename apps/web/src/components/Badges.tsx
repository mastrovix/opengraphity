// ── Shared ITSM badge components ──────────────────────────────────────────────

import type { CSSProperties } from 'react'
import { colors } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'

const PLAIN: CSSProperties = {
  color: colors.slate,
}

export function TypeBadge({ type }: { type: string }) {
  return <span style={PLAIN}>{type}</span>
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <span style={PLAIN}>{priority}</span>
}

export function StepBadge({ step }: { step: string }) {
  return <span style={PLAIN}>{step.replace(/_/g, ' ')}</span>
}

/**
 * L'ambiente di un CI, con l'etichetta del vocabolario `environment`. Senza
 * ambiente mostra «—»: chi chiamava con `String(v)` scriveva a schermo la
 * parola «null» (CMDB, giro del 14 set 2026).
 */
export function EnvBadge({ environment }: { environment: string | null | undefined }) {
  const { labelOf } = useDomainVocabularies()
  if (!environment) return <span style={{ color: colors.slateLight }}>—</span>
  return <span style={PLAIN}>{labelOf('environment', environment) ?? environment}</span>
}
