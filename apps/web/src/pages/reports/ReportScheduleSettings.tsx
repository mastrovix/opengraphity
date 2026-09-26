import { Pill } from '@/components/ui/Pill'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ReportTemplate, type Channel,
  SCHEDULE_PRESETS,
  labelStyle,
} from './useCustomReports'
import { colors, palette } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'

// ── Props ────────────────────────────────────────────────────────────────────

interface ReportScheduleSettingsProps {
  selected: ReportTemplate
  teams: { id: string; name: string }[]
  channels: Channel[]
  /** Teams or channels that could not be read: said, not silently absent (review of 23 Sep 2026). */
  teamsError?: { message: string } | null
  channelsError?: { message: string } | null
  updating: boolean
  /** report.schedule: without it the schedule is shown as it is, and not changed here. */
  canSchedule: boolean
  // Settings form state
  settingsName: string; setSettingsName: (v: string) => void
  settingsDesc: string; setSettingsDesc: (v: string) => void
  settingsVis: string; setSettingsVis: (v: string) => void
  settingsTeamIds: string[]; setSettingsTeamIds: (v: string[] | ((prev: string[]) => string[])) => void
  settingsSched: boolean; setSettingsSched: (v: boolean) => void
  settingsSchedCron: string; setSettingsSchedCron: (v: string) => void
  settingsChanId: string; setSettingsChanId: (v: string) => void
  settingsRecipients: string[]; setSettingsRecipients: (v: string[] | ((prev: string[]) => string[])) => void
  recipientInput: string; setRecipientInput: (v: string) => void
  settingsFormat: 'pdf' | 'excel'; setSettingsFormat: (v: 'pdf' | 'excel') => void
  schedulePreset: string; setSchedulePreset: (v: string) => void
  customCron: string; setCustomCron: (v: string) => void
  // Handlers
  handleSaveSettings: () => void
  setView: (v: 'detail') => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReportScheduleSettings(props: ReportScheduleSettingsProps) {
  const { t } = useTranslation()
  const {
    selected, teams, channels, teamsError = null, channelsError = null, updating, canSchedule,
    settingsName, setSettingsName,
    settingsDesc, setSettingsDesc,
    settingsVis, setSettingsVis,
    settingsTeamIds, setSettingsTeamIds,
    settingsSched, setSettingsSched,
    settingsSchedCron: _settingsSchedCron, setSettingsSchedCron,
    settingsChanId, setSettingsChanId,
    settingsRecipients, setSettingsRecipients,
    recipientInput, setRecipientInput,
    settingsFormat, setSettingsFormat,
    schedulePreset, setSchedulePreset,
    customCron, setCustomCron,
    handleSaveSettings, setView,
  } = props
  const uid = useId()
  const ids = {
    name: `${uid}-name`, desc: `${uid}-desc`, vis: `${uid}-vis`, preset: `${uid}-preset`,
    cron: `${uid}-cron`, channel: `${uid}-channel`, recipients: `${uid}-recipients`,
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <Button variant="secondary" onClick={() => setView('detail')}>&larr; {t('pages.reportSchedule.back')}</Button>
          <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('pages.reportSchedule.title')} &mdash; {selected.name}</h2>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor={ids.name} style={labelStyle}>{t('common.name')}</label>
          <Input id={ids.name} value={settingsName} onChange={e => setSettingsName(e.target.value)} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor={ids.desc} style={labelStyle}>{t('common.description')}</label>
          <Textarea id={ids.desc} value={settingsDesc} onChange={e => setSettingsDesc(e.target.value)} style={{ minHeight: 70, resize: 'vertical' }} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor={ids.vis} style={labelStyle}>{t('pages.reports.visibility.label')}</label>
          <Select id={ids.vis} value={settingsVis} onChange={e => setSettingsVis(e.target.value)}>
            <option value="private">{t('pages.reports.visibility.private')}</option>
            <option value="groups">{t('pages.reports.visibility.selectedGroups')}</option>
            <option value="all">{t('common.all')}</option>
          </Select>
        </div>

        {settingsVis === 'groups' && teamsError && (
          <p role="alert" style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', marginBottom: 14 }}>{t('pages.reportSchedule.teamsError', { message: teamsError.message })}</p>
        )}
        {settingsVis === 'groups' && teams.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={labelStyle}>{t('pages.reportSchedule.shareWithTeams')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {teams.map((team: { id: string; name: string }) => (
                <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={settingsTeamIds.includes(team.id)}
                    onChange={e => setSettingsTeamIds(prev => e.target.checked ? [...prev, team.id] : prev.filter((x: string) => x !== team.id))} />
                  {team.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {!canSchedule && (
          <p role="note" style={{ marginBottom: 20, padding: 16, background: 'var(--color-slate-bg)', borderRadius: 8, border: '1px solid var(--color-border)', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            {selected.scheduleEnabled ? t('pages.reportSchedule.notAllowedOn') : t('pages.reportSchedule.notAllowedOff')}
          </p>
        )}
        {canSchedule && <div style={{ marginBottom: 20, padding: 16, background: 'var(--color-slate-bg)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: settingsSched ? 14 : 0 }}>
            <input type="checkbox" checked={settingsSched} onChange={e => setSettingsSched(e.target.checked)} />
            <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{t('pages.reportSchedule.enable')}</span>
          </label>
          {settingsSched && (
            <>
              <div style={{ marginBottom: 10 }}>
                <label htmlFor={ids.preset} style={labelStyle}>{t('pages.reportSchedule.frequency')}</label>
                <Select
                  id={ids.preset}
                  value={schedulePreset}
                  onChange={e => { setSchedulePreset(e.target.value); if (e.target.value !== '__custom__') setSettingsSchedCron(e.target.value) }}
                >
                  {SCHEDULE_PRESETS.map(p => <option key={p.value} value={p.value}>{t(p.labelKey)}</option>)}
                </Select>
              </div>
              {schedulePreset === '__custom__' && (
                <div style={{ marginBottom: 10 }}>
                  <label htmlFor={ids.cron} style={labelStyle}>{t('pages.reportSchedule.cron')}</label>
                  <Input
                    id={ids.cron}
                    value={customCron}
                    onChange={e => { setCustomCron(e.target.value); setSettingsSchedCron(e.target.value) }}
                    placeholder="0 9 * * *"
                  />
                </div>
              )}
              {channelsError && (
                <p role="alert" style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', marginBottom: 10 }}>
                  {settingsChanId
                    ? t('pages.reportSchedule.channelsErrorKept', { message: channelsError.message })
                    : t('pages.reportSchedule.channelsError', { message: channelsError.message })}
                </p>
              )}
              {channels.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label htmlFor={ids.channel} style={labelStyle}>{t('pages.reportSchedule.slackChannel')}</label>
                  <Select id={ids.channel} value={settingsChanId} onChange={e => setSettingsChanId(e.target.value)}>
                    <option value="">{t('pages.reportSchedule.noChannel')}</option>
                    {channels.map((c: Channel) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
              )}
              {!channelsError && channels.length === 0 && (
                <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 10 }}>
                  {t('pages.reportSchedule.noSlackChannels')}
                </p>
              )}

              {/* Recipients */}
              <div style={{ marginBottom: 10 }}>
                <label htmlFor={ids.recipients} style={labelStyle}>{t('pages.reportSchedule.recipients')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px', border: '1px solid var(--color-border-strong)', borderRadius: 6, background: colors.white, minHeight: 38 }}>
                  {settingsRecipients.map((r) => (
                    <Pill bg={palette.info.tint} color={palette.info.text} radius={12} key={r} style={{ gap: 4, fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
                      {r}
                      <button type="button" aria-label={t('pages.reportSchedule.removeRecipient', { email: r })} onClick={() => setSettingsRecipients(prev => prev.filter(x => x !== r))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: palette.info.text, fontWeight: 600 }}>&times;</button>
                    </Pill>
                  ))}
                  <input
                    id={ids.recipients}
                    value={recipientInput}
                    onChange={e => setRecipientInput(e.target.value)}
                    onKeyDown={e => {
                      if ((e.key === 'Enter' || e.key === ',') && recipientInput.trim()) {
                        e.preventDefault()
                        const email = recipientInput.trim().replace(/,$/, '')
                        if (email && !settingsRecipients.includes(email)) {
                          setSettingsRecipients(prev => [...prev, email])
                        }
                        setRecipientInput('')
                      } else if (e.key === 'Backspace' && !recipientInput && settingsRecipients.length > 0) {
                        setSettingsRecipients(prev => prev.slice(0, -1))
                      }
                    }}
                    placeholder={settingsRecipients.length === 0 ? t('pages.reportSchedule.recipientsPlaceholder') : ''}
                    style={{ flex: 1, minWidth: 160, border: 'none', outline: 'none', fontSize: 'var(--font-size-body)', background: 'transparent' }}
                  />
                </div>
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 3 }}>
                  {t('pages.reportSchedule.recipientsHint')}
                </div>
              </div>

              {/* Format */}
              <div>
                <div style={labelStyle}>{t('pages.reportSchedule.format')}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['pdf', 'excel'] as const).map((fmt) => (
                    <label key={fmt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: `1px solid ${settingsFormat === fmt ? 'var(--color-trigger-manual)' : 'var(--color-border-strong)'}`, background: settingsFormat === fmt ? palette.info.light : colors.white, cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: settingsFormat === fmt ? 600 : 400, color: settingsFormat === fmt ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                      <input type="radio" name="schedFormat" value={fmt} checked={settingsFormat === fmt} onChange={() => setSettingsFormat(fmt)} style={{ margin: 0 }} />
                      {fmt === 'pdf' ? '\uD83D\uDCC4 PDF' : '\uD83D\uDCCA Excel'}
                    </label>
                  ))}
                </div>
              </div>

              {/* Last run */}
              {selected.lastScheduledRun && (
                <div style={{ marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
                  {t('pages.reportSchedule.lastRun', { date: formatDateTime(selected.lastScheduledRun) })}
                </div>
              )}
            </>
          )}
        </div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="primary" onClick={() => handleSaveSettings()} disabled={updating}>
            {updating ? t('pages.reportSchedule.saving') : t('pages.reportSchedule.save')}
          </Button>
          <Button variant="secondary" onClick={() => setView('detail')}>{t('common.cancel')}</Button>
        </div>
      </div>
    </div>
  )
}
