/**
 * «DESCRIVIMI IL REPORT E TE LO DISEGNO» — la casella (19 set 2026).
 *
 * Due passi: scrivi cosa ti serve, rileggi cosa ho capito, e il disegno entra
 * nel costruttore **come se l'avessi fatto a mano** — le stesse entità, lo
 * stesso grafo, gli stessi filtri e lo stesso grafico che avresti scelto tu,
 * modificabili in tutti i passi del wizard.
 *
 * ## Perché la revisione, e non direttamente nel wizard
 * Perché una proposta si accetta sapendo COSA si accetta: accanto a ogni pezzo
 * c'è il perché (il pezzo della frase da cui nasce) e sotto ci sono gli scarti
 * — quello che ho buttato, e perché. Senza, l'unica verifica possibile
 * sarebbe leggere il risultato e fidarsi.
 *
 * ## Niente si salva
 * Il progetto riempie il costruttore e si ferma lì: l'anteprima dal vivo dice
 * se i numeri sono quelli giusti, e «Salva la sezione» resta un gesto tuo.
 */
import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Sparkles, AlertTriangle } from 'lucide-react'
import { showError } from '@/lib/showError'
import { PROPOSE_REPORT_SECTION } from '@/graphql/mutations/reports'
import { Button } from '@/components/Button'
import { colors, fontWeight } from '@/lib/tokens'
import { ModaleCentrato } from '@/pages/settings/catalogForm/ModaleCentrato'

/** Il progetto come arriva dal server: gli stessi nomi di `ReportSectionInput`. */
export interface ProgettoReport {
  prompt: string
  title: string
  chartType: string
  metric: string
  metricField: string | null
  groupByNodeId: string | null
  groupByField: string | null
  limit: number
  sortDir: string
  nodes: {
    id: string; entityType: string; neo4jLabel: string; label: string
    isRoot: boolean; isResult: boolean; selectedFields: string[]
    filters: string | null; positionX: number; positionY: number; why: string
  }[]
  edges: {
    id: string; sourceNodeId: string; targetNodeId: string
    relationshipType: string; direction: string; label: string
  }[]
  why: string
  discarded: { what: string; key: string; params: string }[]
  notes: string[]
}

