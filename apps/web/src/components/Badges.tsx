// ── Shared ITSM badge components ──────────────────────────────────────────────

import type { CSSProperties } from 'react'
import { colors } from '@/lib/tokens'

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

export function EnvBadge({ environment }: { environment: string }) {
  return <span style={PLAIN}>{environment}</span>
}
