/**
 * IL CALENDARIO DELLE CHANGE (17 set 2026).
 *
 * Non c'era modo di rispondere a «cosa va in produzione questa settimana»: le
 * finestre si leggevano una change per volta, aprendo i CI uno a uno. Qui sono
 * tutte, in griglia, per settimana o per mese.
 *
 * Il calcolo — intervalli, giorni, sovrapposizioni — sta in
 * `./changeCalendarModel.ts`, che spiega il perché di ogni regola; qui c'è solo
 * il come si vede.
 *
 * ## Le scelte di lettura
 * - Il RILASCIO è in evidenza, la validazione è tenue: sono due mestieri, e
 *   chi guarda il calendario cerca il primo.
 * - Le SOVRAPPOSIZIONI si vedono senza leggere: bordo e tinta sulla casella,
 *   più il codice della change con cui urta. Rosso = stesso CI (conflitto
 *   vero), ambra = CI diversi (una notte carica, lo decide chi approva).
 * - Ogni voce porta l'ORA, il codice della change e il CI: sono le tre cose
 *   che servono a decidere, e stanno in una riga.
 * - I piani con date inservibili non si possono disegnare, quindi si DICONO in
 *   testa: un calendario che li tace si legge come completo.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CalendarDays, ChevronLeft, ChevronRight, AlertTriangle, List, ExternalLink } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { QueryError } from '@/components/QueryError'
import { GET_CHANGE_CALENDAR, GET_CHANGE_PREVIEW } from '@/graphql/queries'
import { formatHourMinute, formatDate, formatDateTime, currentLocale } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import { pausedWhenHidden } from '@/lib/polling'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { useCILabels } from '@/hooks/useCILabels'
import { ModalOverlay } from './components/shared'
import { riepilogoRilascio } from './releasePlanSummary'
import { readableWindow } from './readableWindow'
import { Pill } from '@/components/ui/Pill'
import type { DeployStep } from '@/types/change'
import {
  intervallo, scorri, conSovrapposizioni, riassunto, barreDellaSettimana, settimane, soloDelTipo, soloDelloStato,
  type Modo, type VoceCalendario, type VoceSegnata, type Sovrapposizione, type BarraDiCalendario, type FiltroTipo, type FiltroStato,
} from './changeCalendarModel'

/**
 * La tinta di una voce: prima la sovrapposizione, poi il tipo di finestra.
 *
 * La VALIDAZIONE era grigia su bianco e non si vedeva: adesso è blu, che ha un
 * testo scuro leggibile sulla sua tinta. E la differenza non è solo di colore —
 * il bordo è TRATTEGGIATO, pieno per il rilascio: blu e viola in tinta chiara
 * si somigliano, e chi non li separa bene distingue comunque la riga
 * tratteggiata da quella piena (17 set 2026).
 */
function stileVoce(v: VoceSegnata): { bg: string; fg: string; bordo: string; tratteggio: boolean } {
  const tratteggio = v.kind === 'validation'
  if (v.sovrapposizione === 'clash') return { bg: palette.danger.tint, fg: palette.danger.text, bordo: palette.danger.border, tratteggio }
  if (v.sovrapposizione === 'warn')  return { bg: palette.warning.tint, fg: palette.warning.text, bordo: palette.warning.border, tratteggio }
  if (v.kind === 'release')          return { bg: palette.purple.tint, fg: palette.purple.text, bordo: palette.purple.border, tratteggio: false }
  return { bg: palette.info.tint, fg: palette.info.text, bordo: palette.info.border, tratteggio: true }
}

/**
 * UNA BARRA: una finestra che attraversa i giorni che occupa.
 *
 * Con una casella per giorno un rilascio di ventiquattro ore compariva due
 * volte, e le due caselle non dicevano di essere la stessa cosa: tre rilasci
 * accavallati si leggevano come sei momenti distinti. Qui la barra è una, e le
 * barre impilate sotto le stesse colonne sono i rilasci nello stesso momento.
 *
 * Il bordo PIATTO da un lato dice che la finestra esce dalla settimana, invece
 * di far credere che cominci il lunedì o finisca la domenica. Le ore stanno
 * dentro la barra quando c'è spazio (`span` maggiore di uno), altrimenti solo
 * l'inizio: il suggerimento porta comunque le date intere.
 */
