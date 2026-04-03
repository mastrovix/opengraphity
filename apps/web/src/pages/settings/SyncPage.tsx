import { useState, useRef } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Plus, Trash2, Play, CheckCircle, XCircle, Clock, AlertTriangle, Database, Cloud, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

// ── GraphQL ───────────────────────────────────────────────────────────────────

const SYNC_SOURCES = gql`
  query SyncSources {
    syncSources {
      id name connectorType enabled scheduleCron
      lastSyncAt lastSyncStatus lastSyncDurationMs
      createdAt
    }
    availableConnectors {
      type displayName supportedCITypes
      credentialFields { name label type required placeholder helpText }
      configFields     { name label type required helpText options { value label } defaultValue }
    }
  }
`

const SYNC_RUNS = gql`
  query SyncRuns($sourceId: ID!, $limit: Int) {
    syncRuns(sourceId: $sourceId, limit: $limit) {
      total
      items {
        id syncType status startedAt completedAt durationMs errorMessage
        ciCreated ciUpdated ciUnchanged ciStale ciConflicts
        relationsCreated relationsRemoved
      }
    }
  }
`

const SYNC_CONFLICTS = gql`
  query SyncConflicts($sourceId: ID, $status: String, $limit: Int) {
    syncConflicts(sourceId: $sourceId, status: $status, limit: $limit) {
      total
      items {
        id externalId ciType conflictFields status resolution
        existingCiId matchReason createdAt resolvedAt
      }
    }
  }
`

const SYNC_STATS = gql`
  query SyncStats {
    syncStats {
      totalSources enabledSources lastSyncAt
      ciManaged openConflicts totalRuns successRate
    }
  }
`

const CREATE_SYNC_SOURCE = gql`
  mutation CreateSyncSource($input: CreateSyncSourceInput!) {
    createSyncSource(input: $input) { id name connectorType enabled }
  }
`

const DELETE_SYNC_SOURCE = gql`
  mutation DeleteSyncSource($id: ID!) { deleteSyncSource(id: $id) }
`

const TRIGGER_SYNC = gql`
  mutation TriggerSync($sourceId: ID!) {
    triggerSync(sourceId: $sourceId) { id status startedAt }
  }
`

const RESOLVE_CONFLICT = gql`
  mutation ResolveConflict($conflictId: ID!, $resolution: String!) {
    resolveConflict(conflictId: $conflictId, resolution: $resolution) {
      id status resolution resolvedAt
    }
  }
`

const TEST_CONNECTION = gql`
  mutation TestSyncConnection($sourceId: ID!) {
    testSyncConnection(sourceId: $sourceId) { ok message details }
  }
`

// ── Types ─────────────────────────────────────────────────────────────────────

interface SyncSource {
  id: string; name: string; connectorType: string; enabled: boolean
  scheduleCron: string | null; lastSyncAt: string | null
  lastSyncStatus: string | null; lastSyncDurationMs: number | null; createdAt: string
}

interface SyncRun {
  id: string; syncType: string; status: string; startedAt: string
  completedAt: string | null; durationMs: number | null; errorMessage: string | null
  ciCreated: number; ciUpdated: number; ciUnchanged: number; ciStale: number
  ciConflicts: number; relationsCreated: number; relationsRemoved: number
}

interface SyncConflict {
  id: string; externalId: string; ciType: string; conflictFields: string
  status: string; resolution: string | null; existingCiId: string
  matchReason: string; createdAt: string; resolvedAt: string | null
}

interface ConnectorField {
  name: string; label: string; type: string; required: boolean
  placeholder: string | null; helpText: string | null
  options: { value: string; label: string }[] | null; defaultValue: string | null
}

interface ConnectorInfo {
  type: string; displayName: string; supportedCITypes: string[]
  credentialFields: ConnectorField[]; configFields: ConnectorField[]
}

interface SyncStats {
  totalSources: number; enabledSources: number; lastSyncAt: string | null
  ciManaged: number; openConflicts: number; totalRuns: number; successRate: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { color: string; icon: React.ReactNode }> = {
    completed: { color: '#16a34a', icon: <CheckCircle size={12} /> },
    running:   { color: '#2563eb', icon: <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> },
    failed:    { color: '#dc2626', icon: <XCircle size={12} /> },
    queued:    { color: '#ca8a04', icon: <Clock size={12} /> },
    open:      { color: '#ca8a04', icon: <AlertTriangle size={12} /> },
    resolved:  { color: '#16a34a', icon: <CheckCircle size={12} /> },
  }
  const c = cfg[status] ?? { color: '#6b7280', icon: null }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.color, fontSize: 12, fontWeight: 500 }}>
      {c.icon}{status}
    </span>
  )
}

