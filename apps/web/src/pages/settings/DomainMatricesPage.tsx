/**
 * Matrici di dominio (ondata 7 · A7-4).
 *
 * Le regole che traducono un valore di vocabolario in un altro — priorità =
 * impatto × urgenza, criticità del servizio → impatto, severità dell'allarme,
 * tipo di change × fascia di rischio, severità dell'import — erano tabelle nel
 * codice. Il Dizionario però permette di rinominare quei valori, e allora il
 * codice non li ritrovava e ripiegava su un default in silenzio.
 *
 * Qui si vedono e si modificano. Tre scelte di resa che vengono dal difetto:
 *  - le tendine contengono i valori **veri** del cliente (li manda il server
 *    con la matrice: nessuna lista copiata nel web, che è il difetto D-15);
 *  - una cella senza valore si vede **come tale**, con un avviso in testa alla
 *    matrice: un buco è un errore che scatterebbe più tardi, in un job;
 *  - una chiave rimasta fuori vocabolario dopo una rinomina si mostra in una
 *    sezione a parte, perché è così che si capisce cosa è successo.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Save, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { SectionCard } from '@/components/ui/SectionCard'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Select } from '@/components/ui/FormControls'
import { inputS, labelS } from '@/components/ui/styles'
import { GET_DOMAIN_MATRICES, GET_PRE_APPROVED_CHANGE_TYPES } from '@/graphql/queries'
import { UPDATE_DOMAIN_MATRIX, UPDATE_PRE_APPROVED_CHANGE_TYPES } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'

// ── Tipi ──────────────────────────────────────────────────────────────────────

interface Cell { key: string; inputs: string[]; value: string | null }

interface DomainMatrix {
  kind:         string
  inputs:       string[]
  output:       string
  inputValues:  string[][]
  outputValues: string[]
  cells:        Cell[]
  missing:      string[]
  stale:        string[]
  invalid:      string[]
  isDefault:    boolean
  updatedAt:    string | null
}

/** Le celle modificate dall'utente, per chiave (null = non toccata). */
type Draft = Record<string, string>

// ── Stili ─────────────────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 'var(--font-size-label)',
  color: colors.slateLight, fontWeight: 600, whiteSpace: 'nowrap',
}
const td: React.CSSProperties = { padding: '6px 10px', borderTop: '1px solid var(--color-border)' }
const warnBox: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 6,
  background: 'var(--color-warning-bg)', color: 'var(--color-warning-text)',
  border: '1px solid var(--color-warning-border)', marginBottom: 12,
  fontSize: 'var(--font-size-body)',
}

// ── Una matrice ───────────────────────────────────────────────────────────────