function Barra({ b, onClick }: { b: BarraDiCalendario; onClick: () => void }) {
  const { t } = useTranslation()
  const v = b.v
  const s = stileVoce(v)
  const tipo = t(v.kind === 'release' ? 'pages.changeCalendar.typeRelease' : 'pages.changeCalendar.typeValidation')
  // Each change under its own relation (tour of 23 Sep 2026): one line for all
  // of them named a change that only overlaps elsewhere as «same CI».
  const conflitto = [
    v.overlapsWith.length > 0 ? `\n${t('pages.changeCalendar.warnWith', { codes: v.overlapsWith.join(', ') })}` : '',
    v.sameCiWith.length > 0 ? `\n${t('pages.changeCalendar.clashWith', { codes: v.sameCiWith.join(', ') })}` : '',
  ].join('')
  const ore = b.span > 1
    ? `${formatHourMinute(v.start)} → ${formatHourMinute(v.end)}`
    : formatHourMinute(v.start)
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${v.code} · ${v.title}\n${tipo} · ${v.stepTitle}\n${v.ciName}${v.taskCode ? ` · ${v.taskCode}` : ''}\n${formatDateTime(v.start)} → ${formatDateTime(v.end)}${conflitto}`}
      style={{
        gridColumn: `${b.colonna + 1} / span ${b.span}`,
        gridRow: b.corsia + 1,
        display: 'flex', alignItems: 'center', gap: 5,
        minWidth: 0, textAlign: 'left', cursor: 'pointer',
        background: s.bg, color: s.fg,
        border: `1px ${s.tratteggio ? 'dashed' : 'solid'} ${s.bordo}`,
        // Il lato da cui la finestra continua non si chiude: la barra sembra
        // proseguire oltre il bordo della settimana, che è quello che fa.
        borderLeft:  b.continuaPrima ? 'none' : `1px ${s.tratteggio ? 'dashed' : 'solid'} ${s.bordo}`,
        borderRight: b.continuaDopo  ? 'none' : `1px ${s.tratteggio ? 'dashed' : 'solid'} ${s.bordo}`,
        borderRadius: `${b.continuaPrima ? 0 : 5}px ${b.continuaDopo ? 0 : 5}px ${b.continuaDopo ? 0 : 5}px ${b.continuaPrima ? 0 : 5}px`,
        padding: '3px 7px', margin: '0 1px',
        fontSize: 'var(--font-size-table)',
        fontWeight: v.kind === 'release' ? 600 : 400,
        overflow: 'hidden', whiteSpace: 'nowrap',
      }}
    >
      {b.continuaPrima && <span aria-hidden="true">←</span>}
      {v.sovrapposizione !== 'none' && <AlertTriangle size={11} style={{ flexShrink: 0 }} aria-hidden="true" />}
      <span style={{ flexShrink: 0 }}>{v.code}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 400, opacity: 0.9, flexShrink: 0 }}>{ore}</span>
      <span style={{ fontWeight: 400, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.ciName}</span>
      {b.continuaDopo && <span style={{ marginLeft: 'auto' }} aria-hidden="true">→</span>}
    </button>
  )
}

/**
 * L'ANTEPRIMA DI UNA CHANGE (17 set 2026, chiesta dal proprietario).
 *
 * Cliccare una barra portava via dal calendario: per sapere di che cosa si
 * trattava si perdeva la vista d'insieme, e per tornarci si premeva indietro.
 * Qui si legge il minimo che serve a decidere — titolo, perché, cosa, i CI
 * impattati — e da lì si apre la change vera solo se serve davvero.
 *
 * I dati si chiedono all'apertura, non col calendario: `why`, `what` e l'elenco
 * dei CI sono gli stessi per tutte le finestre di una change, e portarli su
 * ogni voce li avrebbe ripetuti una volta per passo del piano.
 */
function AnteprimaChange({ changeId, onClose }: { changeId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The environment with its Dictionary label, as in every other list of CIs (U-9/U-11).
  const { environmentLabel } = useCILabels()
  const { data, loading, error } = useQuery<{
    change: { id: string; code: string; title: string; why: string | null; what: string | null; changeType: string | null; priority: string | null } | null
    changeAffectedCIs: Array<{
      ci: { id: string; name: string; type: string | null; environment: string | null; supportGroup: { id: string; name: string } | null }
      deployPlan: { code: string; status: string; steps: DeployStep[]; assignedTeam: { id: string; name: string } | null } | null
    }>
  }>(GET_CHANGE_PREVIEW, { variables: { id: changeId }, fetchPolicy: 'cache-and-network' })

  const c = data?.change
  const ci = data?.changeAffectedCIs ?? []
  const piano = riepilogoRilascio(ci)

  const Campo = ({ etichetta, valore }: { etichetta: string; valore: string | null | undefined }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', marginBottom: 3 }}>{etichetta}</div>
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', whiteSpace: 'pre-wrap' }}>
        {valore && valore.trim() !== '' ? valore : <span style={{ color: colors.slateLight }}>{t('pages.changeCalendar.notGiven')}</span>}
      </div>
    </div>
  )

  return (
    <ModalOverlay title={c ? `${c.code} · ${c.title}` : t('pages.changeCalendar.preview')} onClose={onClose}>
      {error && <QueryError message={error.message} />}
      {loading && !c && <p style={{ color: colors.slateLight, margin: 0 }}>{t('common.loading')}</p>}
      {c && (
        <>
          <Campo etichetta={t('pages.changeDetail.why')} valore={c.why} />
          <Campo etichetta={t('pages.changeDetail.what')} valore={c.what} />
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', marginBottom: 5 }}>
              {t('pages.changeCalendar.affectedCIs', { count: ci.length })}
            </div>
            {ci.length === 0
              ? <span style={{ color: colors.slateLight, fontSize: 'var(--font-size-body)' }}>{t('pages.changeCalendar.noCI')}</span>
              : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                  {ci.map((x) => (
                    <li key={x.ci.id} style={{ marginBottom: 2 }}>
                      {x.ci.name}
                      {x.ci.environment && <span style={{ color: 'var(--color-slate)' }}>{' · '}{environmentLabel(x.ci.environment)}</span>}
                    </li>
                  ))}
                </ul>
              )}
          </div>
          {/*
            IL PIANO, in ordine di data. Si riusa `riepilogoRilascio` — la
            stessa funzione del riquadro sulla pagina di dettaglio, con i suoi
            test: la cronologia di una change è una cosa sola, e riscriverla
            qui avrebbe voluto dire due ordinamenti che col tempo divergono.
          */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', marginBottom: 5 }}>
              {t('pages.changeCalendar.plan')}
            </div>
            {piano.voci.length === 0 ? (
              <span style={{ color: colors.slateLight, fontSize: 'var(--font-size-body)' }}>{t('pages.changeCalendar.noPlan')}</span>
            ) : (
              <div className="og-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-label)' }}>
                  <tbody>
                    {piano.voci.map((v, i) => (
                      <tr key={`${v.taskCode ?? v.ciId}-${v.tipo}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--color-border-light)' }}>
                        <td style={{ padding: '5px 8px 5px 0', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--color-slate-dark)' }}>
                          {readableWindow(v.start, v.end)}
                        </td>
                        <td style={{ padding: '5px 8px' }}>
                          <Pill
                            bg={v.tipo === 'release' ? palette.purple.tint : palette.info.tint}
                            color={v.tipo === 'release' ? palette.purple.text : palette.info.text}
                            radius={10}
                          >
                            {t(v.tipo === 'release' ? 'pages.changeCalendar.typeRelease' : 'pages.changeCalendar.typeValidation')}
                          </Pill>
                        </td>
                        <td style={{ padding: '5px 8px', color: 'var(--color-slate-dark)' }}>{v.stepTitle}</td>
                        <td style={{ padding: '5px 0 5px 8px', color: 'var(--color-slate)' }}>{v.ciName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* I piani senza una data non si possono mettere in fila: si dicono,
                col codice del task da reclamare. */}
            {piano.senzaDate.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 'var(--font-size-label)', color: palette.danger.text }}>
                <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 4 }} aria-hidden="true" />
                {t('pages.changeCalendar.planWithoutDates', {
                  count: piano.senzaDate.length,
                  codes: piano.senzaDate.map((x) => x.taskCode ?? x.ciName).join(', '),
                })}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button size="xs" icon={<ExternalLink size={13} />} onClick={() => navigate(`/changes/${c.id}`)}>
              {t('pages.changeCalendar.openChange')}
            </Button>
          </div>
        </>
      )}
    </ModalOverlay>
  )
}

