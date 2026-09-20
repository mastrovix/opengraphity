/**
 * PROPOSTE DI MIGLIORAMENTO (20 set 2026).
 *
 * Programma «Miglioramento continuo», ondata 1. La pagina dove il prodotto
 * dice che cosa si potrebbe fare meglio, e una persona decide.
 *
 * ## Quello che la revisione ha preteso, e che qui c'è
 * La prima stesura del progetto descriveva questa pagina in cinque righe —
 * «ogni riga: che cosa, perché, su quali dati, e due bottoni» — e un revisore
 * ha fatto il confronto con la pagina delle anomalie, che esiste dal 2026 e
 * ha filtri, conteggi, stati vuoti distinti, errore con riprova. Una pagina
 * nuova meno usabile di quella vecchia non si rilascia.
 *
 *  - **Tre stati vuoti diversi**, perché dicono tre cose diverse: «non è mai
 *    girata», «è girata e non c'è niente da proporre» (con la data), «non c'è
 *    niente *con questo filtro*». Confonderli è il difetto classico.
 *  - **La storia**: le decise si leggono, con chi, quando e perché. Una
 *    proposta rifiutata è una DECISIONE, e le decisioni si rileggono — senza,
 *    domattina nessuno sa che ieri ce n'erano dodici.
 *  - **Le prove sono link**, e quelle che chi guarda non può leggere si
 *    CONTANO: «3 dei 47 non sono visibili con i tuoi permessi» invece del
 *    silenzio.
 *  - **Tre esiti e non due**: «hai sbagliato analisi» e «hai ragione ma non lo
 *    faccio» sono informazioni diverse; e «non ora» esiste perché senza, chi
 *    vuole rimandare è costretto a rifiutare, e il rifiuto zittisce per sempre.
 *
 * ## Il titolo lo compone questa pagina
 * Dal server arriva `kind` + `params`, mai una frase: l'API non sa in che
 * lingua guarda chi legge.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, Check, X, Clock, RotateCcw, Play, AlertTriangle } from 'lucide-react'
import {
  GET_PROPOSALS, ACCEPT_PROPOSAL, REJECT_PROPOSAL, POSTPONE_PROPOSAL,
  UNDO_PROPOSAL, RUN_PROPOSAL_ANALYSIS,
} from '@/graphql/queries/proposals'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { StatTile } from '@/components/ui/StatTile'
import { useMe } from '@/hooks/useMe'
import { showError } from '@/lib/showError'
import { toast } from 'sonner'
import { colors, palette } from '@/lib/tokens'

interface Param { name: string; value: string }
interface Ref { entityType: string; id: string; label: string | null; visible: boolean }
interface Proposal {
  id: string; area: string; kind: string; params: Param[]
  evidence: { n: number; windowDays: number; hiddenRefs: number; refs: Ref[]; extra: Param[] }
  occurrences: number; windowDays: number; actionType: string | null
  rationale: string | null; rationaleLanguage: string | null
  status: string; createdAt: string
  decidedAt: string | null; decidedBy: string | null; decidedByName: string | null
  rejectedKind: string | null; rejectedNote: string | null; notNowUntil: string | null
  auditEntryId: string | null; executionError: string | null; undoable: boolean
}
interface Risultato {
  total: number; maxOpen: number; lastRunAt: string | null; aiAvailable: boolean
  counts: { open: number; accepted: number; rejected: number; notNow: number; expired: number; superseded: number }
  items: Proposal[]
}

/** I due gruppi della pagina: da decidere, e già decise. */
const DA_DECIDERE = ['open', 'not_now']
const DECISE      = ['accepted', 'rejected', 'expired', 'superseded']

/**
 * I NUMERI SI FORMATTANO QUI, NON NELL'API (20 set 2026, ondata 5).
 *
 * L'API manda `params` come stringhe, ed è giusto: non sa in che lingua
 * leggerà chi guarda — la lingua è di ogni persona, non del cliente. Ma una
 * stringa già formattata porta con sé il separatore decimale di chi l'ha
 * scritta, e su `c-one` si vedeva: il titolo diceva «29.1 h» col punto dentro
 * una frase italiana che diceva «29,12 ore».
 *
 * Quindi qui si torna indietro al numero, e la frase lo formatta con
 * `{{x, number}}`, che i18next risolve con la lingua corrente.
 *
 * La conversione è prudente: solo stringhe corte che tornano IDENTICHE da un
 * giro `Number()` → `String()`. Così uno zero iniziale, un'impronta di sole
 * cifre o un id restano quello che sono, e non diventano un numero con i
 * punti delle migliaia.
 */
