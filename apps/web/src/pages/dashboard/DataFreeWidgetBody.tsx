/**
 * Corpo dei widget «senza dati configurabili» (DATA_FREE_WIDGET_TYPES): la
 * sorgente dei dati è fissa, quindi è il tipo a scegliere il componente —
 * `active_alarms` → console allarmi, `service_health` → Servizi monitorati.
 *
 * Vive qui e non dentro le due schede perché la card reale
 * (CustomWidgetCard) e l'anteprima del pannello di configurazione
 * (WidgetPreview) devono mostrare la stessa cosa: un solo posto da aggiornare
 * quando arriva un tipo nuovo.
 * Un tipo dichiarato data-free ma senza corpo qui è un errore visibile, non
 * un riquadro vuoto.
 */
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'
import { ActiveAlarmsWidget, ACTIVE_ALARMS_WIDGET_TYPE } from './ActiveAlarmsWidget'
import { ServiceHealthWidget, SERVICE_HEALTH_WIDGET_TYPE } from './ServiceHealthWidget'

type BodyProps = { color: string; large?: boolean }

const BODIES: Record<string, (props: BodyProps) => React.ReactElement | null> = {
  [ACTIVE_ALARMS_WIDGET_TYPE]:  ActiveAlarmsWidget,
  [SERVICE_HEALTH_WIDGET_TYPE]: ServiceHealthWidget,
}

export function DataFreeWidgetBody({ widgetType, color, large }: { widgetType: string } & BodyProps) {
  const { t } = useTranslation()
  const Body = BODIES[widgetType]
  if (!Body) {
    return (
      <div role="alert" style={{ padding: 16, fontSize: 'var(--font-size-body)', color: colors.danger }}>
        {t('pages.dashboard.unknownDataFreeWidget', { type: widgetType })}
      </div>
    )
  }
  return <Body color={color} large={large} />
}
