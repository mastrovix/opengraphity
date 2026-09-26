import { BackLink, DetailTitle } from '@/components/ui/BackLink'
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/ui/Pill'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { transitionButtonColors } from '@/lib/workflowStepStyle'
import { useValueStyle } from '@/hooks/useValueStyle'

interface WorkflowTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface Problem {
  id:       string
  number:   string
  title:    string
  priority: string
  status:   string
}

// Every problem status renders with the same brand colours — a single value,
// no per-name lookup needed.
const STATUS_BG = 'var(--color-brand-light)'
const STATUS_FG = 'var(--color-brand)'

function transitionButtonStyle(category: string | null | undefined, inputField: string | null, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 14px', borderRadius: 6,
    fontSize: 'var(--font-size-card-title)', fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: '1px solid transparent', transition: 'opacity 0.15s',
  }
  // D27: a transition that ends the problem badly is drawn as danger (lib/workflowStepStyle).
  return { ...base, ...transitionButtonColors(category, inputField, 'byCategory') }
}

interface ProblemHeaderProps {
  problem:            Problem
  manualTransitions:  WorkflowTransition[]
  transitioning:      boolean
  onBack:             () => void
  onTransitionClick:  (tr: WorkflowTransition) => void
}

export function ProblemHeader({
  problem,
  manualTransitions,
  transitioning,
  onBack,
  onTransitionClick,
}: ProblemHeaderProps) {
  const { t } = useTranslation()
  // F9: il colore della priorità dal Dizionario del cliente.
  const priorityStyle = useValueStyle()('priority', problem.priority)
  const { byName: stepByName, labelFor } = useWorkflowSteps('problem')
  const { labelOf } = useDomainVocabularies()
  return (
    <div style={{ marginBottom: 24 }}>
      <BackLink onClick={onBack}>{t('common.back')}</BackLink>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <DetailTitle>{problem.title}</DetailTitle>
        {/*
          La priorità con la sua ETICHETTA («Critica»), non col valore grezzo
          («critical»): l'etichetta è dato del cliente e si scrive dal
          Dizionario. Finché non la conosciamo si mostra il valore, che è vero.
        */}
        <Pill bg={priorityStyle.bg} color={priorityStyle.color} radius={4} style={{ fontSize: 'var(--font-size-body)', border: `1px solid ${priorityStyle.accent}` }}>
          {labelOf('priority', problem.priority) ?? problem.priority}
        </Pill>
        {/*
          Lo stato del ticket è il nome di un PASSO, e il suo italiano lo
          scrive l'admin sul passo nel disegnatore: qui si legge da lì. Prima
          questa pastiglia diceva «closed» mentre venti pixel sotto il campo
          «Step workflow» diceva «Chiuso» — stesso stato, stessa pagina, due
          lingue.
        */}
        <Pill bg={STATUS_BG} color={STATUS_FG} radius={4} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
          {labelFor(problem.status)}
        </Pill>
      </div>
      {/* Il NUMERO del ticket, non l'uuid interno: è quello che si cita al telefono. */}
      <div style={{ fontSize: 'var(--font-size-body)', fontFamily: 'var(--font-family)', color: 'var(--text-muted)' }}>{problem.number}</div>

      {manualTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {manualTransitions.map((tr) => (
            <button type="button" key={tr.toStep} onClick={() => onTransitionClick(tr)} disabled={transitioning} style={transitionButtonStyle(stepByName.get(tr.toStep)?.category ?? null, tr.inputField, transitioning)}>
              {tr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
