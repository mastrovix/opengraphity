/**
 * I campi che policy SLA e contratti OLA/UC hanno in comune da quando sono
 * configurabili fino in fondo (verifica «Cosa resta cablato», ondata 2):
 *
 *  - COME CONTA IL TEMPO: 24×7 oppure uno dei calendari di servizio con nome.
 *    Nessuna scelta preselezionata: prima una policy nasceva «in orario
 *    lavorativo» con l'unico calendario dell'organizzazione;
 *  - L'OBIETTIVO DI CONFORMITÀ e la SOGLIA D'ATTENZIONE, in percentuale, con cui
 *    il report colora il rispetto. Prima 95 e 80 per tutti.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { GET_SERVICE_CALENDARS } from '@/graphql/queries'
import { Input, Select } from '@/components/ui/FormControls'
import { selectS, labelS } from '@/components/ui/styles'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

/** Il valore del selettore per «24×7»: un calendario ha sempre un id, mai questa stringa. */
export const ALWAYS_ON = '24x7'

export interface ServiceCalendarRef { id: string; name: string }

export function useServiceCalendars(): { calendars: ServiceCalendarRef[]; loading: boolean } {
  const { data, loading } = useQuery<{ serviceCalendars: ServiceCalendarRef[] }>(GET_SERVICE_CALENDARS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  return { calendars: data?.serviceCalendars ?? [], loading }
}

/** `''` = nessuna scelta; `ALWAYS_ON` = 24×7; altrimenti l'id del calendario. */
export function calendarChoiceOf(calendarId: string | null | undefined, businessHours: boolean): string {
  if (calendarId) return calendarId
  return businessHours ? '' : ALWAYS_ON
}

/** Il `calendarId` da mandare all'API per una scelta: null per 24×7. */
export function calendarIdFor(choice: string): string | null {
  return choice === ALWAYS_ON ? null : choice
}

export function TimeCountingField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation()
  const { calendars } = useServiceCalendars()
  return (
    <div>
      <label htmlFor={id} style={labelS}>{t('serviceTargets.timeCounting')} *</label>
      <Select id={id} style={selectS} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>{t('serviceTargets.chooseTimeCounting')}</option>
        <option value={ALWAYS_ON}>{t('serviceTargets.alwaysOn')}</option>
        {calendars.map((c) => <option key={c.id} value={c.id}>{t('serviceTargets.calendarOption', { name: c.name })}</option>)}
      </Select>
      <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
        {t('serviceTargets.timeCountingHint')} <Link to="/settings/organization" style={{ color: 'var(--color-brand)' }}>{t('serviceTargets.manageCalendars')}</Link>
      </span>
    </div>
  )
}

export function ComplianceFields({ idPrefix, target, warning, onChange }: {
  idPrefix: string; target: string; warning: string
  onChange: (patch: { complianceTarget?: string; complianceWarning?: string }) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="og-pair">
        <div>
          <label htmlFor={`${idPrefix}-target`} style={labelS}>{t('serviceTargets.complianceTarget')} *</label>
          <Input id={`${idPrefix}-target`} type="number" min={0.1} max={100} step={0.1} value={target} onChange={(e) => onChange({ complianceTarget: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-warning`} style={labelS}>{t('serviceTargets.complianceWarning')} *</label>
          <Input id={`${idPrefix}-warning`} type="number" min={0.1} max={100} step={0.1} value={warning} onChange={(e) => onChange({ complianceWarning: e.target.value })} />
        </div>
      </div>
      <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('serviceTargets.complianceHint')}</span>
    </div>
  )
}

/** Vero quando obiettivo e soglia sono percentuali coerenti (la stessa regola dell'API). */
export function complianceValid(target: string, warning: string): boolean {
  const tg = Number(target)
  const w = Number(warning)
  return target.trim() !== '' && warning.trim() !== '' && tg > 0 && tg <= 100 && w > 0 && w < tg
}
