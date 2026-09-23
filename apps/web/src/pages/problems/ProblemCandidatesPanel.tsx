/**
 * THE PROBLEM CANDIDATES, AND WHAT WAS LOOKED AT TO FIND THEM (D15, tour of
 * 23 Sep 2026).
 *
 * The clustering compares the open incidents by their embeddings. An incident
 * whose embedding is not computed yet cannot be compared, and the panel said
 * «No cluster of recurring similar incidents found» even when NOTHING had been
 * analysed — an answer to a question nobody had asked. The API now says what
 * it examined (`examined`), what it left out (`notAnalysed`, queued now; of
 * those, `analysisFailures` failed) and whether it stopped at its cap
 * (`capped`). «No cluster» is said only when something was examined, and
 * whatever was left out is always said.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { colors, palette } from '@/lib/tokens'

export interface ProblemCandidate {
  title: string
  motivation: string
  incidents: { id: string; number: string | null; title: string; status: string; severity: string }[]
}

export interface ProblemCandidatesResult {
  candidates: ProblemCandidate[]
  examined: number
  notAnalysed: number
  analysisFailures: number
  capped: boolean
}

const noteStyle = { margin: '0 0 6px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' } as const

/** The lines that say what was examined and what was left out. */
function Coverage({ result }: { result: ProblemCandidatesResult }) {
  const { t } = useTranslation()
  const { examined, notAnalysed, analysisFailures, capped } = result
  const queued = Math.max(0, notAnalysed - analysisFailures)
  const leftOut = notAnalysed > 0 || capped
  return (
    <div data-testid="candidates-coverage">
      {examined > 0 && leftOut && <p style={noteStyle}>{t('pages.problems.candidates.examined', { count: examined })}</p>}
      {examined === 0 && notAnalysed > 0 && <p style={noteStyle}>{t('pages.problems.candidates.noneAnalysed')}</p>}
      {examined > 0 && queued > 0 && <p style={noteStyle}>{t('pages.problems.candidates.queued', { count: queued })}</p>}
      {analysisFailures > 0 && (
        <p role="alert" style={{ ...noteStyle, color: 'var(--color-danger)' }}>{t('pages.problems.candidates.failed', { count: analysisFailures })}</p>
      )}
      {capped && <p style={noteStyle}>{t('pages.problems.candidates.capped', { count: examined })}</p>}
    </div>
  )
}

export function ProblemCandidatesPanel({ result }: { result: ProblemCandidatesResult }) {
  const { t } = useTranslation()
  const { candidates, examined, notAnalysed } = result
  return (
    <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)', marginBottom: 8 }}>
        <Sparkles size={14} color="var(--color-brand)" /> {t('pages.problems.candidatesTitle')}
      </div>
      <Coverage result={result} />
      {/* «No cluster» is an answer only when something was examined. */}
      {candidates.length === 0 && examined > 0 && (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.problems.candidatesEmpty')}</p>
      )}
      {candidates.length === 0 && examined === 0 && notAnalysed === 0 && (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.problems.candidates.noOpenIncidents')}</p>
      )}
      {candidates.map((c, i) => (
        <div key={i} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 4 }}>{c.title}</div>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.45 }}>{c.motivation}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {c.incidents.map((inc) => (
              <Link key={inc.id} to={`/incidents/${inc.id}`} style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 6, background: colors.slateBg, color: 'var(--color-slate-dark)', textDecoration: 'none', border: `1px solid ${colors.border}` }}>
                {inc.number ?? inc.title.slice(0, 20)}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
