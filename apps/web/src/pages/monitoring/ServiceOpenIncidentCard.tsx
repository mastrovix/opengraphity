/**
 * «Incident aperto» nel dettaglio del servizio (ondata 3): l'incident non
 * chiuso che il monitoraggio ha aperto per questo servizio
 * (`ServiceMap.openIncident`) — numero, titolo, passo del workflow e link al
 * ticket.
 *
 * Tre stati, tutti detti in chiaro (mai un riquadro vuoto):
 * - c'è un incident → la riga con il link;
 * - `rules.openIncidentFrom = never` → «gli incident per questo servizio sono
 *   disattivati» (non è un silenzio: è una scelta salvata sulla mappa);
 * - altrimenti → «nessun incident aperto».
 * Un incident senza istanza di workflow (ticket vecchi) dichiara «passo non
 * disponibile» invece di fingere un passo.
 *
 * Revisione del 15 set 2026 · SV-4: se il monitoraggio non riesce a portare
 * l'incident nello stato giusto (tipo di CI escluso, matrice incompleta…) il
 * motivo sta qui, in una riga `role="alert"` nella lingua di chi guarda —
 * prima si leggeva solo nel log del worker, e il riquadro diceva «nessun
 * incident aperto» su un servizio giù.
 *
 * Revisione 2 · C-12: stato e passo prendono l'etichetta del workflow del
 * tenant (`useWorkflowSteps('incident')`), non un `humanize()` che in una
 * pagina italiana scriveva «in progress». Se la definizione non si carica o
 * il valore non è un passo del workflow, il valore grezzo si vede lo stesso,
 * con il motivo accanto: mai un'etichetta inventata, mai un silenzio.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, AlertCircle } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { colors, palette } from '@/lib/tokens'
import { TINT_NEUTRAL } from '@/lib/eventPalette'
import { formatDateTime } from '@/lib/datetime'
import { transitionErrorText } from '@/lib/transitionError'
import type { ServiceIncidentProblem, ServiceOpenIncident } from '@/types/services'

const emptyStyle = { margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight } as const

interface Props {
  incident: ServiceOpenIncident | null
  /** `rules.openIncidentFrom` della mappa: `never` = incident disattivati per questo servizio. */
  openIncidentFrom: string
  /** SV-4: perché l'incident non è allineato; null quando va tutto bene. */
  problem: ServiceIncidentProblem | null
}

export function ServiceOpenIncidentCard({ incident, openIncidentFrom, problem }: Props) {
  const { t } = useTranslation()
  const { byName, labelFor, categoryOf, error: stepsError } = useWorkflowSteps('incident')

  /** L'etichetta dell'app per un passo del workflow; fuori definizione → detta in chiaro. */
  const stepLabel = (value: string) =>
    byName.has(value) ? labelFor(value) : t('monitoring.services.health.outOfVocabulary', { value })

  let body
  if (incident) {
    const step = incident.workflowInstance?.currentStep ?? null
    body = (
      <div data-testid="service-open-incident" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
          <AlertCircle size={14} aria-hidden="true" style={{ color: colors.danger, flexShrink: 0 }} />
          <Link
            to={`/incidents/${incident.id}`}
            title={t('monitoring.services.openIncident.open', { number: incident.number })}
            style={{ color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {incident.number}<ArrowRight size={11} aria-hidden="true" />
          </Link>
          <Pill bg={TINT_NEUTRAL.bg} color={TINT_NEUTRAL.color} style={{ fontSize: 'var(--font-size-label)' }}>{stepLabel(incident.status)}</Pill>
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{incident.title}</div>
        <div style={{ fontSize: 'var(--font-size-table)', color: colors.slate }}>
          {step ? t('monitoring.services.openIncident.step', { step: stepLabel(step) }) : t('monitoring.services.openIncident.noStep')}
        </div>
        {/* La definizione del workflow non si è caricata: le etichette sono quelle grezze e si dice perché. */}
        {stepsError && (
          <div role="alert" data-testid="open-incident-steps-error" style={{ fontSize: 'var(--font-size-table)', color: palette.warning.text }}>
            {t('monitoring.services.openIncident.stepsUnavailable', { error: stepsError.message })}
          </div>
        )}
      </div>
    )
  } else if (openIncidentFrom === 'never') {
    body = <p style={emptyStyle}>{t('monitoring.services.openIncident.disabled')}</p>
  } else {
    body = <p style={emptyStyle}>{t('monitoring.services.openIncident.none')}</p>
  }

  return (
    // Secondo giro UI · V-10: un incident risolto ma non ancora chiuso non è «aperto».
    <SectionCard title={incident && categoryOf(incident.workflowInstance?.currentStep ?? incident.status) === 'resolved' ? t('monitoring.services.openIncident.titleResolved') : t('monitoring.services.openIncident.title')} defaultOpen>
      {body}
      {problem && (
        <p role="alert" data-testid="service-incident-problem" style={{ margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)', lineHeight: 1.5 }}>
          {t('monitoring.services.openIncident.problem', {
            reason: transitionErrorText({ error: problem.message, errorKey: problem.key, errorParams: problem.params }, problem.message),
            since: formatDateTime(problem.since),
          })}
        </p>
      )}
    </SectionCard>
  )
}