export function ModaleProgettoReportAI({ onChiudi, onApplica }: {
  onChiudi: () => void
  /** Mette il progetto nel costruttore: non salva. */
  onApplica: (progetto: ProgettoReport) => void
}) {
  const { t } = useTranslation()
  const [descrizione, setDescrizione] = useState('')
  const [progetto, setProgetto] = useState<ProgettoReport | null>(null)
  const [proponi, { loading: pensando }] = useMutation(PROPOSE_REPORT_SECTION, { onError: (e) => showError(e) })

  const chiedi = () => {
    void (async () => {
      try {
        const r = await proponi({ variables: { prompt: descrizione.trim() } })
        const p = (r.data as { proposeReportSection?: ProgettoReport } | null | undefined)?.proposeReportSection
        if (p) setProgetto(p)
      } catch {
        /* L'avviso lo mostra il link degli errori, tradotto: qui si prende il
           rifiuto per non lasciare una promessa non gestita, e si TIENE la
           descrizione — chi ha scritto tre righe non le riscrive. */
      }
    })()
  }

  return (
    <ModaleCentrato
      titolo={t('reportAI.title')}
      sottotitolo={t('reportAI.subtitle')}
      largo={720}
      onChiudi={onChiudi}
    >
      {progetto === null ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <label htmlFor="report-ai-description" style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
            {t('reportAI.promptLabel')}
          </label>
          <textarea
            id="report-ai-description"
            value={descrizione}
            onChange={(e) => { setDescrizione(e.target.value) }}
            rows={5}
            placeholder={t('reportAI.promptPlaceholder')}
            style={{
              width: '100%', padding: 10, borderRadius: 8, border: `1px solid ${colors.border}`,
              fontSize: 'var(--font-size-body)', fontFamily: 'inherit', resize: 'vertical',
            }}
          />
          <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
            {t('reportAI.promptHelp')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={chiedi} disabled={descrizione.trim().length < 8 || pensando}>
              <Sparkles size={14} style={{ marginRight: 6 }} />
              {pensando ? t('reportAI.thinking') : t('reportAI.design')}
            </Button>
            <Button variant="secondary" onClick={onChiudi}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ background: 'var(--color-surface-alt)', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('reportAI.youAsked')}</div>
            <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{progetto.prompt}</div>
          </div>

          <section>
            <Titolo testo={t('reportAI.whatIUnderstood')} />
            <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: fontWeight.medium }}>{progetto.title}</div>
            <Riga etichetta={t('reportAI.chart')} valore={t(`reportChart.type.${chiaveGrafico(progetto.chartType)}`)} />
            <Riga
              etichetta={t('reportAI.measure')}
              valore={progetto.metric === 'count'
                ? t('reportChart.metric.count')
                : `${t(`reportChart.metric.${progetto.metric}`)} · ${progetto.metricField ?? ''}`}
            />
            {progetto.groupByField !== null && (
              <Riga etichetta={t('reportAI.groupedBy')} valore={etichettaRaggruppamento(progetto)} />
            )}
            <Riga etichetta={t('reportAI.order')} valore={`${String(progetto.limit)} · ${progetto.sortDir}`} />
            {progetto.why !== '' && (
              <div style={{ marginTop: 4, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontStyle: 'italic' }}>{progetto.why}</div>
            )}
          </section>

          <section>
            <Titolo testo={t('reportAI.entities')} />
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {progetto.nodes.map((n) => (
                <li key={n.id} style={{ borderLeft: `2px solid ${colors.border}`, paddingLeft: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{n.label}</span>
                    {n.isRoot && <Pillola testo={t('reportAI.root')} />}
                    {n.selectedFields.length > 0 && (
                      <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                        {t('reportAI.columns', { fields: n.selectedFields.join(', ') })}
                      </span>
                    )}
                  </div>
                  {/* I FILTRI si leggono: sono la parte che cambia i numeri. */}
                  {n.filters !== null && <Filtri json={n.filters} />}
                  {n.why !== '' && (
                    <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontStyle: 'italic' }}>{n.why}</div>
                  )}
                </li>
              ))}
            </ul>
            {progetto.edges.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                {progetto.edges.map((e) => {
                  const da = progetto.nodes.find((n) => n.id === e.sourceNodeId)?.label ?? e.sourceNodeId
                  const verso = progetto.nodes.find((n) => n.id === e.targetNodeId)?.label ?? e.targetNodeId
                  return <li key={e.id}>{t('reportAI.link', { from: da, to: verso, relation: e.label || e.relationshipType })}</li>
                })}
              </ul>
            )}
          </section>

          {progetto.discarded.length > 0 && (
            <section>
              <Titolo testo={t('reportAI.discarded')} />
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                {progetto.discarded.map((s, i) => (
                  <li key={`${s.key}-${String(i)}`} style={{ display: 'flex', gap: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-amber)' }} />
                    <span><strong style={{ fontWeight: fontWeight.medium }}>{s.what}</strong>{' — '}{rendi(t, s)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {progetto.notes.length > 0 && (
            <section>
              <Titolo testo={t('reportAI.notes')} />
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                {progetto.notes.map((n, i) => <li key={String(i)}>{n}</li>)}
              </ul>
            </section>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => { onApplica(progetto); onChiudi() }}>{t('reportAI.apply')}</Button>
            <Button variant="secondary" onClick={() => { setProgetto(null) }}>{t('reportAI.again')}</Button>
            <Button variant="secondary" onClick={onChiudi}>{t('common.cancel')}</Button>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
            {t('reportAI.applyHelp')}
          </p>
        </div>
      )}
    </ModaleCentrato>
  )
}

/** Gli scarti arrivano come chiave + parametri JSON: si rendono nella lingua del cliente. */
function rendi(t: (k: string, o?: Record<string, unknown>) => string, s: { key: string; params: string }): string {
  let params: Record<string, unknown> = {}
  try { params = JSON.parse(s.params) as Record<string, unknown> }
  catch (err) { console.error('Unreadable params on a discarded proposal item', err) }
  return t(s.key, params)
}

/** `bar_horizontal` → `barHorizontal`: le chiavi i18n dei grafici sono in camelCase. */
function chiaveGrafico(tipo: string): string {
  return tipo.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function etichettaRaggruppamento(p: ProgettoReport): string {
  const nodo = p.nodes.find((n) => n.id === p.groupByNodeId)
  return nodo ? `${nodo.label} · ${p.groupByField ?? ''}` : (p.groupByField ?? '')
}

function Filtri({ json }: { json: string }) {
  const { t } = useTranslation()
  let regole: { field: string; operator: string; value: unknown }[] = []
  try { regole = JSON.parse(json) as typeof regole }
  catch (err) { console.error('Unreadable filters in a report proposal', err) }
  if (regole.length === 0) return null
  return (
    <ul style={{ margin: '2px 0', paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
      {regole.map((r, i) => (
        <li key={String(i)}>
          {r.field}{' '}{t(`reportBuilder.op.${r.operator}`)}{' '}
          {Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '')}
        </li>
      ))}
    </ul>
  )
}

function Titolo({ testo }: { testo: string }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-table)', textTransform: 'uppercase', letterSpacing: '0.04em',
      color: 'var(--color-slate-light)', fontWeight: fontWeight.medium, marginBottom: 4,
    }}>{testo}</div>
  )
}

function Riga({ etichetta, valore }: { etichetta: string; valore: string }) {
  return (
    <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
      {etichetta}: <span style={{ color: 'var(--color-slate-dark)' }}>{valore}</span>
    </div>
  )
}

function Pillola({ testo }: { testo: string }) {
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 999, fontSize: 'var(--font-size-table)',
      background: 'var(--color-brand-soft)', color: 'var(--color-brand)',
    }}>{testo}</span>
  )
}
