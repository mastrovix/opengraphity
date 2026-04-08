import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Play, Clock, Upload, X } from 'lucide-react'
import type { SyncSource, ConnectorInfo } from './useSyncPage'
import { formatMs, formatDate, StatusBadge, inputStyle, labelStyle, btnStyle } from './syncShared'

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
  fieldName: string
  value:     string
  onChange:  (v: string) => void
  required?: boolean
}

function TextareaFileField({ fieldName, value, onChange, required }: TextareaFileFieldProps) {
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
    e.currentTarget.style.borderColor = '#d1d5db'
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
    padding: '4px 14px', fontSize: 12, border: 'none', cursor: 'pointer', fontWeight: 500,
  }

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db', marginBottom: 8 }}>
        <button type="button" onClick={() => switchMode('inline')}
          style={{ ...toggleBase, background: mode === 'inline' ? '#2563eb' : '#fff', color: mode === 'inline' ? '#fff' : '#374151', borderRight: '1px solid #d1d5db' }}>
          {t('pages.sync.modeInline')}
        </button>
        <button type="button" onClick={() => switchMode('file')}
          style={{ ...toggleBase, background: mode === 'file' ? '#2563eb' : '#fff', color: mode === 'file' ? '#fff' : '#374151' }}>
          {t('pages.sync.modeFile')}
        </button>
      </div>

      {mode === 'inline' ? (
        <textarea
          style={{ ...inputStyle, height: 140, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
          value={value}
          onChange={e => onChange(e.target.value)}
          required={required}
        />
      ) : (
        <div>
          <input ref={fileRef} type="file" accept={accept} style={{ display: 'none' }} onChange={handleInputChange} />

          {fileName ? (
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, background: '#f9fafb' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{fileName}</div>
                {fileSize != null && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{formatBytes(fileSize)}</div>}
              </div>
              <button type="button" onClick={handleRemove}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, border: '1px solid #fca5a5', borderRadius: 6, background: '#fff', color: '#dc2626', cursor: 'pointer' }}>
                <X size={12} /> {t('pages.sync.fileRemove')}
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#2563eb' }}
              onDragLeave={e => { e.currentTarget.style.borderColor = '#d1d5db' }}
              onDrop={handleDrop}
              style={{ border: '2px dashed #d1d5db', borderRadius: 8, padding: '28px 16px', textAlign: 'center', cursor: 'pointer', background: '#f9fafb', marginBottom: 8, transition: 'border-color 0.15s' }}
            >
              <Upload size={20} style={{ color: '#9ca3af', margin: '0 auto 8px', display: 'block' }} />
              <div style={{ fontSize: 13, color: '#374151' }}>
                {t('pages.sync.dropHint')} <span style={{ color: '#2563eb', textDecoration: 'underline' }}>{t('pages.sync.browse')}</span>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{accept}</div>
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

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
        >
          <Plus size={14} />Add Source
        </button>
      </div>

      {/* Sources list */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        {sources.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
            No sync sources configured. Add one to start importing CIs.
          </div>
        )}
        {sources.map((s, i) => (
          <div key={s.id} style={{ padding: '14px 16px', borderBottom: i < sources.length - 1 ? '1px solid #f3f4f6' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{s.name}</span>
                <span style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', borderRadius: 4, padding: '2px 6px' }}>{s.connectorType}</span>
                <span style={{ fontSize: 11, color: s.enabled ? '#16a34a' : '#6b7280' }}>{s.enabled ? 'enabled' : 'disabled'}</span>
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                Last sync: {formatDate(s.lastSyncAt)}
                {s.lastSyncStatus && <> · <StatusBadge status={s.lastSyncStatus} /></>}
                {s.lastSyncDurationMs != null && <> · {formatMs(s.lastSyncDurationMs)}</>}
                {s.scheduleCron && <> · cron: <code style={{ fontSize: 11 }}>{s.scheduleCron}</code></>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => onTestConnection(s.id)}  style={btnStyle('#fff', '#374151')}>Test</button>
              <button onClick={() => openSchedule(s)}         style={btnStyle('#fff', '#7c3aed')}><Clock size={12} />Schedule</button>
              <button onClick={() => onTriggerSync(s.id)}     style={btnStyle('#2563eb', '#fff')}><Play size={12} />Sync Now</button>
              <button onClick={() => onDeleteSource(s.id)}    style={btnStyle('#fff', '#dc2626')}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>

      {/* Schedule modal */}
      {schedSource && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 400 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Schedule — {schedSource.name}</h3>
              <button onClick={() => setSchedSource(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
            </div>
            <label style={labelStyle}>Cron preset</label>
            <select style={inputStyle} value={schedPreset} onChange={e => setSchedPreset(e.target.value)}>
              {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            {schedPreset === '__custom__' && (
              <>
                <label style={{ ...labelStyle, marginTop: 8 }}>Custom cron expression</label>
                <input style={inputStyle} value={schedCustom} onChange={e => setSchedCustom(e.target.value)} placeholder="e.g. 0 */4 * * *" />
              </>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setSchedSource(null)} style={{ ...btnStyle('#fff', '#374151') }}>Cancel</button>
              <button onClick={() => void handleSaveScheduleLocal()} style={{ ...btnStyle('#2563eb', '#fff') }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 520, maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700 }}>Add Sync Source</h3>
            <form onSubmit={handleCreate}>
              <label style={labelStyle}>Name</label>
              <input style={inputStyle} value={form['name'] ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />

              <label style={labelStyle}>Connector Type</label>
              <select style={inputStyle} value={selectedType} onChange={e => { setSelectedType(e.target.value); setForm({}); setCredForm({}) }} required>
                <option value="">Select connector...</option>
                {connectors.map(c => <option key={c.type} value={c.type}>{c.displayName}</option>)}
              </select>

              {selectedConnector && (
                <>
                  {selectedConnector.credentialFields.length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 13, margin: '16px 0 8px', color: '#374151' }}>Credentials</div>
                      {selectedConnector.credentialFields.map(f => (
                        <div key={f.name}>
                          <label style={labelStyle}>{f.label}{f.required && <span style={{ color: '#dc2626' }}>*</span>}</label>
                          <input
                            style={inputStyle}
                            type={f.type === 'password' ? 'password' : 'text'}
                            placeholder={f.placeholder ?? ''}
                            value={credForm[f.name] ?? ''}
                            onChange={e => setCredForm(c => ({ ...c, [f.name]: e.target.value }))}
                            required={f.required}
                          />
                          {f.helpText && <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 6px' }}>{f.helpText}</p>}
                        </div>
                      ))}
                    </>
                  )}
                  {selectedConnector.configFields.length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 13, margin: '16px 0 8px', color: '#374151' }}>Configuration</div>
                      {selectedConnector.configFields.map(f => (
                        <div key={f.name}>
                          <label style={labelStyle}>{f.label}{f.required && <span style={{ color: '#dc2626' }}>*</span>}</label>
                          {f.options ? (
                            <select style={inputStyle} value={form[f.name] ?? f.defaultValue ?? ''} onChange={e => setForm(c => ({ ...c, [f.name]: e.target.value }))}>
                              {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          ) : f.type === 'textarea' ? (
                            <TextareaFileField
                              fieldName={f.name}
                              value={form[f.name] ?? ''}
                              onChange={v => setForm(c => ({ ...c, [f.name]: v }))}
                              required={f.required}
                            />
                          ) : (
                            <input
                              style={inputStyle}
                              value={form[f.name] ?? f.defaultValue ?? ''}
                              onChange={e => setForm(c => ({ ...c, [f.name]: e.target.value }))}
                              required={f.required}
                            />
                          )}
                          {f.helpText && <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 6px' }}>{f.helpText}</p>}
                        </div>
                      ))}
                    </>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <label style={labelStyle}>Schedule (cron, optional)</label>
                    <input style={inputStyle} placeholder="0 */6 * * * (every 6h)" value={form['scheduleCron'] ?? ''} onChange={e => setForm(c => ({ ...c, scheduleCron: e.target.value }))} />
                  </div>
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                <button type="button" onClick={() => setShowCreate(false)} style={btnStyle('#fff', '#374151')}>Cancel</button>
                <button type="submit" style={btnStyle('#2563eb', '#fff')}>Create Source</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
