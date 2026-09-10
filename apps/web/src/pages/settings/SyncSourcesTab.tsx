import { useId, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Play, Clock, Upload, X } from 'lucide-react'
import type { SyncSource, ConnectorInfo } from './useSyncPage'
import { formatMs, formatDate, StatusBadge, inputStyle, labelStyle, btnStyle } from './syncShared'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { colors, palette } from '@/lib/tokens'

// ── Constants ────────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every hour',       value: '0 * * * *' },
  { label: 'Every 6 hours',    value: '0 */6 * * *' },
  { label: 'Every 12 hours',   value: '0 */12 * * *' },
  { label: 'Daily at midnight',value: '0 0 * * *' },
  { label: 'Custom…',          value: '__custom__' },
]

// ── TextareaFileField ────────────────────────────────────────────────────────

function acceptForField(fieldName: string): string {
  if (fieldName === 'csv_content') return '.csv,.tsv'
  if (fieldName === 'json_content') return '.json'
  return '*'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

interface TextareaFileFieldProps {
  id?:       string
  fieldName: string
  value:     string
  onChange:  (v: string) => void
  required?: boolean
}

function TextareaFileField({ id, fieldName, value, onChange, required }: TextareaFileFieldProps) {
  const { t } = useTranslation()
  const [mode, setMode]         = useState<'inline' | 'file'>('inline')
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const fileRef                 = useRef<HTMLInputElement>(null)
  const accept                  = acceptForField(fieldName)

  function loadFile(file: File) {
    setFileName(file.name)
    setFileSize(file.size)
    const reader = new FileReader()
    reader.onload = ev => onChange((ev.target?.result as string) ?? '')
    reader.readAsText(file)
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.style.borderColor = palette.neutral.borderStrong
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }

  function handleRemove() {
    setFileName(null)
    setFileSize(null)
    onChange('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function switchMode(m: 'inline' | 'file') {
    setMode(m)
    setFileName(null)
    setFileSize(null)
    onChange('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const toggleBase: React.CSSProperties = {
    padding: '4px 14px', fontSize: 'var(--font-size-body)', border: 'none', cursor: 'pointer', fontWeight: 500,
  }

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: `1px solid ${palette.neutral.borderStrong}`, marginBottom: 8 }}>
        <button type="button" onClick={() => switchMode('inline')}
          style={{ ...toggleBase, background: mode === 'inline' ? colors.brand : colors.white, color: mode === 'inline' ? colors.white : palette.neutral.textMuted, borderRight: `1px solid ${palette.neutral.borderStrong}` }}>
          {t('pages.sync.modeInline')}
        </button>
        <button type="button" onClick={() => switchMode('file')}
          style={{ ...toggleBase, background: mode === 'file' ? colors.brand : colors.white, color: mode === 'file' ? colors.white : palette.neutral.textMuted }}>
          {t('pages.sync.modeFile')}
        </button>
      </div>

      {mode === 'inline' ? (
        <textarea
          id={id}
          style={{ ...inputStyle, height: 140, resize: 'vertical', fontFamily: 'monospace', fontSize: 'var(--font-size-body)' }}
          value={value}
          onChange={e => onChange(e.target.value)}
          required={required}
        />
      ) : (
        <div>
          <input ref={fileRef} type="file" accept={accept} style={{ display: 'none' }} onChange={handleInputChange} />

          {fileName ? (
            <div style={{ border: `1px solid ${palette.neutral.borderStrong}`, borderRadius: 6, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, background: 'var(--color-slate-bg)' }}>
              <div>
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: colors.slateDark }}>{fileName}</div>
                {fileSize != null && <div style={{ fontSize: 'var(--font-size-table)', color: colors.slate, marginTop: 2 }}>{formatBytes(fileSize)}</div>}
              </div>
              <button type="button" onClick={handleRemove}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, border: `1px solid ${palette.danger.borderStrong}`, borderRadius: 6, background: colors.white, color: 'var(--color-trigger-sla-breach)', cursor: 'pointer' }}>
                <X size={12} /> {t('pages.sync.fileRemove')}
              </button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={t('pages.sync.browse')}
              onClick={() => fileRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click() } }}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = colors.brand }}
              onDragLeave={e => { e.currentTarget.style.borderColor = palette.neutral.borderStrong }}
              onDrop={handleDrop}
              style={{ border: `2px dashed ${palette.neutral.borderStrong}`, borderRadius: 8, padding: '28px 16px', textAlign: 'center', cursor: 'pointer', background: 'var(--color-slate-bg)', marginBottom: 8, transition: 'border-color 0.15s' }}
            >
              <Upload size={20} style={{ color: colors.slateLight, margin: '0 auto 8px', display: 'block' }} />
              <div style={{ fontSize: 'var(--font-size-body)', color: palette.neutral.textMuted }}>
                {t('pages.sync.dropHint')} <span style={{ color: colors.brand, textDecoration: 'underline' }}>{t('pages.sync.browse')}</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 4 }}>{accept}</div>
            </div>
          )}
          {/* Invisible required sentinel so browser validation fires when no file selected */}
          {required && (
            <input type="text" value={value} required readOnly tabIndex={-1}
              style={{ opacity: 0, height: 0, padding: 0, border: 'none', position: 'absolute' }} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface SyncSourcesTabProps {
  sources: SyncSource[]
  connectors: ConnectorInfo[]
  loading: boolean
  onCreateSource: (input: {
    name: string; connectorType: string
    credentials: Record<string, string>; config: Record<string, string>
    scheduleCron?: string
  }) => Promise<void>
  onDeleteSource: (id: string) => Promise<void>
  onTriggerSync: (sourceId: string) => Promise<void>
  onTestConnection: (sourceId: string) => Promise<void>
  onSaveSchedule: (sourceId: string, cron: string | null) => Promise<void>
}

// ── Component ────────────────────────────────────────────────────────────────

export function SyncSourcesTab({
  sources, connectors, loading,
  onCreateSource, onDeleteSource, onTriggerSync, onTestConnection, onSaveSchedule,
}: SyncSourcesTabProps) {
  const fid = useId()
  // Local UI state
  const [showCreate,   setShowCreate]   = useState(false)
  const [schedSource,  setSchedSource]  = useState<SyncSource | null>(null)
  const [schedPreset,  setSchedPreset]  = useState('0 */6 * * *')
  const [schedCustom,  setSchedCustom]  = useState('')
  const [selectedType, setSelectedType] = useState('')
  const [form, setForm] = useState<Record<string, string>>({})
  const [credForm, setCredForm] = useState<Record<string, string>>({})

  const selectedConnector = connectors.find(c => c.type === selectedType)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const config: Record<string, string> = {}
    for (const f of selectedConnector?.configFields ?? []) {
      if (form[f.name]) config[f.name] = form[f.name]!
    }
    try {
      await onCreateSource({
        name: form['name'] ?? selectedType,
        connectorType: selectedType,
        credentials: credForm,
        config,
      })
      setShowCreate(false)
      setForm({}); setCredForm({}); setSelectedType('')
    } catch {
      // error already toasted by hook
    }
  }

  function openSchedule(s: SyncSource) {
    const preset = CRON_PRESETS.find(p => p.value === s.scheduleCron && p.value !== '__custom__')
    if (preset) { setSchedPreset(preset.value); setSchedCustom('') }
    else         { setSchedPreset('__custom__'); setSchedCustom(s.scheduleCron ?? '') }
    setSchedSource(s)
  }

  async function handleSaveScheduleLocal() {
    if (!schedSource) return
    const cron = schedPreset === '__custom__' ? schedCustom.trim() : schedPreset
    try {
      await onSaveSchedule(schedSource.id, cron || null)
      setSchedSource(null)
    } catch {
      // error already toasted by hook
    }
  }

  if (loading) return <div style={{ padding: 24, color: colors.slate }}>Loading...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button type="button"
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, backgroundColor: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
        >
          <Plus size={14} />Add Source
        </button>
      </div>

      {/* Sources list */}
      <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {sources.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: colors.slate, fontSize: 'var(--font-size-body)' }}>
            No sync sources configured. Add one to start importing CIs.
          </div>
        )}
        {sources.map((s, i) => (
          <div key={s.id} style={{ padding: '14px 16px', borderBottom: i < sources.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{s.name}</span>
                <span style={{ fontSize: 'var(--font-size-table)', color: colors.slate, background: 'var(--color-border-light)', borderRadius: 4, padding: '2px 6px' }}>{s.connectorType}</span>
                <span style={{ fontSize: 'var(--font-size-table)', color: s.enabled ? 'var(--color-success)' : colors.slate }}>{s.enabled ? 'enabled' : 'disabled'}</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', color: colors.slate, marginTop: 2 }}>
                Last sync: {formatDate(s.lastSyncAt)}
                {s.lastSyncStatus && <> · <StatusBadge status={s.lastSyncStatus} /></>}
                {s.lastSyncDurationMs != null && <> · {formatMs(s.lastSyncDurationMs)}</>}
                {s.scheduleCron && <> · cron: <code style={{ fontSize: 'var(--font-size-table)' }}>{s.scheduleCron}</code></>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => onTestConnection(s.id)}  style={btnStyle(colors.white, palette.neutral.textMuted)}>Test</button>
              <button type="button" onClick={() => openSchedule(s)}         style={btnStyle(colors.white, palette.purple.base)}><Clock size={12} />Schedule</button>
              <button type="button" onClick={() => onTriggerSync(s.id)}     style={btnStyle(colors.brand, colors.white)}><Play size={12} />Sync Now</button>
              <button type="button" onClick={() => onDeleteSource(s.id)}    style={btnStyle(colors.white, 'var(--color-trigger-sla-breach)')}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>

      {/* Schedule modal */}
      {schedSource && (
        <Modal
          open
          onClose={() => setSchedSource(null)}
          title={`Schedule — ${schedSource.name}`}
          width={400}
          footer={
            <>
              <Button variant="secondary" onClick={() => setSchedSource(null)} style={btnStyle(colors.white, palette.neutral.textMuted)}>Cancel</Button>
              <Button onClick={() => void handleSaveScheduleLocal()} style={btnStyle(colors.brand, colors.white)}>Save</Button>
            </>
          }
        >
          <label htmlFor={`${fid}-sched-preset`} style={labelStyle}>Cron preset</label>
          <Select id={`${fid}-sched-preset`} style={inputStyle} value={schedPreset} onChange={e => setSchedPreset(e.target.value)}>
            {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
          {schedPreset === '__custom__' && (
            <>
              <label htmlFor={`${fid}-sched-custom`} style={{ ...labelStyle, marginTop: 8 }}>Custom cron expression</label>
              <Input id={`${fid}-sched-custom`} style={inputStyle} value={schedCustom} onChange={e => setSchedCustom(e.target.value)} placeholder="e.g. 0 */4 * * *" />
            </>
          )}
        </Modal>
      )}

      {/* Create modal */}
      {showCreate && (
        <Modal
          open
          onClose={() => setShowCreate(false)}
          title="Add Sync Source"
          width={520}
          as="form"
          onSubmit={(e) => void handleCreate(e)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowCreate(false)} style={btnStyle(colors.white, palette.neutral.textMuted)}>Cancel</Button>
              <Button type="submit" style={btnStyle(colors.brand, colors.white)}>Create Source</Button>
            </>
          }
        >
              <label htmlFor={`${fid}-name`} style={labelStyle}>Name</label>
              <Input id={`${fid}-name`} style={inputStyle} value={form['name'] ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />

              <label htmlFor={`${fid}-connector`} style={labelStyle}>Connector Type</label>
              <Select id={`${fid}-connector`} style={inputStyle} value={selectedType} onChange={e => { setSelectedType(e.target.value); setForm({}); setCredForm({}) }} required>
                <option value="">Select connector...</option>
                {connectors.map(c => <option key={c.type} value={c.type}>{c.displayName}</option>)}
              </Select>

              {selectedConnector && (
                <>
                  {selectedConnector.credentialFields.length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', margin: '16px 0 8px', color: palette.neutral.textMuted }}>Credentials</div>
                      {selectedConnector.credentialFields.map(f => (
                        <div key={f.name}>
                          <label htmlFor={`${fid}-cred-${f.name}`} style={labelStyle}>{f.label}{f.required && <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>}</label>
                          <Input
                            id={`${fid}-cred-${f.name}`}
                            style={inputStyle}
                            type={f.type === 'password' ? 'password' : 'text'}
                            placeholder={f.placeholder ?? ''}
                            value={credForm[f.name] ?? ''}
                            onChange={e => setCredForm(c => ({ ...c, [f.name]: e.target.value }))}
                            required={f.required}
                          />
                          {f.helpText && <p style={{ fontSize: 'var(--font-size-table)', color: colors.slate, margin: '2px 0 6px' }}>{f.helpText}</p>}
                        </div>
                      ))}
                    </>
                  )}
                  {selectedConnector.configFields.length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', margin: '16px 0 8px', color: palette.neutral.textMuted }}>Configuration</div>
                      {selectedConnector.configFields.map(f => (
                        <div key={f.name}>
                          <label htmlFor={`${fid}-cfg-${f.name}`} style={labelStyle}>{f.label}{f.required && <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>}</label>
                          {f.options ? (
                            <Select id={`${fid}-cfg-${f.name}`} style={inputStyle} value={form[f.name] ?? f.defaultValue ?? ''} onChange={e => setForm(c => ({ ...c, [f.name]: e.target.value }))}>
                              {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </Select>
                          ) : f.type === 'textarea' ? (
                            <TextareaFileField
                              id={`${fid}-cfg-${f.name}`}
                              fieldName={f.name}
                              value={form[f.name] ?? ''}
                              onChange={v => setForm(c => ({ ...c, [f.name]: v }))}
                              required={f.required}
                            />
                          ) : (
                            <Input
                              id={`${fid}-cfg-${f.name}`}
                              style={inputStyle}
                              value={form[f.name] ?? f.defaultValue ?? ''}
                              onChange={e => setForm(c => ({ ...c, [f.name]: e.target.value }))}
                              required={f.required}
                            />
                          )}
                          {f.helpText && <p style={{ fontSize: 'var(--font-size-table)', color: colors.slate, margin: '2px 0 6px' }}>{f.helpText}</p>}
                        </div>
                      ))}
                    </>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <label htmlFor={`${fid}-schedule`} style={labelStyle}>Schedule (cron, optional)</label>
                    <Input id={`${fid}-schedule`} style={inputStyle} placeholder="0 */6 * * * (every 6h)" value={form['scheduleCron'] ?? ''} onChange={e => setForm(c => ({ ...c, scheduleCron: e.target.value }))} />
                  </div>
                </>
              )}
        </Modal>
      )}
    </div>
  )
}
