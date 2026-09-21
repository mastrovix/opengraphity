/**
 * Gli stati a schermo — e sono DUE cose diverse (ondata 1).
 *
 * Un solo `StatusBadge` serviva entrambe, e mostrava il valore grezzo con le
 * sottolineature sostituite da spazi: `under_investigation` → «under
 * investigation». Ma le due cose hanno l'italiano in due posti diversi, e
 * confonderle è il motivo per cui non lo si leggeva da nessuno dei due:
 *
 *  - **stato di un TICKET** (incident, problem, richiesta): il valore è il nome
 *    di un PASSO del workflow, e l'italiano lo scrive l'admin sul passo, nel
 *    disegnatore (`WorkflowStep.label`). Dal vivo: la pastiglia diceva
 *    «closed» mentre venti pixel sotto il campo «Step workflow» diceva
 *    «Chiuso» — stesso stato, stessa pagina, due lingue.
 *  - **stato di un CI** (`ci.status`: active, decommissioned…): è un
 *    VOCABOLARIO (`ci_status`), e l'italiano è l'etichetta per valore che
 *    l'admin scrive nel Dizionario.
 *
 * Un componente solo non poteva sapere quale delle due fosse, e chiedere al
 * posto sbagliato non dà errore: dà il valore grezzo. Per questo sono due, e
 * ogni chiamante dichiara di cosa sta parlando.
 */
import { colors } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { useTranslation } from 'react-i18next'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'

/** Il valore grezzo, leggibile: l'ultima spiaggia quando l'etichetta non si conosce. */
function grezzo(value: string): string {
  return value.replace(/_/g, ' ')
}

/**
 * Lo stato di un CI, o di qualunque altro valore che venga da un VOCABOLARIO.
 * `vocabulary` di norma è `ci_status`; chi mostra un altro vocabolario lo dice.
 */
export function StatusBadge({ value, vocabulary = 'ci_status' }: { value: string; vocabulary?: string }) {
  const { labelOf } = useDomainVocabularies()
  return <span style={{ color: colors.slate }} title={value}>{labelOf(vocabulary, value) ?? grezzo(value)}</span>
}

/**
 * Lo stato di un TICKET: l'etichetta del passo del workflow di quell'entità.
 *
 * `entityType` è quello del workflow (`incident`, `problem`,
 * `service_request`, `change`): senza, non si sa in quale definizione cercare
 * il passo, e due entità possono avere un passo con lo stesso nome e
 * un'etichetta diversa.
 */
export function TicketStatusBadge({ value, entityType }: { value: string; entityType: string }) {
  const { isKnownStep, labelFor, loading } = useWorkflowSteps(entityType)
  const { t } = useTranslation()
  // `isKnownStep` guarda TUTTE le definizioni attive dell'entità, non solo
  // quella scelta: un tenant può averne più d'una (20 set 2026).
  if (isKnownStep(value)) return <span style={{ color: colors.slate }} title={value}>{labelFor(value)}</span>
  /*
   * UNO STATO CHE IL PROCESSO NON HA PIÙ (20 set 2026, dal giro nel browser).
   *
   * Nella lista delle richieste alcune righe dicevano «Inviata» e altre
   * «submitted»: lo stesso stato per chi guarda, due parole. La causa vera
   * era che il web leggeva UNA definizione di workflow e il tenant ne ha due
   * attive — ora `labelFor` guarda tutte (vedi `useWorkflowSteps`).
   *
   * Resta il caso dell'orfano VERO: un passo che nessuna definizione attiva
   * dichiara più, e su cui un ticket è rimasto. Il prodotto mostrava il nome
   * interno come se fosse un'etichetta; ora si vede che è un orfano, e il
   * perché sta nel titolo.
   *
   * Mentre i passi si caricano non si accusa nessuno: `byName` è vuoto per un
   * istante, e lampeggiare «orfano» su ogni riga sarebbe una bugia.
   */
  if (loading) return <span style={{ color: colors.slate }} title={value}>{grezzo(value)}</span>
  return (
    <span
      style={{ color: 'var(--color-slate-light)', fontStyle: 'italic' }}
      title={t('workflow.orphanStep', { step: value })}
    >
      {grezzo(value)}
    </span>
  )
}