function MatrixCard({ matrix }: { matrix: DomainMatrix }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>({})

  // Quando il server ristampa la matrice (salvataggio, o vocabolario cambiato)
  // le modifiche locali non hanno più senso: si riparte dal dato vero.
  useEffect(() => { setDraft({}) }, [matrix])

  const valueOf = (cell: Cell): string => draft[cell.key] ?? cell.value ?? ''

  const twoDimensions = matrix.inputs.length === 2
  const rowValues = matrix.inputValues[0] ?? []
  const colValues = matrix.inputValues[1] ?? []
  const byKey = useMemo(() => new Map(matrix.cells.map((c) => [c.key, c])), [matrix.cells])
  const staleCells = matrix.cells.filter((c) => matrix.stale.includes(c.key))

  const [save, { loading }] = useMutation(UPDATE_DOMAIN_MATRIX, {
    refetchQueries: [GET_DOMAIN_MATRICES],
    onCompleted: () => { toast.success(t('pages.domainMatrices.saved')); setDraft({}) },
    onError: (e) => toast.error(e.message),
  })

  const missingNow = matrix.cells
    .filter((c) => !matrix.stale.includes(c.key) && !valueOf(c))
    .map((c) => c.key)
  // L'altra metà del residuo di una rinomina: la chiave è buona, il valore
  // salvato non è più nel vocabolario d'uscita. A runtime è un errore, e a
  // occhio non si vedeva — la tendina lo mostrerebbe come «da compilare»
  // senza dire che c'era qualcosa.
  const invalidNow = matrix.invalid.filter((k) => draft[k] === undefined || !matrix.outputValues.includes(draft[k]!))

  const onSave = () => {
    // Le chiavi fuori vocabolario NON si rimandano: salvare la matrice è anche
    // il modo di ripulire il residuo di una rinomina.
    const entries = matrix.cells
      .filter((c) => !matrix.stale.includes(c.key))
      .map((c) => ({ key: c.key, value: valueOf(c) }))
      .filter((e) => e.value !== '')
    void save({ variables: { kind: matrix.kind, entries } })
  }

  const cellSelect = (cell: Cell | undefined, ariaLabel: string) => {
    if (!cell) return null
    return (
      <Select
        aria-label={ariaLabel}
        style={{ ...inputS, minWidth: 130 }}
        value={valueOf(cell)}
        onChange={(e) => setDraft((d) => ({ ...d, [cell.key]: e.target.value }))}
      >
        <option value="">{t('pages.domainMatrices.emptyCell')}</option>
        {/* Un valore salvato che non è più nel vocabolario si VEDE, disabilitato:
            altrimenti la tendina sembrerebbe semplicemente «da compilare». */}
        {valueOf(cell) !== '' && !matrix.outputValues.includes(valueOf(cell)) && (
          <option value={valueOf(cell)} disabled>{t('pages.domainMatrices.outOfVocabulary', { value: valueOf(cell) })}</option>
        )}
        {matrix.outputValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </Select>
    )
  }

  return (
    <SectionCard
      collapsible={false}
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Table2 size={14} aria-hidden="true" />{t(`pages.domainMatrices.kinds.${matrix.kind}.title`)}</span>}
      headerRight={
        <Button onClick={onSave} disabled={loading} icon={<Save size={14} aria-hidden="true" />}>
          {t('common.save')}
        </Button>
      }
    >
      <div style={{ padding: 16 }}>
      <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)' }}>
        {t(`pages.domainMatrices.kinds.${matrix.kind}.description`)}
      </p>
      <p style={{ margin: '4px 0 12px', color: colors.slateLight, fontSize: 'var(--font-size-label)' }}>
        {t('pages.domainMatrices.vocabularies', { inputs: matrix.inputs.join(' × '), output: matrix.output })}
        {' · '}
        {matrix.isDefault
          ? t('pages.domainMatrices.factory')
          : t('pages.domainMatrices.editedAt', { at: matrix.updatedAt ?? '—' })}
      </p>

      {missingNow.length > 0 && (
        <div style={warnBox} role="status">
          <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t('pages.domainMatrices.missingWarning', { count: missingNow.length, keys: missingNow.slice(0, 6).join(', ') })}</span>
        </div>
      )}

      {invalidNow.length > 0 && (
        <div style={warnBox} role="status">
          <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t('pages.domainMatrices.invalidWarning', { count: invalidNow.length, keys: invalidNow.slice(0, 6).join(', ') })}</span>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        {twoDimensions ? (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <caption style={{ captionSide: 'top', textAlign: 'left', ...th }}>
              {t('pages.domainMatrices.tableCaption', { rows: matrix.inputs[0], cols: matrix.inputs[1] })}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={th}>{matrix.inputs[0]}</th>
                {colValues.map((c) => <th key={c} scope="col" style={th}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rowValues.map((r) => (
                <tr key={r}>
                  <th scope="row" style={{ ...th, fontWeight: 500 }}>{r}</th>
                  {colValues.map((c) => (
                    <td key={c} style={td}>
                      {cellSelect(byKey.get(`${r}|${c}`), `${matrix.inputs[0]!} ${r}, ${matrix.inputs[1]!} ${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th scope="col" style={th}>{matrix.inputs[0]}</th>
                <th scope="col" style={th}>{matrix.output}</th>
              </tr>
            </thead>
            <tbody>
              {(matrix.inputValues[0] ?? []).map((v) => (
                <tr key={v}>
                  <th scope="row" style={{ ...th, fontWeight: 500 }}>{v}</th>
                  <td style={td}>{cellSelect(byKey.get(v), `${matrix.inputs[0]!} ${v}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {staleCells.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ ...labelS, marginBottom: 4 }}>{t('pages.domainMatrices.staleTitle')}</p>
          <p style={{ margin: '0 0 6px', color: colors.slateLight, fontSize: 'var(--font-size-caption)' }}>
            {t('pages.domainMatrices.staleHint')}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-body)' }}>
            {staleCells.map((c) => <li key={c.key}>{c.key} → {c.value}</li>)}
          </ul>
        </div>
      )}
      </div>
    </SectionCard>
  )
}


// ── Tipi di change pre-approvati (ondata 8) ──────────────────────────────────
//
// Non è una matrice: «essere pre-approvato» è un concetto del codice, non un
// valore che il cliente possa rinominare. Ma per l'amministratore è la stessa
// cosa — una regola di dominio che decide lui — e prima era il letterale
// `standard` in quattro punti del codice: chi rinominava quel valore nel
// Dizionario perdeva la pre-approvazione senza che nessuno gliel'avesse detto.

function PreApprovedChangeTypesCard() {
  const { t } = useTranslation()
  const { data, loading, error } = useQuery<{ preApprovedChangeTypes: { types: string[]; vocabulary: string[] } }>(
    GET_PRE_APPROVED_CHANGE_TYPES, { fetchPolicy: 'cache-and-network' },
  )
  const [draft, setDraft] = useState<string[] | null>(null)
  const saved = data?.preApprovedChangeTypes
  const current = draft ?? saved?.types ?? []
  const dirty = draft !== null && saved != null && (draft.length !== saved.types.length || draft.some((v) => !saved.types.includes(v)))

  const [save, { loading: saving }] = useMutation(UPDATE_PRE_APPROVED_CHANGE_TYPES, {
    refetchQueries: [GET_PRE_APPROVED_CHANGE_TYPES],
    onCompleted: () => { toast.success(t('pages.domainMatrices.preApproved.saved')); setDraft(null) },
    onError: (e) => toast.error(e.message),
  })

  const toggle = (value: string) =>
    setDraft(current.includes(value) ? current.filter((v) => v !== value) : [...current, value])

  return (
    <SectionCard title={t('pages.domainMatrices.preApproved.title')} defaultOpen>
      <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, marginTop: 0 }}>
        {t('pages.domainMatrices.preApproved.help')}
      </p>
      {loading && !data && <p>{t('common.loading')}</p>}
      {error && <p style={{ color: 'var(--color-danger-text)' }}>{error.message}</p>}
      {saved && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {saved.vocabulary.map((value) => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={current.includes(value)}
                  onChange={() => toggle(value)}
                  style={{ accentColor: 'var(--color-brand)' }}
                />
                {value}
              </label>
            ))}
          </div>
          {current.length === 0 && (
            <p style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
              {t('pages.domainMatrices.preApproved.none')}
            </p>
          )}
          <Button onClick={() => void save({ variables: { types: current } })} disabled={!dirty || saving}>
            <Save size={14} /> {t('common.save')}
          </Button>
        </>
      )}
    </SectionCard>
  )
}

// ── Pagina ────────────────────────────────────────────────────────────────────

export function DomainMatricesPage() {
  const { t } = useTranslation()
  const { data, loading, error } = useQuery<{ domainMatrices: DomainMatrix[] }>(GET_DOMAIN_MATRICES, {
    fetchPolicy: 'cache-and-network',
  })

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Table2 size={22} color="var(--color-icon-accent)" />}>
          {t('pages.domainMatrices.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, marginTop: 4, marginBottom: 0 }}>
          {t('pages.domainMatrices.subtitle')}
        </p>
      </div>
      {loading && !data && <p>{t('common.loading')}</p>}
      {error && <p style={{ color: 'var(--color-danger-text)' }}>{error.message}</p>}
      {data?.domainMatrices.map((m) => <MatrixCard key={m.kind} matrix={m} />)}
      <PreApprovedChangeTypesCard />
    </PageContainer>
  )
}