/**
 * UN INTERRUTTORE A SEGMENTI: settimana/mese e il filtro del tipo sono la
 * stessa cosa, e una copia per ciascuno avrebbe fatto divergere misure e
 * fuoco alla prima modifica.
 */
function Segmenti<T extends string>({ valore, scelte, onScegli }: {
  valore: T
  scelte: ReadonlyArray<{ v: T; etichetta: string }>
  onScegli: (v: T) => void
}) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
      {scelte.map((s) => (
        <button
          key={s.v}
          type="button"
          onClick={() => onScegli(s.v)}
          aria-pressed={valore === s.v}
          style={{
            border: 'none', cursor: 'pointer', padding: '5px 12px', fontSize: 'var(--font-size-label)',
            background: valore === s.v ? 'var(--color-brand)' : 'var(--color-surface)',
            color: valore === s.v ? 'var(--color-white)' : 'var(--color-slate-dark)',
            fontWeight: valore === s.v ? 600 : 400,
          }}
        >
          {s.etichetta}
        </button>
      ))}
    </div>
  )
}

function Legenda() {
  const { t } = useTranslation()
  const voci: Array<{ k: string; stile: Sovrapposizione | 'release' | 'validation' }> = [
    { k: 'pages.changeCalendar.typeRelease',    stile: 'release' },
    { k: 'pages.changeCalendar.typeValidation', stile: 'validation' },
    { k: 'pages.changeCalendar.legendClash',    stile: 'clash' },
    { k: 'pages.changeCalendar.legendWarn',     stile: 'warn' },
  ]
  const tinta = (s: string) =>
    s === 'clash' ? palette.danger.tint
      : s === 'warn' ? palette.warning.tint
        : s === 'release' ? palette.purple.tint
          : palette.info.tint
  const bordo = (s: string) =>
    s === 'clash' ? palette.danger.border
      : s === 'warn' ? palette.warning.border
        : s === 'release' ? palette.purple.border
          : palette.info.border
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
      {voci.map((v) => (
        <span key={v.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {/* Il campione della legenda porta anche il TRATTEGGIO: se mostrasse
              solo la tinta, direbbe metà di come si riconosce una validazione. */}
          <span style={{
            width: 14, height: 12, borderRadius: 3,
            background: tinta(v.stile),
            border: `1px ${v.stile === 'validation' ? 'dashed' : 'solid'} ${bordo(v.stile)}`,
          }} />
          {t(v.k)}
        </span>
      ))}
    </div>
  )
}

