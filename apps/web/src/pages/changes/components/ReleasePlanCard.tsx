/**
 * IL PIANO COMPLESSIVO sul dettaglio della change (decisione del proprietario,
 * 17 set 2026).
 *
 * Il calcolo sta in `../releasePlanSummary.ts`, che spiega il perché di ogni
 * regola; qui c'è solo il come si vede: un elenco in ordine di data, una riga
 * per finestra, col tipo (validazione o rilascio), il task e il CI.
 *
 * Si popola task per task: ogni piano compilato aggiunge le sue voci al posto
 * giusto nella cronologia, senza aspettare gli altri.
 */
import { Chip } from '@/components/ui/Chip'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { StatusLabel } from '@/components/ui/badges'
import { Pill } from '@/components/ui/Pill'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { Tabs } from '@/components/ui/Tabs'
import { formatDate } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import type { AffectedCI } from '@/types/change'
import {
  barreDelPiano, contaPerTipo, riepilogoRilascio, taccheDelPiano, vociFiltrate,
  type FiltroDelPiano, type TipoFinestra, type VoceDiPiano,
} from '../releasePlanSummary'
// Shared with the preview of the calendar: the same window reads the same way in both.
import { readableWindow } from '../readableWindow'

/** Validazione e rilascio si distinguono a colpo d'occhio: sono due mestieri diversi. */
function TipoPill({ tipo }: { tipo: TipoFinestra }) {
  const { t } = useTranslation()
  // Due tinte diverse, non due sfumature della stessa: sono due mestieri, e in
  // un elenco alternato devono distinguersi senza leggere l'etichetta.
  const stile = tipo === 'release' ? palette.purple : palette.info
  return (
    <Pill bg={stile.tint} color={stile.text} radius={10}>
      {t(tipo === 'release' ? 'pages.releasePlan.typeRelease' : 'pages.releasePlan.typeValidation')}
    </Pill>
  )
}

/**
 * The plan as a list: when, what kind, which step, which task, which CI. The
 * app's small table (26 Sep 2026), the same here and in the change calendar,
 * which leaves out the task column.
 */
export function PlanTable({ voci, withTask = true }: { voci: readonly VoceDiPiano[]; withTask?: boolean }) {
  const { t } = useTranslation()
  type Row = VoceDiPiano & { id: string }
  const columns: SimpleColumn<Row>[] = [
    { key: 'start', label: t('pages.releasePlan.when'), render: (_v, v) => <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{readableWindow(v.start, v.end)}</span> },
    { key: 'ciId', label: t('pages.releasePlan.type'), render: (_v, v) => <TipoPill tipo={v.tipo} /> },
    { key: 'stepTitle', label: t('pages.releasePlan.step') },
    ...(withTask ? [{ key: 'taskCode', label: t('pages.releasePlan.task'), render: (_v: unknown, v: Row) => <span style={{ whiteSpace: 'nowrap' }}>{v.taskCode ?? '—'}</span> } as SimpleColumn<Row>] : []),
    { key: 'ciName', label: t('pages.releasePlan.ci') },
  ]
  return <SimpleTable<Row> columns={columns} rows={voci.map((v, i) => ({ ...v, id: `${v.taskCode ?? v.ciId}-${v.tipo}-${String(i)}` }))} />
}

function Riquadro({ label, children, color }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: 'var(--color-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: color ?? 'var(--color-slate-dark)', fontVariantNumeric: 'tabular-nums' }}>{children}</div>
    </div>
  )
}

/**
 * IL GANTT DEL PIANO.
 *
 * L'elenco sotto dice QUANDO succede ogni cosa; questo dice quanto dura, cosa
 * si accavalla e dove sono i buchi — che in un elenco di righe non si vedono.
 * L'aritmetica sta in `releasePlanSummary` (e ha i suoi test): qui si disegna
 * e basta.
 *
 * Una riga per finestra, nello stesso ordine della tabella: chi guarda il
 * disegno e poi l'elenco trova le stesse cose nella stessa sequenza.
 */
