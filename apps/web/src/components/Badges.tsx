// ── Shared ITSM badge components ──────────────────────────────────────────────
// Single source of truth for TypeBadge, PriorityBadge, StepBadge, EnvBadge.

import type { CSSProperties } from 'react'

const BASE: CSSProperties = {
  display:       'inline-flex',
  alignItems:    'center',
  padding:       '2px 8px',
  borderRadius:  4,
  fontSize:      11,
  fontWeight:    600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace:    'nowrap',
}

// ── TypeBadge ─────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  standard:  { bg: '#dcfce7', color: '#16a34a' },
  normal:    { bg: '#eff6ff', color: '#4f46e5' },
  emergency: { bg: '#fef2f2', color: '#dc2626' },
}

export function TypeBadge({ type }: { type: string }) {
  const c = TYPE_COLORS[type] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ ...BASE, backgroundColor: c.bg, color: c.color }}>{type}</span>
}

// ── PriorityBadge ─────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: '#dc2626' },
  high:     { bg: '#fff7ed', color: '#ea580c' },
  medium:   { bg: '#fefce8', color: '#ca8a04' },
  low:      { bg: '#f0fdf4', color: '#16a34a' },
}

export function PriorityBadge({ priority }: { priority: string }) {
  const c = PRIORITY_COLORS[priority] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ ...BASE, backgroundColor: c.bg, color: c.color }}>{priority}</span>
}

// ── StepBadge ─────────────────────────────────────────────────────────────────

const STEP_COLORS: Record<string, { bg: string; color: string }> = {
  draft:              { bg: '#f1f5f9', color: '#64748b' },
  new:                { bg: '#f1f5f9', color: '#64748b' },
  assessment:         { bg: '#eff6ff', color: '#4f46e5' },
  assigned:           { bg: '#eff6ff', color: '#4f46e5' },
  planning:           { bg: '#eff6ff', color: '#4f46e5' },
  post_review:        { bg: '#eff6ff', color: '#4f46e5' },
  cab_approval:       { bg: '#faf5ff', color: '#9333ea' },
  emergency_approval: { bg: '#fef2f2', color: '#dc2626' },
  scheduled:          { bg: '#fff7ed', color: '#ea580c' },
  pending:            { bg: '#fff7ed', color: '#ea580c' },
  validation:         { bg: '#fefce8', color: '#ca8a04' },
  deployment:         { bg: '#eff6ff', color: '#4f46e5' },
  in_progress:        { bg: '#eff6ff', color: '#4f46e5' },
  completed:          { bg: '#f0fdf4', color: '#16a34a' },
  resolved:           { bg: '#f0fdf4', color: '#16a34a' },
  closed:             { bg: '#f0fdf4', color: '#16a34a' },
  approved:           { bg: '#f0fdf4', color: '#16a34a' },
  failed:             { bg: '#fef2f2', color: '#dc2626' },
  rejected:           { bg: '#fef2f2', color: '#dc2626' },
  escalated:          { bg: '#fef2f2', color: '#dc2626' },
}

export function StepBadge({ step }: { step: string }) {
  const c = STEP_COLORS[step] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ ...BASE, backgroundColor: c.bg, color: c.color }}>{step.replace(/_/g, ' ')}</span>
}

// ── EnvBadge ──────────────────────────────────────────────────────────────────

const ENV_COLORS: Record<string, { bg: string; color: string }> = {
  production:  { bg: '#fef2f2', color: '#dc2626' },
  staging:     { bg: '#fff7ed', color: '#ea580c' },
  development: { bg: '#f0fdf4', color: '#16a34a' },
  dr:          { bg: '#eff6ff', color: '#4f46e5' },
}

export function EnvBadge({ environment }: { environment: string }) {
  const c = ENV_COLORS[environment] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ ...BASE, backgroundColor: c.bg, color: c.color }}>{environment}</span>
}
