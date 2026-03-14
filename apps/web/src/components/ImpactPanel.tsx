import type { CSSProperties } from 'react'
import { useState } from 'react'
import { TypeBadge, EnvBadge } from '@/components/Badges'
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
  width: '100%', padding: '10px 0', fontSize: 12, fontWeight: 700,
  color: '#374151', background: 'none', border: 'none', cursor: 'pointer',
  borderBottom: '1px solid #e5e7eb',
}

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13,
}

const EMPTY_MSG: CSSProperties = {
  fontSize: 12, color: '#8892a4', padding: '10px 0', fontStyle: 'italic',
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
  borderRadius: 4, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
}

// ── Colour maps ───────────────────────────────────────────────────────────────

const RISK_PALETTE: Record<string, { bg: string; border: string; color: string }> = {
  low:      { bg: 'rgba(34,197,94,0.07)',  border: '#22c55e', color: '#15803d' },
  medium:   { bg: 'rgba(234,179,8,0.07)',  border: '#eab308', color: '#a16207' },
  high:     { bg: 'rgba(249,115,22,0.08)', border: '#f97316', color: '#c2410c' },
  critical: { bg: 'rgba(239,68,68,0.08)',  border: '#ef4444', color: '#b91c1c' },
}

const DIST_COLORS: Record<number, string> = { 1: '#dc2626', 2: '#f97316', 3: '#eab308' }


const STATUS_DOT: Record<string, string> = {
  completed: '#22c55e', failed: '#dc2626', rejected: '#f97316',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
}

