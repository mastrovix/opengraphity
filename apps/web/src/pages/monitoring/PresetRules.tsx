/**
 * Regole dei connettori preset (Alertmanager, Grafana, Zabbix, Datadog,
 * Dynatrace) nella procedura guidata (passo "Nome e regole") e nella pagina
 * di modifica (A1 della revisione). Due sezioni:
 *   - "Traduzione dei valori": severità e stato che lo strumento manda con
 *     parole sue (Prometheus `page`, Zabbix `Average`, Datadog `Muted`) →
 *     vocabolario OpenGrafo, PRIMA della tabella incorporata del connettore;
 *   - "Risorsa predefinita": nome e tipo da usare quando l'allarme non porta
 *     una risorsa (alert su metriche aggregate, Watchdog, monitor su log/APM);
 *     per Datadog anche "usa alert_scope";
 *   - "Severità da usare quando manca" (default_values.severity, D·2.3):
 *     nelle parole dello strumento, tradotta dall'API come un valore ricevuto.
 * Nessun JSON è visibile: lo compone buildPresetConfig (sourceConfig.ts).
 * Senza regole l'API scarta l'allarme e lo scrive in lastError: qui si
 * spiega, non si inventa un default.
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { EVENT_SEVERITIES, EVENT_INPUT_STATUSES, RESOURCE_KINDS, type EventSeverity, type EventInputStatus, type ResourceKind } from '@/types/events'
import { ValueTable } from './GenericMapper'
import { RESOURCE_FROM_OPTIONS, type PresetConnectorKind, type PresetRules } from './sourceConfig'
import { hintStyle, sectionTitleStyle } from './monitoringShared'

interface Props {
  kind:     PresetConnectorKind
  rules:    PresetRules
  onChange: (r: PresetRules) => void
}

export function PresetRulesEditor({ kind, rules, onChange }: Props) {
  const { t } = useTranslation()
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const hasResourceFrom = RESOURCE_FROM_OPTIONS[kind] !== undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h3 style={sectionTitleStyle}>{t('monitoring.preset.valuesTitle')}</h3>
        <p style={hintStyle}>{t('monitoring.preset.valuesIntro')}</p>
        <p style={{ ...hintStyle, marginTop: 4 }}>{t(`monitoring.preset.hints.${kind}`)}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10 }}>
          <ValueTable<EventSeverity>
            title={t('monitoring.preset.severityValues')}
            hint={t('monitoring.preset.severityHint')}
            table={rules.severityValues}
            targets={EVENT_SEVERITIES}
            targetLabel={(v) => t(`events.severity.${v}`)}
            onChange={(severityValues) => onChange({ ...rules, severityValues })}
            idPrefix={fid('sev')}
          />
          <ValueTable<EventInputStatus>
            title={t('monitoring.preset.statusValues')}
            hint={t('monitoring.preset.statusHint')}
            table={rules.statusValues}
            targets={EVENT_INPUT_STATUSES}
            targetLabel={(v) => t(`events.status.${v}`)}
            onChange={(statusValues) => onChange({ ...rules, statusValues })}
            idPrefix={fid('st')}
          />
        </div>
        <div style={{ maxWidth: 560, marginTop: 12 }}>
          <FieldLabel htmlFor={fid('defaultSeverity')}>{t('monitoring.preset.defaultSeverityLabel')}</FieldLabel>
          <Input id={fid('defaultSeverity')} value={rules.defaultSeverity} onChange={(e) => onChange({ ...rules, defaultSeverity: e.target.value })} placeholder={t('monitoring.preset.defaultSeverityPlaceholder')} />
          <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.preset.defaultSeverityHint')}</p>
        </div>
      </div>

      <div>
        <h3 style={sectionTitleStyle}>{t('monitoring.preset.resourceTitle')}</h3>
        <p style={hintStyle}>{t('monitoring.preset.resourceIntro')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(160px, 1fr)', gap: 12, alignItems: 'start', marginTop: 10, maxWidth: 560 }}>
          <div>
            <FieldLabel htmlFor={fid('resource')}>{t('monitoring.preset.resourceLabel')}</FieldLabel>
            <Input id={fid('resource')} value={rules.defaultResource} onChange={(e) => onChange({ ...rules, defaultResource: e.target.value })} placeholder={t('monitoring.preset.resourcePlaceholder')} />
            <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.preset.resourceHint')}</p>
          </div>
          <div>
            <FieldLabel htmlFor={fid('resourceKind')}>{t('monitoring.preset.resourceKindLabel')}</FieldLabel>
            <Select id={fid('resourceKind')} value={rules.defaultResourceKind} onChange={(e) => onChange({ ...rules, defaultResourceKind: e.target.value as ResourceKind })} disabled={!rules.defaultResource.trim()} title={t('monitoring.mapper.resourceKindHint')}>
              {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{t(`monitoring.mapper.resourceKinds.${k}`)}</option>)}
            </Select>
          </div>
        </div>
        {hasResourceFrom && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 'var(--font-size-body)', cursor: 'pointer', maxWidth: 560 }}>
            <input type="checkbox" checked={rules.resourceFromAlertScope} onChange={(e) => onChange({ ...rules, resourceFromAlertScope: e.target.checked })} style={{ marginTop: 3 }} />
            <span>
              {t('monitoring.preset.resourceFromAlertScope')}
              <span style={{ ...hintStyle, display: 'block' }}>{t('monitoring.preset.resourceFromAlertScopeHint')}</span>
            </span>
          </label>
        )}
      </div>
    </div>
  )
}
