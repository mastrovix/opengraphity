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
  const { labelFor } = useWorkflowSteps(entityType)
  return <span style={{ color: colors.slate }} title={value}>{labelFor(value) || grezzo(value)}</span>
}
