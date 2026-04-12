import type { CSSProperties } from 'react'
import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { EnvBadge } from '@/components/Badges'
import { CountBadge } from '@/components/ui/CountBadge'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import {
  GitBranch,
  AlertCircle,
  GitCommit,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle,
} from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'

const SEV_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  high:     { bg: '#fef2f2', color: 'var(--color-brand)' },
  medium:   { bg: '#fffbeb', color: 'var(--color-warning)' },
  low:      { bg: '#ecfdf5', color: 'var(--color-success)' },
}
const TYPE_COLOR: Record<string, { bg: string; color: string }> = {
  standard:  { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  normal:    { bg: '#f0fdf4', color: '#16a34a' },
  emergency: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImpactCI {
  id: string; name: string; type: string; environment: string; distance: number
}
export interface ImpactIncident {
  id: string; number: string; title: string; severity: string; status: string
  ciName: string; ciId: string; createdAt: string; isOpen: boolean
}
export interface ImpactChange {
  id: string; number: string; title: string; type: string; status: string
  ciName: string; ciId: string; createdAt: string
}
export interface ImpactBreakdown {
  productionCIs: number; blastRadiusCIs: number; openIncidents: number
  failedChanges: number; ongoingChanges: number; scoreDetails: string
}
export interface ImpactAnalysis {
  riskScore: number; riskLevel: string
  blastRadius: ImpactCI[]; openIncidents: ImpactIncident[]
  recentChanges: ImpactChange[]; breakdown: ImpactBreakdown
}

interface ImpactPanelProps {
  analysis: ImpactAnalysis
  compact?: boolean
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const SECTION_HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  width: '100%', padding: '10px 0', fontSize: 'var(--font-size-body)', fontWeight: 600,
  color: colors.slate, background: 'none', border: 'none', cursor: 'pointer',
  borderBottom: `1px solid ${colors.border}`,
}

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)',
}

const EMPTY_MSG: CSSProperties = {
  fontSize: 'var(--font-size-body)', color: colors.slateLight, padding: '10px 0', fontStyle: 'italic',
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
  borderRadius: 4, fontSize: 'var(--font-size-body)', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
}

// ── Colour maps ───────────────────────────────────────────────────────────────