function GanttDelPiano({ voci }: { voci: readonly VoceDiPiano[] }) {
  const { t } = useTranslation()
  const barre  = barreDelPiano(voci)
  const tacche = taccheDelPiano(voci)
  if (barre.length === 0) return null

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Le tacche: senza, un Gantt dice «più lungo» ma non «quando». */}
      <div style={{ position: 'relative', height: 16, marginLeft: 150 }}>
        {tacche.map((tacca) => (
          <span
            key={tacca.quando}
            style={{
              position: 'absolute', left: `${String(tacca.sinistra)}%`, top: 0,
              fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)',
              transform: tacca.sinistra > 90 ? 'translateX(-100%)' : 'none', whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatDate(new Date(tacca.quando).toISOString())}
          </span>
        ))}
      </div>

      {barre.map((b, i) => {
        const stile = b.voce.tipo === 'release' ? palette.purple : palette.info
        const quando = readableWindow(b.voce.start, b.voce.end)
        return (
          <div key={`${b.voce.taskCode ?? b.voce.ciId}-${b.voce.tipo}-${String(i)}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
            {/* L'etichetta a sinistra: il CI, che è la cosa che si cerca. */}
            <span style={{
              flex: '0 0 142px', width: 142, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={`${b.voce.ciName} · ${b.voce.stepTitle}`}>
              {b.voce.ciName}
            </span>
            <span style={{ position: 'relative', flex: 1, height: 18, background: 'var(--color-surface-2)', borderRadius: 4 }}>
              {/* Le tacche continuano dentro la corsia: è la griglia che rende
                  confrontabili due barre lontane. */}
              {tacche.map((tacca) => (
                <span key={tacca.quando} aria-hidden="true" style={{
                  position: 'absolute', left: `${String(tacca.sinistra)}%`, top: 0, bottom: 0,
                  borderLeft: '1px solid var(--color-border-light)',
                }} />
              ))}
              <span
                /* Il titolo porta le date VERE: una barra allargata per
                   farsi vedere non deve poter ingannare sulla durata. */
                title={b.allungata ? t('pages.releasePlan.ganttTooShort', { when: quando }) : quando}
                style={{
                  position: 'absolute', left: `${String(b.sinistra)}%`, width: `${String(b.larghezza)}%`,
                  top: 2, bottom: 2, borderRadius: 3, background: stile.text,
                  opacity: b.voce.tipo === 'release' ? 1 : 0.55,
                  border: b.allungata ? `1px dashed ${colors.white}` : 'none',
                }}
              />
            </span>
          </div>
        )
      })}

      {/* La legenda: due tinte, due mestieri. */}
      <div style={{ display: 'flex', gap: 14, marginTop: 6, marginLeft: 150, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
        {(['release', 'validation'] as const).map((tipo) => (
          <span key={tipo} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden="true" style={{
              width: 14, height: 8, borderRadius: 2,
              background: tipo === 'release' ? palette.purple.text : palette.info.text,
              opacity: tipo === 'release' ? 1 : 0.55,
            }} />
            {t(tipo === 'release' ? 'pages.releasePlan.typeRelease' : 'pages.releasePlan.typeValidation')}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ReleasePlanCard({ affected }: { affected: readonly AffectedCI[] }) {
  const { t } = useTranslation()
  const r = riepilogoRilascio(affected)
  /*
   * DUE VISTE DELLO STESSO PIANO, in due schede (18 set 2026).
   *
   * L'elenco porta i dettagli — il codice del task, il passo — e il Gantt
   * porta la forma: durate, sovrapposizioni, buchi. Impilarli faceva scorrere
   * per arrivare alla tabella, e il diagramma non è un'intestazione della
   * tabella: è un altro modo di guardare le stesse righe.
   *
   * Si apre sull'ELENCO, che è quello che c'era: chi tornava qui per leggere
   * un codice di task non deve cambiare scheda per ritrovarlo.
   */
  const [vista, setVista] = useState<'list' | 'gantt'>('list')
  /*
   * IL FILTRO PER TIPO, sulle DUE viste.
   *
   * Vale per l'elenco e per il Gantt insieme: sono due modi di guardare le
   * stesse righe, e un filtro che si applicasse a uno solo farebbe dire alle
   * due schede due cose diverse sullo stesso piano.
   *
   * Si apre su «entrambi», perché il piano È entrambe le cose: chi arriva qui
   * deve vedere tutto quello che succede quella notte, e poi semmai togliere.
   */
  const [filtro, setFiltro] = useState<FiltroDelPiano>('all')
  const voci   = vociFiltrate(r.voci, filtro)
  const conti  = contaPerTipo(r.voci)

  // Nessuna finestra e nessun task chiuso: non c'è ancora niente da
  // riepilogare, e una sezione vuota si legge come un piano che non esiste
  // invece che come un piano che non è ancora il momento di fare.
  if (r.voci.length === 0 && r.taskChiusi === 0) return null

  return (
    <SectionCard title={t('pages.releasePlan.title')} collapsible defaultOpen count={r.voci.length}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Riquadro label={t('pages.releasePlan.envelope')}>
          {r.inviluppo
            ? readableWindow(r.inviluppo.start, r.inviluppo.end)
            : <span style={{ color: colors.slateLight, fontWeight: 400 }}>{t('pages.releasePlan.noWindowYet')}</span>}
          {/* Quante finestre sono: «dal 21 al 25» da solo si legge come un
              fermo di quattro giorni. Se è un blocco unico non serve dirlo. */}
          {r.finestreDistinte > 1 && (
            <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 400, color: palette.warning.text, marginTop: 4 }}>
              {t('pages.releasePlan.windowsApart', { count: r.finestreDistinte })}
            </div>
          )}
        </Riquadro>
        <Riquadro label={t('pages.releasePlan.taskProgress')}>
          {t('pages.releasePlan.ofTotal', { done: r.taskChiusi, total: r.taskTotali })}
        </Riquadro>
        <Riquadro
          label={t('pages.releasePlan.plansDone')}
          color={r.pianiCompletati < r.pianiTotali ? palette.danger.text : undefined}
        >
          {t('pages.releasePlan.ofTotal', { done: r.pianiCompletati, total: r.pianiTotali })}
        </Riquadro>
      </div>

      {r.voci.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 12, borderBottom: '1px solid var(--color-border-light)' }}>
        <Tabs<'list' | 'gantt'>
          ariaLabel={t('pages.releasePlan.views')}
          items={[{ key: 'list', label: t('pages.releasePlan.tabList') }, { key: 'gantt', label: t('pages.releasePlan.tabGantt') }]}
          value={vista}
          onChange={setVista}
          style={{ borderBottom: 'none', marginBottom: 0 }}
        />

        {/* IL FILTRO: le stesse tinte delle barre e delle pill, così l'opzione
            e quello che seleziona si riconoscono senza leggere. Ogni opzione
            porta il suo conto: «Validazione 0» dice prima del clic che non
            c'è niente, invece di rispondere con una vista vuota. */}
        <div role="group" aria-label={t('pages.releasePlan.filterLabel')}
          style={{ display: 'flex', gap: 6, marginLeft: 'auto', paddingBottom: 6 }}>
          {(['all', 'release', 'validation'] as const).map((f) => {
            // «Entrambi» non ha una tinta sua: prende quella del marchio,
            // perché le due tinte sono dei due mestieri, non delle opzioni.
            const scelto = filtro === f
            return (
              <Chip pressed={scelto} key={f} onClick={() => { setFiltro(f) }}>
                {t(f === 'all' ? 'pages.releasePlan.filterBoth'
                  : f === 'release' ? 'pages.releasePlan.typeRelease'
                  : 'pages.releasePlan.typeValidation')}
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7, fontWeight: 400 }}>{conti[f]}</span>
              </Chip>
            )
          })}
        </div>
        </div>
      )}

      {/* Filtrato a zero: una vista vuota da sola si legge come un piano che
          non c'è, quando invece è una scelta di chi guarda. */}
      {r.voci.length > 0 && voci.length === 0 && (
        <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
          {t('pages.releasePlan.noneOfType')}
        </p>
      )}

      {voci.length > 0 && vista === 'gantt' && <GanttDelPiano voci={voci} />}

      {voci.length > 0 && vista === 'list' && (
        <PlanTable voci={voci} />
      )}

      {/* I piani senza una data non si possono mettere in fila, e stanno fuori
          dalla cronologia: ma vanno DETTI, col codice del task da reclamare —
          è la cosa che chi approva deve vedere prima di firmare. */}
      {r.senzaDate.length > 0 && (
        <div style={{
          marginTop: r.voci.length > 0 ? 14 : 0,
          border: `1px solid ${palette.danger.border}`, borderRadius: 8,
          background: palette.danger.tint, padding: '10px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-label)', fontWeight: 600, color: palette.danger.text, marginBottom: 6 }}>
            <AlertTriangle size={14} aria-hidden="true" />
            {t('pages.releasePlan.withoutDates', { count: r.senzaDate.length })}
          </div>
          {r.senzaDate.map((p) => (
            <div key={p.ciId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', padding: '2px 0' }}>
              <span style={{ fontWeight: 600 }}>{p.ciName}</span>
              <span style={{ color: palette.danger.text }}>{p.taskCode ?? '—'}</span>
              {p.teamName && <span style={{ color: 'var(--color-slate)' }}>{p.teamName}</span>}
              <StatusLabel status={p.stato} />
              <span style={{ color: 'var(--color-slate)' }}>
                {t(p.vuoto ? 'pages.releasePlan.noSteps' : 'pages.releasePlan.unusableDates')}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