export function ChangeCalendarPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  /*
   * La categoria del passo viene dal workflow DEL TENANT: «conclusa» è una
   * categoria (`closed`, `resolved`, `failed`), non un nome, così un passo
   * rinominato non sparisce dal filtro.
   */
  const { categoryOf } = useWorkflowSteps('change')
  const [modo, setModo] = useState<Modo>('week')
  // Di default il RILASCIO: è quello che si cerca aprendo un calendario delle
  // change; le validazioni sono un secondo sguardo.
  const [tipo, setTipo] = useState<FiltroTipo>('release')
  const [stato, setStato] = useState<FiltroStato>('all')
  // La change di cui si sta leggendo l'anteprima; `null` = nessun modale.
  const [anteprima, setAnteprima] = useState<string | null>(null)
  // Il riferimento è un giorno qualsiasi dentro il periodo mostrato.
  const [riferimento, setRiferimento] = useState<Date>(() => new Date())

  const { da, a, giorni } = useMemo(() => intervallo(modo, riferimento), [modo, riferimento])

  const { data, loading, error } = useQuery<{
    changeCalendar: { entries: VoceCalendario[]; unreadablePlans: number }
  }>(GET_CHANGE_CALENDAR, {
    // L'intervallo va al server in ISO con offset esplicito, come pretende
    // l'API: `toISOString()` dà sempre `Z`.
    variables: { from: da.toISOString(), to: a.toISOString() },
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(60_000),
  })

  /*
   * `voci` sono TUTTE le finestre del periodo, segnate con le loro
   * sovrapposizioni; `mostrate` sono quelle che il filtro lascia passare. Le
   * due cose restano distinte perché il riassunto in testa conta sulle prime:
   * un filtro di vista non deve poter nascondere un conflitto.
   */
  const voci     = useMemo(() => conSovrapposizioni(data?.changeCalendar.entries ?? []), [data])
  const mostrate = useMemo(() => soloDelloStato(soloDelTipo(voci, tipo), stato, categoryOf), [voci, tipo, stato, categoryOf])
  const conti   = useMemo(() => riassunto(voci), [voci])
  const illeggibili = data?.changeCalendar.unreadablePlans ?? 0

  const oggi = new Date()
  const stessoGiorno = (x: Date, y: Date) =>
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()

  // L'etichetta del periodo: «14 – 20 set 2026» oppure «settembre 2026».
  const titoloPeriodo = modo === 'week'
    ? `${formatDate(giorni[0]!.toISOString())} – ${formatDate(giorni[giorni.length - 1]!.toISOString())}`
    : new Intl.DateTimeFormat(currentLocale(), { month: 'long', year: 'numeric' }).format(riferimento)

  const nomiGiorni = useMemo(() => {
    const f = new Intl.DateTimeFormat(currentLocale(), { weekday: 'short' })
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2026, 8, 14 + i))) // 14 set 2026 = lunedì
  }, [])

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      <ListPageHeader
        icon={<CalendarDays />}
        title={t('pages.changeCalendar.title')}
        subtitle={<p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.changeCalendar.subtitle')}</p>}
        actions={
          <Button variant="secondary" icon={<List size={14} />} onClick={() => navigate('/changes')}>
            {t('pages.changeCalendar.toList')}
          </Button>
        }
      />

      {/* La barra: periodo, spostamento, scelta settimana/mese. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="secondary" size="xs" onClick={() => setRiferimento((r) => scorri(modo, r, -1))} aria-label={t('pages.changeCalendar.previous')}>
            <ChevronLeft size={14} />
          </Button>
          <Button variant="secondary" size="xs" onClick={() => setRiferimento(new Date())}>{t('pages.changeCalendar.today')}</Button>
          <Button variant="secondary" size="xs" onClick={() => setRiferimento((r) => scorri(modo, r, 1))} aria-label={t('pages.changeCalendar.next')}>
            <ChevronRight size={14} />
          </Button>
          <strong style={{ fontSize: 'var(--font-size-section-title)', color: 'var(--color-slate-dark)', marginLeft: 6 }}>{titoloPeriodo}</strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Segmenti
            valore={tipo}
            onScegli={setTipo}
            scelte={[
              { v: 'all' as FiltroTipo,         etichetta: t('pages.changeCalendar.filterAll') },
              { v: 'release' as FiltroTipo,     etichetta: t('pages.changeCalendar.typeRelease') },
              { v: 'validation' as FiltroTipo,  etichetta: t('pages.changeCalendar.typeValidation') },
            ]}
          />
          <Segmenti
            valore={stato}
            onScegli={setStato}
            scelte={[
              { v: 'all' as FiltroStato,  etichetta: t('pages.changeCalendar.stateAll') },
              { v: 'open' as FiltroStato, etichetta: t('pages.changeCalendar.stateOpen') },
              { v: 'done' as FiltroStato, etichetta: t('pages.changeCalendar.stateDone') },
            ]}
          />
          <Segmenti
            valore={modo}
            onScegli={setModo}
            scelte={[
              { v: 'week' as Modo,  etichetta: t('pages.changeCalendar.week') },
              { v: 'month' as Modo, etichetta: t('pages.changeCalendar.month') },
            ]}
          />
        </div>
      </div>

      {/* Il riassunto: quante change, quanti rilasci, e quanti urti. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
        {/* Two counts, two plurals: one key with both read «1 changes · 1 release windows».
            The changes are counted as in the list of changes. */}
        <span>{`${t('pages.changes.count', { count: conti.change })} · ${t('pages.changeCalendar.releaseWindows', { count: conti.rilasci })}`}</span>
        {conti.conflitti > 0 && (
          <span style={{ color: palette.danger.text, fontWeight: 600 }}>
            <AlertTriangle size={12} style={{ verticalAlign: -1, marginRight: 4 }} aria-hidden="true" />
            {t('pages.changeCalendar.clashes', { count: conti.conflitti })}
          </span>
        )}
        {conti.avvisi > 0 && (
          <span style={{ color: palette.warning.text, fontWeight: 600 }}>
            {t('pages.changeCalendar.warns', { count: conti.avvisi })}
          </span>
        )}
        {illeggibili > 0 && (
          <span style={{ color: palette.danger.text }}>
            {t('pages.changeCalendar.unreadable', { count: illeggibili })}
          </span>
        )}
      </div>

      {error && <QueryError message={error.message} />}

      {/*
        LA GRIGLIA A BARRE. Una finestra è UNA barra che attraversa i giorni che
        occupa: con una casella per giorno, un rilascio di ventiquattro ore
        compariva due volte e le due caselle non dicevano di essere la stessa
        cosa. Barre impilate sotto le stesse colonne = rilasci nello stesso
        momento, e si legge dalla forma senza contare le ore.
      */}
      <div className="og-scroll-x">
        <div style={{ minWidth: 720 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4, marginBottom: 4 }}>
            {nomiGiorni.map((n) => (
              <div key={n} style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', textTransform: 'capitalize', padding: '0 4px' }}>{n}</div>
            ))}
          </div>

          {settimane(giorni).map((sett) => {
            const barre = barreDellaSettimana(mostrate, sett)
            const corsie = barre.reduce((m, b) => Math.max(m, b.corsia + 1), 0)
            return (
              <div key={sett[0]!.toISOString()} style={{ marginBottom: 6 }}>
                {/* I numeri dei giorni, con la settimana sotto. */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
                  {sett.map((g) => {
                    const fuoriMese = modo === 'month' && g.getMonth() !== riferimento.getMonth()
                    const eOggi = stessoGiorno(g, oggi)
                    return (
                      <div
                        key={g.toISOString()}
                        style={{
                          padding: '3px 6px', borderRadius: '6px 6px 0 0',
                          background: eOggi ? 'var(--color-brand)' : fuoriMese ? 'var(--color-surface-1)' : 'var(--color-surface-2)',
                          color: eOggi ? 'var(--color-white)' : fuoriMese ? colors.slateLight : 'var(--color-slate-dark)',
                          fontSize: 'var(--font-size-label)', fontWeight: eOggi ? 700 : 500,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {g.getDate()}
                      </div>
                    )
                  })}
                </div>
                {/* Le barre. `minHeight` anche a settimana vuota, così le righe
                    del mese restano allineate e la griglia non balla. */}
                <div
                  style={{
                    display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                    gap: 4, padding: '4px 0',
                    minHeight: corsie === 0 ? 26 : undefined,
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border-light)',
                    borderTop: 'none', borderRadius: '0 0 6px 6px',
                  }}
                >
                  {barre.map((b) => <Barra key={`${b.v.changeId}-${b.v.kind}-${b.v.start}`} b={b} onClick={() => setAnteprima(b.v.changeId)} />)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ marginTop: 14 }}><Legenda /></div>

      {anteprima && <AnteprimaChange changeId={anteprima} onClose={() => setAnteprima(null)} />}

      {/* Vuoto vero: nessuna finestra nel periodo. Si dice, invece di lasciare
          una griglia muta che si legge come «non ho caricato». */}
      {!loading && mostrate.length === 0 && (
        <p style={{ marginTop: 14, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>
          {t('pages.changeCalendar.empty')}
        </p>
      )}
    </PageContainer>
  )
}