const RISK_PALETTE: Record<string, { bg: string; border: string; color: string }> = {
  low:      { bg: colors.severity.low.bg,      border: colors.severity.low.border,      color: colors.severity.low.text      },
  medium:   { bg: colors.severity.medium.bg,   border: colors.severity.medium.border,   color: colors.severity.medium.text   },
  high:     { bg: colors.severity.high.bg,     border: colors.severity.high.border,     color: colors.severity.high.text     },
  critical: { bg: colors.severity.critical.bg, border: colors.severity.critical.border, color: colors.severity.critical.text },
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImpactPanel({ analysis, compact = false }: ImpactPanelProps) {
  const [showBlast,       setShowBlast]       = useState(false)
  const [showIncidents,   setShowIncidents]   = useState(false)
  const [showChanges,     setShowChanges]     = useState(false)
  const [showAllChanges,  setShowAllChanges]  = useState(false)

  const palette     = RISK_PALETTE[analysis.riskLevel] ?? RISK_PALETTE['low']!
  const { breakdown } = analysis

  const openOnes     = analysis.openIncidents.filter((i) => i.isOpen)
  const recentClosed = analysis.openIncidents.filter((i) => !i.isOpen)
  const totalInc     = openOnes.length + recentClosed.length

  const metrics = [
    { count: breakdown.productionCIs,  label: 'CI production'    },
    { count: breakdown.blastRadiusCIs, label: 'nel blast radius' },
    { count: breakdown.openIncidents,  label: 'incident aperti'  },
    { count: breakdown.failedChanges,  label: 'change falliti'   },
    { count: breakdown.ongoingChanges, label: 'change in corso'  },
  ].filter((m) => m.count > 0)

  const hasMetrics = metrics.length > 0

  return (
    <>
      {/* Metrics strip — badge + counters */}
      <div style={{ background: '#f9fafb', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ ...BADGE_BASE, backgroundColor: palette.bg, color: palette.color, border: `1px solid ${palette.border}` }}>
          {analysis.riskLevel.toUpperCase()} · {analysis.riskScore}
        </span>
        {hasMetrics ? metrics.map((m) => (
          <span key={m.label} style={{ fontSize: 'var(--font-size-body)', color: colors.slate }}>
            <strong style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.brand }}>{m.count}</strong>{' '}{m.label}
          </span>
        )) : (
          <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, fontStyle: 'italic' }}>Nessun fattore di rischio rilevato</span>
        )}
      </div>

      {/* Score breakdown */}
      {breakdown.scoreDetails !== 'Nessun fattore di rischio rilevato' && (
        <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '6px 20px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          {breakdown.scoreDetails}
        </div>
      )}

      {/* Warning banner */}
      {(analysis.riskLevel === 'high' || analysis.riskLevel === 'critical') && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a', padding: '8px 20px', fontSize: 'var(--font-size-body)', color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ color: 'var(--color-trigger-timer)', flexShrink: 0, marginTop: 1 }} />
          <span>Questo change impatta CI critici. Valuta attentamente la finestra di manutenzione.</span>
        </div>
      )}

      {/* Collapsible sections — full mode only */}
      {!compact && (
        <div style={{ padding: '0 20px 8px 20px' }}>

          {/* Blast Radius */}
          <button style={SECTION_HEADER} onClick={() => setShowBlast((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitBranch size={14} style={{ color: 'var(--color-brand)' }} />
              Blast Radius <CountBadge count={analysis.blastRadius.length} />
            </span>
            <span style={{ color: 'var(--color-slate-light)' }}>{showBlast ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showBlast && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {analysis.blastRadius.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: 'var(--color-brand)', flexShrink: 0 }} />
                  Nessun CI nel blast radius
                </div>
              ) : (() => {
                const DIST_BG:    Record<number, string> = { 1: '#fef2f2', 2: '#fff7ed', 3: '#fefce8', 4: 'var(--color-slate-bg)' }
                const DIST_COLOR: Record<number, string> = { 1: 'var(--color-trigger-sla-breach)', 2: 'var(--color-brand)', 3: '#ca8a04', 4: 'var(--color-slate)' }
                const byDistance = analysis.blastRadius.reduce((acc, ci) => {
                  const d = ci.distance ?? 1
                  if (!acc[d]) acc[d] = []
                  acc[d]!.push(ci)
                  return acc
                }, {} as Record<number, ImpactCI[]>)
                return (
                  <>
                    {Object.entries(byDistance)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([dist, items]) => (
                        <CollapsibleGroup
                          key={dist}
                          title={dist === '1' ? 'Dipendenze dirette' : `Profondità ${dist}`}
                          count={items.length}
                        >
                          {items.map((ci) => (
                            <div key={ci.id} style={ROW}>
                              <span style={{ flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ci.name}</span>
                              <EnvBadge environment={ci.environment} />
                              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: DIST_BG[Number(dist)] ?? 'var(--color-slate-bg)', color: DIST_COLOR[Number(dist)] ?? 'var(--color-slate)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                {dist} hop
                              </span>
                            </div>
                          ))}
                        </CollapsibleGroup>
                      ))
                    }
                  </>
                )
              })()}
            </div>
          )}

          {/* Incidents */}
          <button style={SECTION_HEADER} onClick={() => setShowIncidents((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertCircle size={14} style={{ color: 'var(--color-brand)' }} />
              Incident <CountBadge count={totalInc} />
            </span>
            <span style={{ color: 'var(--color-slate-light)' }}>{showIncidents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showIncidents && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {totalInc === 0 ? (
                <div style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
                  <CheckCircle size={13} style={{ color: 'var(--color-brand)', flexShrink: 0 }} />
                  Nessun incident sui CI affected
                </div>
              ) : (
                <>
                  {openOnes.length > 0 && (
                    <CollapsibleGroup title="In corso" count={openOnes.length}>
                      {openOnes.map((inc) => {
                        const sv = SEV_STYLE[inc.severity] ?? { bg: '#f1f5f9', color: 'var(--color-slate)' }
                        return (
                          <a key={inc.id} href={`/incidents/${inc.id}`} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'flex-start', gap: 8, textDecoration: 'none' }}>
                            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'capitalize', backgroundColor: sv.bg, color: sv.color, flexShrink: 0, marginTop: 1 }}>{inc.severity}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inc.number}</div>
                              <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inc.title}</div>
                              <div style={{ marginTop: 2 }}><StatusBadge value={inc.status} /></div>
                            </div>
                          </a>
                        )
                      })}
                    </CollapsibleGroup>
                  )}
                  {recentClosed.length > 0 && (
                    <CollapsibleGroup title="Risolti" count={recentClosed.length}>
                      <div style={{ opacity: 0.45 }}>
                        {recentClosed.map((inc) => {
                          const sv = SEV_STYLE[inc.severity] ?? { bg: '#f1f5f9', color: 'var(--color-slate)' }
                          return (
                            <a key={inc.id} href={`/incidents/${inc.id}`} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'flex-start', gap: 8, textDecoration: 'none' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'capitalize', backgroundColor: sv.bg, color: sv.color, flexShrink: 0, marginTop: 1 }}>{inc.severity}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inc.number}</div>
                                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inc.title}</div>
                                <div style={{ marginTop: 2 }}><StatusBadge value={inc.status} /></div>
                              </div>
                            </a>
                          )
                        })}
                      </div>
                    </CollapsibleGroup>
                  )}
                </>
              )}
            </div>
          )}

          {/* Recent Changes */}
          <button style={SECTION_HEADER} onClick={() => setShowChanges((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitCommit size={14} style={{ color: 'var(--color-brand)' }} />
              Change Recenti <CountBadge count={analysis.recentChanges.length} />
            </span>
            <span style={{ color: 'var(--color-slate-light)' }}>{showChanges ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showChanges && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {analysis.recentChanges.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: 'var(--color-brand)', flexShrink: 0 }} />
                  Nessun change recente sui CI affected
                </div>
              ) : (() => {
                const DONE = ['completed', 'failed', 'rejected']
                const inCorso    = analysis.recentChanges.filter((c) => !DONE.includes(c.status))
                const completati = analysis.recentChanges.filter((c) =>  DONE.includes(c.status))
                const visibleCompletati = showAllChanges ? completati : completati.slice(0, 3)
                const changeRow = (ch: ImpactChange) => {
                  const tc = TYPE_COLOR[ch.type] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
                  return (
                    <a key={ch.id} href={`/changes/${ch.id}`} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'flex-start', gap: 8, textDecoration: 'none' }}>
                      <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'capitalize', backgroundColor: tc.bg, color: tc.color, flexShrink: 0, marginTop: 1 }}>{ch.type}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch.number}</div>
                        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch.title}</div>
                        <div style={{ marginTop: 2 }}><StatusBadge value={ch.status} /></div>
                      </div>
                    </a>
                  )
                }
                return (
                  <>
                    {inCorso.length > 0 && (
                      <CollapsibleGroup title="In corso" count={inCorso.length}>
                        {inCorso.map((ch) => changeRow(ch))}
                      </CollapsibleGroup>
                    )}
                    {completati.length > 0 && (
                      <CollapsibleGroup title="Completati" count={completati.length}>
                        <div style={{ opacity: 0.45 }}>
                          {visibleCompletati.map((ch) => changeRow(ch))}
                          {completati.length > 3 && (
                            <button
                              onClick={() => setShowAllChanges((p) => !p)}
                              style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <ChevronRight size={11} />
                              {showAllChanges ? 'Mostra meno' : `Altri ${completati.length - 3}`}
                            </button>
                          )}
                        </div>
                      </CollapsibleGroup>
                    )}
                  </>
                )
              })()}
            </div>
          )}

        </div>
      )}
    </>
  )
}
