import { BackLink, DetailTitle } from '@/components/ui/BackLink'
import { Button } from '@/components/Button'
import { useTranslation } from 'react-i18next'
import { SeverityBadge } from '@/components/SeverityBadge'
import { TicketStatusBadge } from '@/components/StatusBadge'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { transitionButtonColors } from '@/lib/workflowStepStyle'

interface WorkflowTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface WorkflowInstance {
  id:          string
  currentStep: string
  status:      string
}

interface Incident {
  id:                   string
  number:               string
  title:                string
  severity:             string
  status:               string
  workflowInstance:     WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
}

function transitionButtonStyle(category: string | null | undefined, inputField: string | null, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding:      '6px 14px',
    borderRadius: 6,
    fontSize:     13,
    fontWeight:   500,
    cursor:       disabled ? 'not-allowed' : 'pointer',
    opacity:      disabled ? 0.5 : 1,
    border:       '1px solid transparent',
    transition:   'opacity 0.15s',
  }
  // D27: a transition that ends the incident badly is drawn as danger (lib/workflowStepStyle).
  return { ...base, ...transitionButtonColors(category, inputField, 'byCategory') }
}

interface IncidentHeaderProps {
  incident:              Incident
  manualTransitions:     WorkflowTransition[]
  transitioning:         boolean
  onBack:                () => void
  onTransitionClick:     (tr: WorkflowTransition) => void
  /** null: the reader may not open a change (change.write), and it is not offered. */
  onRequestChange:       (() => void) | null
}

export function IncidentHeader({
  incident,
  manualTransitions,
  transitioning,
  onBack,
  onTransitionClick,
  onRequestChange,
}: IncidentHeaderProps) {
  const { t } = useTranslation()
  const { byName: stepByName, isTerminal, categoryOf } = useWorkflowSteps('incident')
  // "Richiedi Change" è un'azione opzionale (non uno step del workflow):
  // disponibile finché l'incident è aperto. «Aperto» lo dicono i METADATA del
  // passo (terminale / categoria `resolved`), non i due nomi di fabbrica
  // (B-22): con la lista di nomi si poteva chiedere una change su un incident
  // fermo in un passo terminale aggiunto dal cliente («Annullato»), e non si
  // poteva più chiederla su un passo di risoluzione rinominato… nel verso
  // sbagliato, cioè sempre.
  const canRequestChange = onRequestChange !== null && !isTerminal(incident.status) && categoryOf(incident.status) !== 'resolved'
  return (
    <div style={{ marginBottom: 24 }}>
      {/* Row 1 — back */}
      <BackLink onClick={onBack}>{t('common.back')}</BackLink>

      {/* Row 2 — number + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <DetailTitle>
          {incident.number}
        </DetailTitle>
        <SeverityBadge value={incident.severity} />
        <TicketStatusBadge value={incident.status} entityType="incident" />
      </div>

      {/* Row 3 — title */}
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
        {incident.title}
      </div>

      {/* Workflow action buttons + azione opzionale "Richiedi Change" */}
      {(manualTransitions.length > 0 || canRequestChange) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {manualTransitions.map((tr) => (
            <button
              type="button"
              key={tr.toStep}
              onClick={() => onTransitionClick(tr)}
              disabled={transitioning}
              style={transitionButtonStyle(stepByName.get(tr.toStep)?.category ?? null, tr.inputField, transitioning)}
            >
              {tr.label}
            </button>
          ))}
          {canRequestChange && (
            <Button variant="secondary"
              onClick={onRequestChange ?? undefined}
            >
              {t('pages.incidents.requestChange')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