function DistBadge({ dist }: { dist: number }) {
  const color = DIST_COLORS[dist] ?? '#8892a4'
  return <span style={{ ...BADGE_BASE, backgroundColor: `${color}18`, color }}>{dist} hop</span>
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: '#8892a4',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '10px 0 4px 0',
    }}>
      {text}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImpactPanel({ analysis, compact = false }: ImpactPanelProps) {
  const [showBlast,       setShowBlast]       = useState(false)
  const [showIncidents,   setShowIncidents]   = useState(false)
  const [showChanges,     setShowChanges]     = useState(false)
  const [showAllChanges,  setShowAllChanges]  = useState(false)
  const [blastLimit,      setBlastLimit]      = useState(10)

  const palette     = RISK_PALETTE[analysis.riskLevel] ?? RISK_PALETTE['low']!
  const { breakdown } = analysis

  const openOnes     = analysis.openIncidents.filter((i) => i.isOpen)
  const recentClosed = analysis.openIncidents.filter((i) => !i.isOpen)
  const totalInc     = openOnes.length + recentClosed.length

  const metrics = [
    { count: breakdown.productionCIs,  label: 'CI production',     color: '#374151' },
    { count: breakdown.blastRadiusCIs, label: 'nel blast radius',  color: '#374151' },
    { count: breakdown.openIncidents,  label: 'incident aperti',   color: '#dc2626' },
    { count: breakdown.failedChanges,  label: 'change falliti',    color: '#dc2626' },
    { count: breakdown.ongoingChanges, label: 'change in corso',   color: '#d97706' },
  ].filter((m) => m.count > 0)

  const hasMetrics = metrics.length > 0

  return (
    <div style={{ border: `1.5px solid ${palette.border}`, borderRadius: 8, background: '#fff', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ backgroundColor: palette.bg, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Impact Analysis</span>
        <span style={{ ...BADGE_BASE, backgroundColor: palette.bg, color: palette.color, border: `1px solid ${palette.border}` }}>
          {analysis.riskLevel.toUpperCase()} · {analysis.riskScore}
        </span>
      </div>

      {/* Metrics strip */}
      <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '8px 16px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {hasMetrics ? metrics.map((m) => (
          <span key={m.label} style={{ fontSize: 12, color: '#374151' }}>
            <strong style={{ color: m.color }}>{m.count}</strong>{' '}{m.label}
          </span>
        )) : (
          <span style={{ fontSize: 12, color: '#8892a4', fontStyle: 'italic' }}>Nessun fattore di rischio rilevato</span>
        )}
      </div>

      {/* Score breakdown */}
      {breakdown.scoreDetails !== 'Nessun fattore di rischio rilevato' && (
        <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '6px 16px', fontSize: 11, color: '#8892a4', fontFamily: 'monospace' }}>
          {breakdown.scoreDetails}
        </div>
      )}

      {/* Warning banner */}
      {(analysis.riskLevel === 'high' || analysis.riskLevel === 'critical') && (
        <div style={{ background: '#fffbeb', borderTop: '1px solid #fde68a', borderBottom: '1px solid #fde68a', padding: '8px 16px', fontSize: 12, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <span>Questo change impatta CI critici. Valuta attentamente la finestra di manutenzione.</span>
        </div>
      )}

      {/* Collapsible sections — full mode only */}
      {!compact && (
        <div style={{ padding: '0 16px 8px 16px' }}>

          {/* Blast Radius */}
          <button style={SECTION_HEADER} onClick={() => setShowBlast((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitBranch size={14} />
              Blast Radius ({analysis.blastRadius.length} CI)
            </span>
            <span style={{ color: '#8892a4' }}>{showBlast ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showBlast && (
            <div style={{ paddingBottom: 8 }}>
              {analysis.blastRadius.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: '#10b981', flexShrink: 0 }} />
                  Nessun CI nel blast radius
                </div>
              ) : (
                <>
                  {analysis.blastRadius.slice(0, blastLimit).map((ci) => (
                    <div key={ci.id} style={ROW}>
                      <TypeBadge type={ci.type} />
                      <span style={{ flex: 1, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ci.name}</span>
                      <EnvBadge environment={ci.environment} />
                      <DistBadge dist={ci.distance} />
                    </div>
                  ))}
                  {analysis.blastRadius.length > blastLimit && (
                    <button onClick={() => setBlastLimit((l) => l + 10)} style={{ fontSize: 11, color: '#4f46e5', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
                      Mostra altri {analysis.blastRadius.length - blastLimit}…
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Incidents */}
          <button style={SECTION_HEADER} onClick={() => setShowIncidents((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertCircle size={14} />
              Incident ({totalInc})
            </span>
            <span style={{ color: '#8892a4' }}>{showIncidents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showIncidents && (
            <div style={{ paddingBottom: 8 }}>
              {totalInc === 0 ? (
                <div style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8892a4' }}>
                  <CheckCircle size={13} />
                  Nessun incident sui CI affected
                </div>
              ) : (
                <>
                  {openOnes.length > 0 && (
                    <>
                      <SectionLabel text="In corso" />
                      <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
                        {openOnes.map((inc) => (
                          <div key={inc.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f97316', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <a href={`/incidents/${inc.id}`} style={{ fontSize: 13, color: '#111827', textDecoration: 'none', fontWeight: 500 }}>{inc.title}</a>
                              <span style={{ color: '#8892a4', fontSize: 11 }}>{' · '}{inc.ciName}</span>
                            </div>
                            <span style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{inc.severity}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {recentClosed.length > 0 && (
                    <>
                      <SectionLabel text="Risolti" />
                      <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4, opacity: 0.45 }}>
                        {recentClosed.map((inc) => (
                          <div key={inc.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <a href={`/incidents/${inc.id}`} style={{ fontSize: 13, color: '#111827', textDecoration: 'none', fontWeight: 500 }}>{inc.title}</a>
                              <span style={{ color: '#8892a4', fontSize: 11 }}>{' · '}{inc.ciName}</span>
                            </div>
                            <span style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{inc.severity}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Recent Changes */}
          <button style={SECTION_HEADER} onClick={() => setShowChanges((v) => !v)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitCommit size={14} />
              Change Recenti ({analysis.recentChanges.length})
            </span>
            <span style={{ color: '#8892a4' }}>{showChanges ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button>
          {showChanges && (
            <div style={{ paddingBottom: 8 }}>
              {analysis.recentChanges.length === 0 ? (
                <div style={{ ...EMPTY_MSG, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} style={{ color: '#10b981', flexShrink: 0 }} />
                  Nessun change recente sui CI affected
                </div>
              ) : (() => {
                const DONE = ['completed', 'failed', 'rejected']
                const inCorso    = analysis.recentChanges.filter((c) => !DONE.includes(c.status))
                const completati = analysis.recentChanges.filter((c) =>  DONE.includes(c.status))
                const visibleCompletati = showAllChanges ? completati : completati.slice(0, 3)
                const changeRow = (ch: ImpactChange) => (
                  <div key={ch.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_DOT[ch.status] ?? '#f97316', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <a href={`/changes/${ch.id}`} style={{ fontSize: 13, color: '#111827', textDecoration: 'none', fontWeight: 500 }}>{ch.title}</a>
                      <span style={{ color: '#8892a4', fontSize: 11 }}>{' · '}{ch.ciName} · {formatDate(ch.createdAt)}</span>
                    </div>
                    <span style={{ fontSize: 11, color: '#8892a4', whiteSpace: 'nowrap' }}>{ch.status}</span>
                  </div>
                )
                return (
                  <>
                    {inCorso.length > 0 && (
                      <>
                        <SectionLabel text="In corso" />
                        <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
                          {inCorso.map((ch) => changeRow(ch))}
                        </div>
                      </>
                    )}
                    {completati.length > 0 && (
                      <>
                        <SectionLabel text="Completati" />
                        <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4, opacity: 0.45 }}>
                          {visibleCompletati.map((ch) => changeRow(ch))}
                          {completati.length > 3 && (
                            <button
                              onClick={() => setShowAllChanges((p) => !p)}
                              style={{ fontSize: 11, color: '#8892a4', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <ChevronRight size={11} />
                              {showAllChanges ? 'Mostra meno' : `Altri ${completati.length - 3}`}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )
              })()}
            </div>
          )}

        </div>
      )}
    </div>
  )
}