// ── TextareaFileField ─────────────────────────────────────────────────────────
// Textarea with Inline / Carica file toggle for csv_content and json_content.

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

// ── Sub-components ────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: SyncStats }) {
  const cards = [
    { label: 'Sources',        value: `${stats.enabledSources}/${stats.totalSources}`, icon: <Database size={16} /> },
    { label: 'CIs managed',   value: stats.ciManaged,    icon: <Cloud size={16} /> },
    { label: 'Open conflicts', value: stats.openConflicts, icon: <AlertTriangle size={16} /> },
    { label: 'Success rate',   value: `${Math.round(stats.successRate * 100)}%`, icon: <CheckCircle size={16} /> },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280', fontSize: 12, marginBottom: 4 }}>
            {c.icon}{c.label}
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function SourcesTab() {
  const { t } = useTranslation()
  const { data, loading } = useQuery(SYNC_SOURCES)
  const [createSource] = useMutation(CREATE_SYNC_SOURCE, { refetchQueries: ['SyncSources', 'SyncStats'] })
  const [deleteSource] = useMutation(DELETE_SYNC_SOURCE, { refetchQueries: ['SyncSources', 'SyncStats'] })
  const [triggerSync]  = useMutation(TRIGGER_SYNC,  { refetchQueries: ['SyncRuns'] })
  const [testConn]     = useMutation(TEST_CONNECTION)

  const [showCreate, setShowCreate] = useState(false)
  const [selectedType, setSelectedType] = useState('')
  const [form, setForm] = useState<Record<string, string>>({})
  const [credForm, setCredForm] = useState<Record<string, string>>({})

  const d = data as { syncSources?: SyncSource[]; availableConnectors?: ConnectorInfo[] } | undefined
  const sources:    SyncSource[]    = d?.syncSources    ?? []
  const connectors: ConnectorInfo[] = d?.availableConnectors ?? []
  const selectedConnector = connectors.find(c => c.type === selectedType)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const config: Record<string, string> = {}
    for (const f of selectedConnector?.configFields ?? []) {
      if (form[f.name]) config[f.name] = form[f.name]!
    }
    try {
      await createSource({
        variables: {
          input: {
            name:          form['name'] ?? selectedType,
            connectorType: selectedType,
            credentials:   JSON.stringify(credForm),
            config:        JSON.stringify(config),
            enabled:       true,
          },
        },
      })
      toast.success(t('pages.sync.sourceCreated'))
      setShowCreate(false)
      setForm({}); setCredForm({}); setSelectedType('')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleTrigger(sourceId: string) {
    try {
      await triggerSync({ variables: { sourceId } })
      toast.success(t('pages.sync.syncTriggered'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleTest(sourceId: string) {
    try {
      const { data: r } = await testConn({ variables: { sourceId } })
      const result = (r as { testSyncConnection?: { ok: boolean; message: string } } | undefined)?.testSyncConnection
      if (result?.ok) toast.success(result.message)
      else            toast.error(result?.message ?? 'Connection failed')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this sync source?')) return
    try {
      await deleteSource({ variables: { id } })
      toast.success('Source deleted')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}
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
              <button onClick={() => handleTest(s.id)}   style={btnStyle('#fff', '#374151')}>Test</button>
              <button onClick={() => handleTrigger(s.id)} style={btnStyle('#2563eb', '#fff')}><Play size={12} />Sync Now</button>
              <button onClick={() => handleDelete(s.id)}  style={btnStyle('#fff', '#dc2626')}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>

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
                <option value="">Select connector…</option>
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

function HistoryTab({ sourceId }: { sourceId?: string }) {
  const { data, loading } = useQuery(SYNC_RUNS, {
    variables: { sourceId: sourceId ?? '', limit: 50 },
    skip:      !sourceId,
  })
  const { data: sources } = useQuery(SYNC_SOURCES)
  const [selected, setSelected] = useState(sourceId ?? '')

  type HistoryData = { syncRuns?: { total: number; items: SyncRun[] } }
  const syncSources: SyncSource[] = (sources as { syncSources?: SyncSource[] } | undefined)?.syncSources ?? []
  const runs:        SyncRun[]    = (data as HistoryData | undefined)?.syncRuns?.items ?? []

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <select style={{ ...inputStyle, width: 240 }} value={selected} onChange={e => setSelected(e.target.value)}>
          <option value="">Select source…</option>
          {syncSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {!selected && (
        <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
          Select a sync source to view run history
        </div>
      )}

      {selected && loading && <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>}

      {selected && !loading && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          {runs.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>No runs yet</div>
          )}
          {runs.map((r, i) => (
            <div key={r.id} style={{ padding: '12px 16px', borderBottom: i < runs.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <StatusBadge status={r.status} />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{r.syncType}</span>
                  <span style={{ fontSize: 12, color: '#374151' }}>{formatDate(r.startedAt)}</span>
                  {r.durationMs != null && <span style={{ fontSize: 12, color: '#6b7280' }}>({formatMs(r.durationMs)})</span>}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', gap: 12 }}>
                  <span style={{ color: '#16a34a' }}>+{r.ciCreated}</span>
                  <span style={{ color: '#2563eb' }}>~{r.ciUpdated}</span>
                  <span>={r.ciUnchanged}</span>
                  {r.ciStale > 0    && <span style={{ color: '#ca8a04' }}>stale:{r.ciStale}</span>}
                  {r.ciConflicts > 0 && <span style={{ color: '#dc2626' }}>conflict:{r.ciConflicts}</span>}
                </div>
              </div>
              {r.errorMessage && (
                <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4, padding: '4px 8px', background: '#fef2f2', borderRadius: 4 }}>
                  {r.errorMessage}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConflictsTab() {
  const { data, loading } = useQuery(SYNC_CONFLICTS, { variables: { limit: 50 } })
  const [resolveConflict] = useMutation(RESOLVE_CONFLICT, { refetchQueries: ['SyncConflicts', 'SyncStats'] })
  const [filter, setFilter] = useState('open')

  const conflicts: SyncConflict[] = (data as { syncConflicts?: { total: number; items: SyncConflict[] } } | undefined)?.syncConflicts?.items ?? []
  const filtered = filter === 'all' ? conflicts : conflicts.filter(c => c.status === filter)

  async function handleResolve(id: string, resolution: string) {
    try {
      await resolveConflict({ variables: { conflictId: id, resolution } })
      toast.success('Conflict resolved')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['open', 'resolved', 'all'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, cursor: 'pointer', background: filter === s ? '#2563eb' : '#fff', color: filter === s ? '#fff' : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {loading && <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>}

      {!loading && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
              {filter === 'open' ? 'No open conflicts' : 'No conflicts found'}
            </div>
          )}
          {filtered.map((c, i) => {
            const fields: string[] = JSON.parse(c.conflictFields || '[]')
            return (
              <div key={c.id} style={{ padding: '12px 16px', borderBottom: i < filtered.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{c.externalId}</span>
                      <span style={{ fontSize: 11, background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{c.ciType}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Locked fields: {fields.join(', ') || '—'} · {formatDate(c.createdAt)}
                    </div>
                    {c.resolution && (
                      <div style={{ fontSize: 12, color: '#16a34a', marginTop: 2 }}>Resolution: {c.resolution}</div>
                    )}
                  </div>
                  {c.status === 'open' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => handleResolve(c.id, 'merged')}   style={btnStyle('#2563eb', '#fff')} title="Aggiorna il CI esistente con i dati importati">Unisci</button>
                      <button onClick={() => handleResolve(c.id, 'distinct')} style={btnStyle('#fff', '#374151')} title="Crea un nuovo CI separato dai dati importati">Sono diversi</button>
                      <button onClick={() => handleResolve(c.id, 'linked')}   style={btnStyle('#fff', '#7c3aed')} title="Crea un nuovo CI e collega entrambi con RELATED_TO">Collega</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', border: '1px solid #d1d5db',
  borderRadius: 6, padding: '6px 10px', fontSize: 13, boxSizing: 'border-box',
  marginBottom: 8, outline: 'none',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4,
}

function btnStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: bg, color, border: `1px solid ${color === '#fff' ? bg : '#e5e7eb'}`,
    borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 500,
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS = ['Sources', 'History', 'Conflicts'] as const
type Tab = typeof TABS[number]

export function SyncPage() {
  const [tab, setTab] = useState<Tab>('Sources')
  const { data: statsData } = useQuery(SYNC_STATS)
  const stats: SyncStats | null = (statsData as { syncStats?: SyncStats } | undefined)?.syncStats ?? null

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>CMDB Sync</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
          Import and sync configuration items from external sources
        </p>
      </div>

      {stats && <StatsBar stats={stats} />}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 20 }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, color: tab === t ? '#2563eb' : '#6b7280',
              borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
              marginBottom: -2,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Sources'   && <SourcesTab />}
      {tab === 'History'   && <HistoryTab />}
      {tab === 'Conflicts' && <ConflictsTab />}
    </div>
  )
}
