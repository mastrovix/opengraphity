import type { CSSProperties } from 'react'
import { useState } from 'react'
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImpactCI {
  id: string; name: string; type: string; environment: string; distance: number
}
export interface ImpactIncident {
  id: string; title: string; severity: string; status: string
  ciName: string; ciId: string; createdAt: string; isOpen: boolean
}
export interface ImpactChange {
  id: string; title: string; type: string; status: string
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
  width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600,
  color: '#64748b', background: 'none', border: 'none', cursor: 'pointer',
  borderBottom: '1px solid #e5e7eb',
}

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13,
}

const EMPTY_MSG: CSSProperties = {
  fontSize: 13, color: '#94a3b8', padding: '10px 0', fontStyle: 'italic',
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
  borderRadius: 4, fontSize: 13, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
}

// ── Colour maps ───────────────────────────────────────────────────────────────

const RISK_PALETTE: Record<string, { bg: string; border: string; color: string }> = {
  low:      { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d' },
  medium:   { bg: '#fefce8', border: '#fef08a', color: '#a16207' },
  high:     { bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
  critical: { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' },
}

const STATUS_DOT: Record<string, string> = {
  completed: '#22c55e', failed: '#dc2626', rejected: '#0284c7',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
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
          <span key={m.label} style={{ fontSize: 13, color: '#64748b' }}>
            <strong style={{ fontSize: 13, fontWeight: 600, color: '#0284c7' }}>{m.count}</strong>{' '}{m.label}
          </span>
        )) : (
          <span style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>Nessun fattore di rischio rilevato</span>
        )}
      </div>

      {/* Score breakdown */}
      {breakdown.scoreDetails !== 'Nessun fattore di rischio rilevato' && (
        <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '6px 20px', fontSize: 13, color: '#94a3b8' }}>
          {breakdown.scoreDetails}
        </div>
      )}

      {/* Warning banner */}
      {(analysis.riskLevel === 'high' || analysis.riskLevel === 'critical') && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a', padding: '8px 20px', fontSize: 13, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <span>Questo change impatta CI critici. Valuta attentamente la finestra di manutenzione.</span>
        </div>
      )}

      {/* Collapsible sections — full mode only */}
      {!compact && (
        <div style={{ padding: '0 20px 8px 20px' }}>

          {/* Blast Radius */}
          <button style={SECTION_HEADER} onClick={() => setShowBlast((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitBranch size={14} style={{ color: '#0284c7' }} />
              Blast Radius <CountBadge count={analysis.blastRadius.length} />
            </span>
            <span style={{ color: '#94a3b8' }}>{showBlast ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showBlast && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {analysis.blastRadius.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: '#0284c7', flexShrink: 0 }} />
                  Nessun CI nel blast radius
                </div>
              ) : (() => {
                const DIST_BG:    Record<number, string> = { 1: '#fef2f2', 2: '#fff7ed', 3: '#fefce8', 4: '#f1f5f9' }
                const DIST_COLOR: Record<number, string> = { 1: '#dc2626', 2: '#0284c7', 3: '#ca8a04', 4: '#64748b' }
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
                              <span style={{ flex: 1, fontSize: 13, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ci.name}</span>
                              <EnvBadge environment={ci.environment} />
                              <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: DIST_BG[Number(dist)] ?? '#f1f5f9', color: DIST_COLOR[Number(dist)] ?? '#64748b', whiteSpace: 'nowrap', flexShrink: 0 }}>
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
              <AlertCircle size={14} style={{ color: '#0284c7' }} />
              Incident <CountBadge count={totalInc} />
            </span>
            <span style={{ color: '#94a3b8' }}>{showIncidents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showIncidents && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {totalInc === 0 ? (
                <div style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#94a3b8' }}>
                  <CheckCircle size={13} style={{ color: '#0284c7', flexShrink: 0 }} />
                  Nessun incident sui CI affected
                </div>
              ) : (
                <>
                  {openOnes.length > 0 && (
                    <CollapsibleGroup title="In corso" count={openOnes.length}>
                      {openOnes.map((inc) => (
                        <div key={inc.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#0284c7', flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <a href={`/incidents/${inc.id}`} style={{ fontSize: 13, color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>{inc.title}</a>
                            <span style={{ color: '#94a3b8', fontSize: 13 }}>{' · '}{inc.ciName}</span>
                          </div>
                          <span style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{inc.severity}</span>
                        </div>
                      ))}
                    </CollapsibleGroup>
                  )}
                  {recentClosed.length > 0 && (
                    <CollapsibleGroup title="Risolti" count={recentClosed.length}>
                      <div style={{ opacity: 0.45 }}>
                        {recentClosed.map((inc) => (
                          <div key={inc.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <a href={`/incidents/${inc.id}`} style={{ fontSize: 13, color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>{inc.title}</a>
                              <span style={{ color: '#94a3b8', fontSize: 13 }}>{' · '}{inc.ciName}</span>
                            </div>
                            <span style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{inc.severity}</span>
                          </div>
                        ))}
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
              <GitCommit size={14} style={{ color: '#0284c7' }} />
              Change Recenti <CountBadge count={analysis.recentChanges.length} />
            </span>
            <span style={{ color: '#94a3b8' }}>{showChanges ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showChanges && (
            <div style={{ paddingBottom: 8, paddingLeft: 20 }}>
              {analysis.recentChanges.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: '#0284c7', flexShrink: 0 }} />
                  Nessun change recente sui CI affected
                </div>
              ) : (() => {
                const DONE = ['completed', 'failed', 'rejected']
                const inCorso    = analysis.recentChanges.filter((c) => !DONE.includes(c.status))
                const completati = analysis.recentChanges.filter((c) =>  DONE.includes(c.status))
                const visibleCompletati = showAllChanges ? completati : completati.slice(0, 3)
                const changeRow = (ch: ImpactChange) => (
                  <div key={ch.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_DOT[ch.status] ?? '#0284c7', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <a href={`/changes/${ch.id}`} style={{ fontSize: 13, color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>{ch.title}</a>
                      <span style={{ color: '#94a3b8', fontSize: 13 }}>{' · '}{ch.ciName} · {formatDate(ch.createdAt)}</span>
                    </div>
                    <span style={{ fontSize: 13, color: '#94a3b8', whiteSpace: 'nowrap' }}>{ch.status}</span>
                  </div>
                )
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
                              style={{ fontSize: 13, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}
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