const NUMERO = /^-?\d{1,9}(\.\d{1,3})?$/

export function valoreDelParametro(grezzo: string): string | number {
  if (!NUMERO.test(grezzo)) return grezzo
  const n = Number(grezzo)
  return String(n) === grezzo ? n : grezzo
}

const paramsDi = (p: Param[]): Record<string, string | number> =>
  Object.fromEntries(p.map((x) => [x.name, valoreDelParametro(x.value)]))

const dataBreve = (iso: string | null, lingua: string): string =>
  iso ? new Date(iso).toLocaleDateString(lingua === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

export function ProposalsPage() {
  const { t, i18n } = useTranslation()
  const { can } = useMe()
  const [vista, setVista] = useState<'open' | 'decided'>('open')
  const [inRifiuto, setInRifiuto] = useState<Proposal | null>(null)
  const [motivo, setMotivo] = useState('wrong_analysis')
  const [nota, setNota] = useState('')
  const [inCorso, setInCorso] = useState<string | null>(null)

  const stato = vista === 'open' ? DA_DECIDERE : DECISE
  const { data, loading, error, refetch } = useQuery<{ proposals: Risultato }>(GET_PROPOSALS, {
    variables: { status: stato, limit: 50, offset: 0 },
    fetchPolicy: 'cache-and-network',
  })

  const [accetta] = useMutation(ACCEPT_PROPOSAL)
  const [rifiuta] = useMutation(REJECT_PROPOSAL)
  const [rimanda] = useMutation(POSTPONE_PROPOSAL)
  const [disfa]   = useMutation(UNDO_PROPOSAL)
  const [analizza, { loading: inAnalisi }] = useMutation<{ runProposalAnalysis: { created: number } }>(RUN_PROPOSAL_ANALYSIS)

  const r = data?.proposals
  const puoDecidere = can('proposal.accept')
  const puoLanciare = can('proposal.run')

  const conAttesa = async (id: string, fn: () => Promise<unknown>) => {
    setInCorso(id)
    try { await fn(); await refetch() }
    catch (e) { showError(e, t('pages.proposals.actionFailed')) }
    finally { setInCorso(null) }
  }

  const lancia = async () => {
    try {
      const esito = await analizza()
      await refetch()
      const create = Number(esito.data?.runProposalAnalysis?.created ?? 0)
      // Un esito riuscito è un successo, non un errore: `showError` lo
      // mostrava in rosso con la crocetta, e a schermo sembrava un guasto.
      toast.success(create > 0
        ? t('pages.proposals.runCreated', { count: create })
        : t('pages.proposals.runNothing'))
    } catch (e) { showError(e, t('pages.proposals.runFailed')) }
  }

  return (
    <PageContainer>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <PageTitle icon={<Lightbulb size={22} color="var(--color-icon-accent)" aria-hidden="true" />}>
            {t('pages.proposals.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {t('pages.proposals.subtitle')}
          </p>
        </div>
        {puoLanciare && (
          <Button onClick={() => void lancia()} disabled={inAnalisi} icon={<Play size={15} aria-hidden="true" />}>
            {inAnalisi ? t('pages.proposals.running') : t('pages.proposals.runNow')}
          </Button>
        )}
      </div>

      {/*
        Senza chiave Anthropic gli analisti AI non esistono: restano solo le
        proposte deterministiche. Si dice, invece di lasciar credere che non ci
        sia niente da proporre.
      */}
      {r && !r.aiAvailable && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          padding: '10px 14px', borderRadius: 8,
          background: palette.info.light, border: `1px solid ${palette.info.border}`,
          fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
        }}>
          <AlertTriangle size={16} aria-hidden="true" />
          {t('pages.proposals.noAiKey')}
        </div>
      )}

      {r && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <StatTile label={t('pages.proposals.counts.open')}     value={r.counts.open}
                    context={t('pages.proposals.counts.ofMax', { max: r.maxOpen })} />
          <StatTile label={t('pages.proposals.counts.accepted')} value={r.counts.accepted} />
          <StatTile label={t('pages.proposals.counts.rejected')} value={r.counts.rejected} />
          <StatTile label={t('pages.proposals.counts.expired')}  value={r.counts.expired} />
        </div>
      )}

      <div role="tablist" aria-label={t('pages.proposals.viewLabel')} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['open', 'decided'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={vista === v}
            onClick={() => setVista(v)}
            style={{
              padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
              fontSize: 'var(--font-size-body)', fontWeight: vista === v ? 600 : 400,
              border: `1.5px solid ${vista === v ? 'var(--color-brand)' : 'var(--color-border)'}`,
              background: vista === v ? palette.info.light : 'var(--color-slate-bg)',
              color: vista === v ? 'var(--color-brand)' : 'var(--color-slate)',
            }}>
            {t(v === 'open' ? 'pages.proposals.viewOpen' : 'pages.proposals.viewDecided')}
          </button>
        ))}
      </div>

      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {!error && loading && !r && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-slate-light)' }}>{t('common.loading')}</div>
      )}

      {/*
        I TRE STATI VUOTI, che dicono tre cose diverse. Il primo è il caso in
        cui la funzione non ha ancora lavorato; il secondo è quello in cui ha
        lavorato e va tutto bene — ed è un'informazione, non un vuoto; il terzo
        è colpa del filtro, e va detto perché altrimenti sembra il secondo.
      */}
      {!error && r && r.items.length === 0 && (
        vista === 'decided'
          ? <EmptyState icon={<Lightbulb size={40} />} title={t('pages.proposals.emptyDecided')} />
          : r.lastRunAt == null
            ? <EmptyState icon={<Play size={40} />}
                title={t('pages.proposals.emptyNeverRun')}
                description={t('pages.proposals.emptyNeverRunHelp')} />
            : <EmptyState icon={<Check size={40} />}
                title={t('pages.proposals.emptyAllGood')}
                description={t('pages.proposals.emptyAllGoodHelp', { date: dataBreve(r.lastRunAt, i18n.language) })} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {r?.items.map((p: Proposal) => {
          const params = paramsDi(p.params)
          const occupato = inCorso === p.id
          return (
            <div key={p.id} style={{
              background: colors.white, border: '1px solid var(--color-border)',
              borderRadius: 10, padding: '16px 18px',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                    {t(`proposals.kind.${p.kind}`, params)}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 4 }}>
                    {t(`proposals.area.${p.area}`)} · {dataBreve(p.createdAt, i18n.language)}
                    {p.windowDays > 0 && ` · ${t('pages.proposals.window', { count: p.windowDays })}`}
                  </div>
                </div>
                <span style={{
                  padding: '3px 10px', borderRadius: 999, fontSize: 'var(--font-size-label)', fontWeight: 600,
                  background: palette.info.tint, color: 'var(--color-brand)',
                }}>
                  {t('pages.proposals.occurrences', { count: p.occurrences })}
                </span>
              </div>

              {/*
                Il rationale è prosa di un modello: si dice che l'ha scritta un
                modello, e in che lingua se è diversa da quella di chi legge.
              */}
              {p.rationale && (
                <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  {p.rationale}
                  {p.rationaleLanguage && p.rationaleLanguage !== i18n.language && (
                    <span style={{ color: 'var(--color-slate-light)' }}> — {t('pages.proposals.writtenIn', { lang: p.rationaleLanguage })}</span>
                  )}
                </p>
              )}

              {(p.evidence.refs.length > 0 || p.evidence.hiddenRefs > 0) && (
                <div style={{ marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  <span style={{ fontWeight: 600 }}>{t('pages.proposals.evidence')}: </span>
                  {p.evidence.refs.filter((x: Ref) => x.visible).map((x: Ref) => x.label ?? x.id).join(', ')}
                  {p.evidence.hiddenRefs > 0 && (
                    <span style={{ color: 'var(--color-slate-light)' }}>
                      {p.evidence.refs.some((x: Ref) => x.visible) ? ' · ' : ''}
                      {t('pages.proposals.hiddenRefs', { count: p.evidence.hiddenRefs })}
                    </span>
                  )}
                </div>
              )}

              {p.executionError && (
                <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6,
                  background: palette.danger.tint, color: 'var(--color-trigger-sla-breach)',
                  fontSize: 'var(--font-size-body)' }}>
                  {t('pages.proposals.executionFailed', { error: p.executionError })}
                </div>
              )}

              {/* LA STORIA: chi ha deciso, quando, e perché. */}
              {p.decidedAt && vista === 'decided' && (
                <div style={{ marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  {t(`pages.proposals.decided.${p.status}`, {
                    who: p.decidedByName ?? t('pages.proposals.theProduct'),
                    date: dataBreve(p.decidedAt, i18n.language),
                  })}
                  {p.rejectedKind && (
                    <> — {t(`proposals.rejection.${p.rejectedKind}`)}{p.rejectedNote ? `: «${p.rejectedNote}»` : ''}</>
                  )}
                </div>
              )}

              {vista === 'open' && puoDecidere && (
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  {p.actionType && (
                    <Button onClick={() => void conAttesa(p.id, () => accetta({ variables: { id: p.id } }))}
                      disabled={occupato} icon={<Check size={15} aria-hidden="true" />}>
                      {t('pages.proposals.accept')}
                    </Button>
                  )}
                  <Button variant="secondary" disabled={occupato}
                    onClick={() => { setInRifiuto(p); setMotivo('wrong_analysis'); setNota('') }}
                    icon={<X size={15} aria-hidden="true" />}>
                    {t('pages.proposals.reject')}
                  </Button>
                  {p.status === 'open' && (
                    <Button variant="secondary" disabled={occupato}
                      onClick={() => {
                        const fra7 = new Date(Date.now() + 7 * 86_400_000).toISOString()
                        void conAttesa(p.id, () => rimanda({ variables: { id: p.id, until: fra7 } }))
                      }}
                      icon={<Clock size={15} aria-hidden="true" />}>
                      {t('pages.proposals.notNow')}
                    </Button>
                  )}
                </div>
              )}

              {vista === 'decided' && p.undoable && puoDecidere && (
                <div style={{ marginTop: 14 }}>
                  <Button variant="secondary" disabled={occupato}
                    onClick={() => void conAttesa(p.id, () => disfa({ variables: { id: p.id } }))}
                    icon={<RotateCcw size={15} aria-hidden="true" />}>
                    {t('pages.proposals.undo')}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Modal
        open={inRifiuto != null}
        onClose={() => setInRifiuto(null)}
        title={t('pages.proposals.rejectTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setInRifiuto(null)}>{t('common.cancel')}</Button>
            <Button
              disabled={nota.trim().length < 10}
              onClick={() => {
                const p = inRifiuto
                if (!p) return
                setInRifiuto(null)
                void conAttesa(p.id, () => rifiuta({ variables: { id: p.id, kind: motivo, note: nota.trim() } }))
              }}>
              {t('pages.proposals.reject')}
            </Button>
          </>
        }
      >
        <p style={{ margin: '0 0 14px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          {t('pages.proposals.rejectHelp')}
        </p>
        <div role="radiogroup" aria-label={t('pages.proposals.rejectReason')} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {(['wrong_analysis', 'valid_but_declined'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={motivo === k} onClick={() => setMotivo(k)}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
                border: `1.5px solid ${motivo === k ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: motivo === k ? palette.info.light : colors.white,
                fontSize: 'var(--font-size-body)',
              }}>
              <span style={{ fontWeight: 600 }}>{t(`proposals.rejection.${k}`)}</span>
              <span style={{ display: 'block', color: 'var(--color-slate)', marginTop: 2 }}>
                {t(`proposals.rejectionHelp.${k}`)}
              </span>
            </button>
          ))}
        </div>
        <label htmlFor="proposal-reject-note" style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, marginBottom: 6 }}>
          {t('pages.proposals.rejectNote')}
        </label>
        <textarea id="proposal-reject-note" value={nota} onChange={(e) => setNota(e.target.value)}
          rows={3} placeholder={t('pages.proposals.rejectNotePlaceholder')}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 'var(--font-size-body)', boxSizing: 'border-box', fontFamily: 'inherit' }} />
      </Modal>
    </PageContainer>
  )
}
