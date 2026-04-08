import {
  type ReportTemplate, type Channel,
  SCHEDULE_PRESETS,
  inputStyle, labelStyle, btnPrimary, btnGhost,
} from './useCustomReports'

// ── Props ────────────────────────────────────────────────────────────────────

interface ReportScheduleSettingsProps {
  selected: ReportTemplate
  teams: { id: string; name: string }[]
  channels: Channel[]
  updating: boolean
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
  const {
    selected, teams, channels, updating,
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

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <button onClick={() => setView('detail')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}>&larr; Indietro</button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Impostazioni &mdash; {selected.name}</h2>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Nome</label>
          <input value={settingsName} onChange={e => setSettingsName(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Descrizione</label>
          <textarea value={settingsDesc} onChange={e => setSettingsDesc(e.target.value)} style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Visibilit&agrave;</label>
          <select value={settingsVis} onChange={e => setSettingsVis(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
            <option value="private">Privato</option>
            <option value="groups">Gruppi selezionati</option>
            <option value="all">Tutti</option>
          </select>
        </div>

        {settingsVis === 'groups' && teams.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Condividi con team</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {teams.map((team: { id: string; name: string }) => (
                <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={settingsTeamIds.includes(team.id)}
                    onChange={e => setSettingsTeamIds(prev => e.target.checked ? [...prev, team.id] : prev.filter((x: string) => x !== team.id))} />
                  {team.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 20, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: settingsSched ? 14 : 0 }}>
            <input type="checkbox" checked={settingsSched} onChange={e => setSettingsSched(e.target.checked)} />
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-slate-dark)' }}>Abilita schedulazione</span>
          </label>
          {settingsSched && (
            <>
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>Frequenza</label>
                <select value={schedulePreset}
                  onChange={e => { setSchedulePreset(e.target.value); if (e.target.value !== '__custom__') setSettingsSchedCron(e.target.value) }}
                  style={{ ...inputStyle, background: '#fff' }}>
                  {SCHEDULE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {schedulePreset === '__custom__' && (
                <div style={{ marginBottom: 10 }}>
                  <label style={labelStyle}>Espressione cron</label>
                  <input value={customCron} onChange={e => { setCustomCron(e.target.value); setSettingsSchedCron(e.target.value) }}
                    style={inputStyle} placeholder="0 9 * * *" />
                </div>
              )}
              {channels.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={labelStyle}>Canale Slack</label>
                  <select value={settingsChanId} onChange={e => setSettingsChanId(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                    <option value="">Nessun canale</option>
                    {channels.map((c: Channel) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              {/* Recipients */}
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>Destinatari email</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', minHeight: 38 }}>
                  {settingsRecipients.map((r) => (
                    <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: '#e0f2fe', color: '#0369a1', fontSize: 12, fontWeight: 500 }}>
                      {r}
                      <button onClick={() => setSettingsRecipients(prev => prev.filter(x => x !== r))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: '#0369a1', fontWeight: 600 }}>&times;</button>
                    </span>
                  ))}
                  <input
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
                    placeholder={settingsRecipients.length === 0 ? 'email@esempio.com, Enter' : ''}
                    style={{ flex: 1, minWidth: 160, border: 'none', outline: 'none', fontSize: 13, background: 'transparent' }}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 3 }}>
                  Premi Invio o virgola per aggiungere. (Email SMTP non ancora implementato &mdash; archiviato per uso futuro.)
                </div>
              </div>

              {/* Format */}
              <div>
                <label style={labelStyle}>Formato report</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['pdf', 'excel'] as const).map((fmt) => (
                    <label key={fmt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: `1px solid ${settingsFormat === fmt ? '#0284c7' : '#d1d5db'}`, background: settingsFormat === fmt ? '#f0f9ff' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: settingsFormat === fmt ? 600 : 400, color: settingsFormat === fmt ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                      <input type="radio" name="schedFormat" value={fmt} checked={settingsFormat === fmt} onChange={() => setSettingsFormat(fmt)} style={{ margin: 0 }} />
                      {fmt === 'pdf' ? '\uD83D\uDCC4 PDF' : '\uD83D\uDCCA Excel'}
                    </label>
                  ))}
                </div>
              </div>

              {/* Last run */}
              {selected.lastScheduledRun && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-slate-light)' }}>
                  Ultima esecuzione: {new Date(selected.lastScheduledRun).toLocaleString('it-IT')}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => void handleSaveSettings()} disabled={updating} style={btnPrimary}>
            {updating ? 'Salvataggio...' : 'Salva impostazioni'}
          </button>
          <button onClick={() => setView('detail')} style={btnGhost}>Annulla</button>
        </div>
      </div>
    </div>
  )
}
