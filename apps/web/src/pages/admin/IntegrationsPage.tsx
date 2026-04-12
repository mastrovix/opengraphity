import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Plug, Plus, Trash2, X, Copy, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  inputS, selectS, labelS, btnPrimary, btnSecondary,
} from '@/pages/settings/shared/designerStyles'

// ── GraphQL ─────────────────────────────────────────────────────────────────

const GET_INBOUND_WEBHOOKS = gql`query($filters: String, $sortField: String, $sortDirection: String) { inboundWebhooks(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name entityType fieldMapping defaultValues transformScript enabled lastReceivedAt receiveCount createdAt } }`
const GET_OUTBOUND_WEBHOOKS = gql`query($filters: String, $sortField: String, $sortDirection: String) { outboundWebhooks(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name url method headers events payloadTemplate enabled lastSentAt lastStatusCode sendCount errorCount lastError retryOnFailure } }`
const GET_API_KEYS = gql`query($filters: String, $sortField: String, $sortDirection: String) { apiKeys(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name keyPrefix permissions rateLimit enabled lastUsedAt requestCount createdBy expiresAt createdAt } }`

const CREATE_INBOUND = gql`mutation($input: CreateInboundWebhookInput!) { createInboundWebhook(input: $input) { id token } }`
const UPDATE_INBOUND = gql`mutation($id: ID!, $input: UpdateInboundWebhookInput!) { updateInboundWebhook(id: $id, input: $input) { id } }`
const DELETE_INBOUND = gql`mutation($id: ID!) { deleteInboundWebhook(id: $id) }`
const REGEN_WEBHOOK_TOKEN = gql`mutation($id: ID!) { regenerateWebhookToken(id: $id) { token } }`

const CREATE_OUTBOUND = gql`mutation($input: CreateOutboundWebhookInput!) { createOutboundWebhook(input: $input) { id } }`
const UPDATE_OUTBOUND = gql`mutation($id: ID!, $input: UpdateOutboundWebhookInput!) { updateOutboundWebhook(id: $id, input: $input) { id } }`
const DELETE_OUTBOUND = gql`mutation($id: ID!) { deleteOutboundWebhook(id: $id) }`
const TEST_OUTBOUND = gql`mutation($id: ID!) { testOutboundWebhook(id: $id) { success statusCode error } }`

const CREATE_API_KEY = gql`mutation($input: CreateApiKeyInput!) { createApiKey(input: $input) { id key } }`
const UPDATE_API_KEY = gql`mutation($id: ID!, $input: UpdateApiKeyInput!) { updateApiKey(id: $id, input: $input) { id } }`
const DELETE_API_KEY = gql`mutation($id: ID!) { deleteApiKey(id: $id) }`
const REGEN_API_KEY = gql`mutation($id: ID!) { regenerateApiKey(id: $id) { key } }`

// ── Constants ───────────────────────────────────────────────────────────────

const TABS = ['Webhook In', 'Webhook Out', 'API Keys'] as const
const ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request', 'ci'] as const
const HTTP_METHODS = ['POST', 'PUT', 'PATCH'] as const
const OUTBOUND_EVENTS = ['incident.created', 'incident.resolved', 'change.approved', 'change.completed', 'problem.created', 'sla.breached'] as const
const PERMISSIONS = ['incidents:read', 'incidents:write', 'changes:read', 'changes:write', 'problems:read', 'problems:write', 'ci:read', 'ci:write', 'kb:read'] as const

const tabS: React.CSSProperties = { padding: '8px 18px', border: 'none', borderBottom: '2px solid transparent', background: 'none', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', cursor: 'pointer' }
const tabActiveS: React.CSSProperties = { ...tabS, color: 'var(--color-brand)', borderBottomColor: 'var(--color-brand)' }
const badgeS: React.CSSProperties = { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 'var(--font-size-table)', background: '#f0f4ff', color: 'var(--color-brand)', marginRight: 4 }
const overlayS: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const modalS: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 24, width: 520, maxHeight: '85vh', overflow: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }
const textareaS: React.CSSProperties = { ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)', resize: 'vertical' as const, minHeight: 70 }
const toggleS = (on: boolean): React.CSSProperties => ({ width: 36, height: 20, borderRadius: 10, background: on ? 'var(--color-brand)' : '#d1d5db', position: 'relative', cursor: 'pointer', border: 'none', transition: 'background .2s' })
const toggleDot = (on: boolean): React.CSSProperties => ({ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .2s' })

function fmtDate(d: string | null) { return d ? new Date(d).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' }
function copyText(t: string) { navigator.clipboard.writeText(t); toast.success('Copiato!') }

// ── Extracted sub-components (MUST be outside the main component to avoid remount on re-render) ─

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button style={toggleS(on)} onClick={onClick}><span style={toggleDot(on)} /></button>
}

const MODAL_TITLES: Record<string, string> = {
  inbound: 'Nuovo Webhook In', outbound: 'Nuovo Webhook Out', apikey: 'Nuova API Key', secret: 'Credenziale generata',
}

function ModalPortal({ modalType, children, onClose }: { modalType: string; children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div style={overlayS} onClick={onClose}>
      <div style={modalS} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {MODAL_TITLES[modalType] ?? ''}
          </span>
          <X size={18} style={{ cursor: 'pointer', color: 'var(--color-slate)' }} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>, document.body)
}

// ── Component ───────────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const [tab, setTab] = useState<typeof TABS[number]>('Webhook In')
  const [modal, setModal] = useState<'inbound' | 'outbound' | 'apikey' | 'secret' | null>(null)
  const [secret, setSecret] = useState('')
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }
  const filtersJson = filterGroup ? JSON.stringify(filterGroup) : null

  const INBOUND_FILTERS: FieldConfig[] = [
    { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
      { value: 'incident', label: 'Incident' }, { value: 'change', label: 'Change' }, { value: 'problem', label: 'Problem' },
    ]},
    { key: 'enabled', label: 'Abilitato', type: 'enum', options: [{ value: 'true', label: 'Sì' }, { value: 'false', label: 'No' }] },
    { key: 'name', label: 'Nome', type: 'text' },
  ]
  const OUTBOUND_FILTERS: FieldConfig[] = [
    { key: 'enabled', label: 'Abilitato', type: 'enum', options: [{ value: 'true', label: 'Sì' }, { value: 'false', label: 'No' }] },
    { key: 'name', label: 'Nome', type: 'text' },
  ]
  const APIKEY_FILTERS: FieldConfig[] = [
    { key: 'enabled', label: 'Abilitato', type: 'enum', options: [{ value: 'true', label: 'Sì' }, { value: 'false', label: 'No' }] },
    { key: 'name', label: 'Nome', type: 'text' },
  ]

  // Queries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inQ = useQuery<any>(GET_INBOUND_WEBHOOKS, { variables: { filters: filtersJson, sortField, sortDirection: sortDir } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outQ = useQuery<any>(GET_OUTBOUND_WEBHOOKS, { variables: { filters: filtersJson, sortField, sortDirection: sortDir } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyQ = useQuery<any>(GET_API_KEYS, { variables: { filters: filtersJson, sortField, sortDirection: sortDir } })

  // Inbound mutations
  const [createIn] = useMutation(CREATE_INBOUND, { refetchQueries: [{ query: GET_INBOUND_WEBHOOKS }] })
  const [updateIn] = useMutation(UPDATE_INBOUND, { refetchQueries: [{ query: GET_INBOUND_WEBHOOKS }] })
  const [deleteIn] = useMutation(DELETE_INBOUND, { refetchQueries: [{ query: GET_INBOUND_WEBHOOKS }] })
  const [regenToken] = useMutation(REGEN_WEBHOOK_TOKEN)

  // Outbound mutations
  const [createOut] = useMutation(CREATE_OUTBOUND, { refetchQueries: [{ query: GET_OUTBOUND_WEBHOOKS }] })
  const [updateOut] = useMutation(UPDATE_OUTBOUND, { refetchQueries: [{ query: GET_OUTBOUND_WEBHOOKS }] })
  const [deleteOut] = useMutation(DELETE_OUTBOUND, { refetchQueries: [{ query: GET_OUTBOUND_WEBHOOKS }] })
  const [testOut] = useMutation(TEST_OUTBOUND)

  // API key mutations
  const [createKey] = useMutation(CREATE_API_KEY, { refetchQueries: [{ query: GET_API_KEYS }] })
  const [updateKey] = useMutation(UPDATE_API_KEY, { refetchQueries: [{ query: GET_API_KEYS }] })
  const [deleteKey] = useMutation(DELETE_API_KEY, { refetchQueries: [{ query: GET_API_KEYS }] })
  const [regenKey] = useMutation(REGEN_API_KEY)

  // ── Form state ──────────────────────────────────────────────────────────────

  const [inForm, setInForm] = useState({ name: '', entityType: 'incident', fieldMapping: '{}', defaultValues: '{}', transformScript: '' })
  const [outForm, setOutForm] = useState({ name: '', url: '', method: 'POST', headers: '{}', events: [] as string[], payloadTemplate: '', secret: '', retryOnFailure: true })
  const [keyForm, setKeyForm] = useState({ name: '', permissions: [] as string[], rateLimit: 1000, expiresAt: '' })

  const resetInForm = () => setInForm({ name: '', entityType: 'incident', fieldMapping: '{}', defaultValues: '{}', transformScript: '' })
  const resetOutForm = () => setOutForm({ name: '', url: '', method: 'POST', headers: '{}', events: [], payloadTemplate: '', secret: '', retryOnFailure: true })
  const resetKeyForm = () => setKeyForm({ name: '', permissions: [], rateLimit: 1000, expiresAt: '' })

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleCreateInbound() {
    try {
      const res = await createIn({ variables: { input: { ...inForm } } })
      setModal(null); resetInForm()
      setSecret((res.data as any)?.createInboundWebhook.token); setModal('secret')
    } catch { toast.error('Errore creazione webhook') }
  }

  async function handleCreateOutbound() {
    try {
      await createOut({ variables: { input: { ...outForm } } })
      setModal(null); resetOutForm(); toast.success('Webhook outbound creato')
    } catch { toast.error('Errore creazione webhook') }
  }

  async function handleCreateApiKey() {
    try {
      const res = await createKey({ variables: { input: { ...keyForm, rateLimit: Number(keyForm.rateLimit) } } })
      setModal(null); resetKeyForm()
      setSecret((res.data as any)?.createApiKey.key); setModal('secret')
    } catch { toast.error('Errore creazione API key') }
  }

  async function handleToggleInbound(id: string, enabled: boolean) {
    try { await updateIn({ variables: { id, input: { enabled: !enabled } } }) } catch { toast.error('Errore aggiornamento') }
  }
  async function handleToggleOutbound(id: string, enabled: boolean) {
    try { await updateOut({ variables: { id, input: { enabled: !enabled } } }) } catch { toast.error('Errore aggiornamento') }
  }
  async function handleToggleKey(id: string, enabled: boolean) {
    try { await updateKey({ variables: { id, input: { enabled: !enabled } } }) } catch { toast.error('Errore aggiornamento') }
  }

  async function handleTestOutbound(id: string) {
    try {
      const res = await testOut({ variables: { id } })
      const r = (res.data as any)?.testOutboundWebhook
      r.success ? toast.success(`Test OK — status ${r.statusCode}`) : toast.error(`Test fallito: ${r.error}`)
    } catch { toast.error('Errore test webhook') }
  }

  async function handleRegenToken(id: string) {
    try {
      const res = await regenToken({ variables: { id } })
      setSecret((res.data as any)?.regenerateWebhookToken.token); setModal('secret')
    } catch { toast.error('Errore rigenerazione token') }
  }

  async function handleRegenApiKey(id: string) {
    try {
      const res = await regenKey({ variables: { id } })
      setSecret((res.data as any)?.regenerateApiKey.key); setModal('secret')
    } catch { toast.error('Errore rigenerazione chiave') }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  const inbounds: any[] = inQ.data?.inboundWebhooks ?? []
  const outbounds: any[] = outQ.data?.outboundWebhooks ?? []
  const apiKeys: any[] = keyQ.data?.apiKeys ?? []

  // Toggle and ModalPortal are defined outside the component to prevent remount on re-render

  // ── Column definitions ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboundColumns: ColumnDef<any>[] = [
    { key: 'name', label: 'Nome', sortable: true },
    { key: 'entityType', label: 'Entity Type', sortable: true, render: (v) => <span style={badgeS}>{String(v)}</span> },
    { key: 'id', label: 'Endpoint URL', sortable: true, render: (v) => (
      <>
        <span style={{ fontSize: 'var(--font-size-body)', fontFamily: 'monospace' }}>/api/webhooks/in/{String(v)}</span>
        <Copy size={12} style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--color-slate)' }} onClick={() => copyText(`/api/webhooks/in/${String(v)}`)} />
      </>
    ) },
    { key: 'enabled', label: 'Attivo', sortable: true, render: (_v, row) => <Toggle on={row.enabled} onClick={() => handleToggleInbound(row.id, row.enabled)} /> },
    { key: 'receiveCount', label: 'Ricevuti', sortable: true, render: (v) => String(v ?? 0) },
    { key: 'lastReceivedAt', label: 'Ultimo', sortable: true, render: (v) => fmtDate(v as string | null) },
    { key: 'createdAt', label: '', render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btnSecondary} title="Rigenera token" onClick={() => handleRegenToken(row.id)}><RefreshCw size={13} /></button>
        <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteIn({ variables: { id: row.id } }) }}><Trash2 size={13} /></button>
      </div>
    ) },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outboundColumns: ColumnDef<any>[] = [
    { key: 'name', label: 'Nome', sortable: true },
    { key: 'url', label: 'URL', sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-body)', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{String(v)}</span> },
    { key: 'events', label: 'Events', sortable: true, render: (v) => {
      const events: string[] = typeof v === 'string' ? JSON.parse(v) : (v as string[] ?? [])
      return <>{events.map(e => <span key={e} style={badgeS}>{e}</span>)}</>
    } },
    { key: 'enabled', label: 'Attivo', sortable: true, render: (_v, row) => <Toggle on={row.enabled} onClick={() => handleToggleOutbound(row.id, row.enabled)} /> },
    { key: 'sendCount', label: 'Invii', sortable: true, render: (v) => String(v ?? 0) },
    { key: 'lastStatusCode', label: 'Ultimo Status', sortable: true, render: (v) => {
      if (!v) return '—'
      const ok = Number(v) >= 200 && Number(v) < 300
      return <span style={{ ...badgeS, background: ok ? '#dcfce7' : '#fee2e2', color: ok ? '#16a34a' : '#dc2626' }}>{String(v)}</span>
    } },
    { key: 'lastError', label: 'Ultimo Errore', sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-table)', color: '#ef4444', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{v ? String(v) : '—'}</span> },
    { key: 'retryOnFailure', label: '', render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btnSecondary} title="Test" onClick={() => handleTestOutbound(row.id)}><Play size={13} /></button>
        <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteOut({ variables: { id: row.id } }) }}><Trash2 size={13} /></button>
      </div>
    ) },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKeyColumns: ColumnDef<any>[] = [
    { key: 'name', label: 'Nome', sortable: true },
    { key: 'keyPrefix', label: 'Prefisso', sortable: true, render: (v) => <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-body)' }}>{String(v)}...</span> },
    { key: 'permissions', label: 'Permessi', sortable: true, render: (v) => {
      const perms: string[] = typeof v === 'string' ? JSON.parse(v) : (v as string[] ?? [])
      return <>{perms.map(p => <span key={p} style={badgeS}>{p}</span>)}</>
    } },
    { key: 'rateLimit', label: 'Rate Limit', sortable: true, render: (v) => `${String(v)}/min` },
    { key: 'enabled', label: 'Attivo', sortable: true, render: (_v, row) => <Toggle on={row.enabled} onClick={() => handleToggleKey(row.id, row.enabled)} /> },
    { key: 'lastUsedAt', label: 'Ultimo uso', sortable: true, render: (v) => fmtDate(v as string | null) },
    { key: 'requestCount', label: 'Richieste', sortable: true, render: (v) => String(v ?? 0) },
    { key: 'createdAt', label: '', render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btnSecondary} title="Rigenera chiave" onClick={() => handleRegenApiKey(row.id)}><RefreshCw size={13} /></button>
        <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteKey({ variables: { id: row.id } }) }}><Trash2 size={13} /></button>
      </div>
    ) },
  ]

  // SecretModal rendered inline below (no text inputs, so no focus issue)

  // ── Checkbox helpers ────────────────────────────────────────────────────────

  const toggleList = (list: string[], val: string) => list.includes(val) ? list.filter(v => v !== val) : [...list, val]

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Plug size={22} color="#38bdf8" />}>Integrazioni</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
          Webhook, API Keys e connessioni esterne
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {TABS.map(t => <button key={t} style={tab === t ? tabActiveS : tabS} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {/* ── TAB: Webhook In ─────────────────────────────────────────────────── */}
      {tab === 'Webhook In' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnPrimary} onClick={() => { resetInForm(); setModal('inbound') }}><Plus size={14} /> Nuovo Webhook In</button>
        </div>
        <FilterBuilder fields={INBOUND_FILTERS} onApply={g => setFilterGroup(g)} />
        <SortableFilterTable<any> onSort={handleSort} sortField={sortField} sortDir={sortDir}
          columns={inboundColumns}
          data={inbounds}
          loading={inQ.loading}
          emptyMessage="Nessun webhook inbound configurato"
          label="Webhook Inbound"
        />

        {modal === 'inbound' && (
          <ModalPortal modalType={modal ?? 'secret'} onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label style={labelS}>Nome</label><input style={inputS} value={inForm.name} onChange={e => setInForm({ ...inForm, name: e.target.value })} /></div>
              <div><label style={labelS}>Entity Type</label>
                <select style={selectS} value={inForm.entityType} onChange={e => setInForm({ ...inForm, entityType: e.target.value })}>
                  {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div><label style={labelS}>Field Mapping (JSON)</label><textarea style={textareaS} value={inForm.fieldMapping} onChange={e => setInForm({ ...inForm, fieldMapping: e.target.value })} /></div>
              <div><label style={labelS}>Default Values (JSON)</label><textarea style={textareaS} value={inForm.defaultValues} onChange={e => setInForm({ ...inForm, defaultValues: e.target.value })} /></div>
              <div><label style={labelS}>Transform Script</label><textarea style={textareaS} value={inForm.transformScript} onChange={e => setInForm({ ...inForm, transformScript: e.target.value })} /></div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button style={btnSecondary} onClick={() => setModal(null)}>Annulla</button>
                <button style={btnPrimary} onClick={handleCreateInbound} disabled={!inForm.name}>Crea</button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* ── TAB: Webhook Out ────────────────────────────────────────────────── */}
      {tab === 'Webhook Out' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnPrimary} onClick={() => { resetOutForm(); setModal('outbound') }}><Plus size={14} /> Nuovo Webhook Out</button>
        </div>
        <FilterBuilder fields={OUTBOUND_FILTERS} onApply={g => setFilterGroup(g)} />
        <SortableFilterTable<any> onSort={handleSort} sortField={sortField} sortDir={sortDir}
          columns={outboundColumns}
          data={outbounds}
          loading={outQ.loading}
          emptyMessage="Nessun webhook outbound configurato"
          label="Webhook Outbound"
        />

        {modal === 'outbound' && (
          <ModalPortal modalType={modal ?? 'secret'} onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label style={labelS}>Nome</label><input style={inputS} value={outForm.name} onChange={e => setOutForm({ ...outForm, name: e.target.value })} /></div>
              <div><label style={labelS}>URL</label><input style={inputS} value={outForm.url} onChange={e => setOutForm({ ...outForm, url: e.target.value })} placeholder="https://..." /></div>
              <div><label style={labelS}>Method</label>
                <select style={selectS} value={outForm.method} onChange={e => setOutForm({ ...outForm, method: e.target.value })}>
                  {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div><label style={labelS}>Headers (JSON)</label><textarea style={textareaS} value={outForm.headers} onChange={e => setOutForm({ ...outForm, headers: e.target.value })} /></div>
              <div>
                <label style={labelS}>Events</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {OUTBOUND_EVENTS.map(ev => (
                    <label key={ev} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={outForm.events.includes(ev)} onChange={() => setOutForm({ ...outForm, events: toggleList(outForm.events, ev) })} />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
              <div><label style={labelS}>Payload Template</label><textarea style={textareaS} value={outForm.payloadTemplate} onChange={e => setOutForm({ ...outForm, payloadTemplate: e.target.value })} /></div>
              <div><label style={labelS}>Secret</label><input style={inputS} value={outForm.secret} onChange={e => setOutForm({ ...outForm, secret: e.target.value })} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                <input type="checkbox" checked={outForm.retryOnFailure} onChange={e => setOutForm({ ...outForm, retryOnFailure: e.target.checked })} />
                Riprova in caso di errore
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button style={btnSecondary} onClick={() => setModal(null)}>Annulla</button>
                <button style={btnPrimary} onClick={handleCreateOutbound} disabled={!outForm.name || !outForm.url}>Crea</button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* ── TAB: API Keys ───────────────────────────────────────────────────── */}
      {tab === 'API Keys' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnPrimary} onClick={() => { resetKeyForm(); setModal('apikey') }}><Plus size={14} /> Nuova API Key</button>
        </div>
        <FilterBuilder fields={APIKEY_FILTERS} onApply={g => setFilterGroup(g)} />
        <SortableFilterTable<any> onSort={handleSort} sortField={sortField} sortDir={sortDir}
          columns={apiKeyColumns}
          data={apiKeys}
          loading={keyQ.loading}
          emptyMessage="Nessuna API key configurata"
          label="API Keys"
        />

        {modal === 'apikey' && (
          <ModalPortal modalType={modal ?? 'secret'} onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label style={labelS}>Nome</label><input style={inputS} value={keyForm.name} onChange={e => setKeyForm({ ...keyForm, name: e.target.value })} /></div>
              <div>
                <label style={labelS}>Permessi</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  {PERMISSIONS.map(p => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={keyForm.permissions.includes(p)} onChange={() => setKeyForm({ ...keyForm, permissions: toggleList(keyForm.permissions, p) })} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <div><label style={labelS}>Rate Limit (req/min)</label><input style={inputS} type="number" value={keyForm.rateLimit} onChange={e => setKeyForm({ ...keyForm, rateLimit: Number(e.target.value) })} /></div>
              <div><label style={labelS}>Scadenza</label><input style={inputS} type="date" value={keyForm.expiresAt} onChange={e => setKeyForm({ ...keyForm, expiresAt: e.target.value })} /></div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button style={btnSecondary} onClick={() => setModal(null)}>Annulla</button>
                <button style={btnPrimary} onClick={handleCreateApiKey} disabled={!keyForm.name || !keyForm.permissions.length}>Crea</button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* Secret reveal modal */}
      {modal === 'secret' && (
        <ModalPortal modalType="secret" onClose={() => { setModal(null); setSecret('') }}>
          <div style={{ background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 'var(--font-size-body)', color: '#92400e' }}>
            Questo token non sarà più visibile. Copialo ora!
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '8px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 'var(--font-size-body)', wordBreak: 'break-all', border: '1px solid #e5e7eb' }}>{secret}</code>
            <button style={btnSecondary} onClick={() => copyText(secret)}><Copy size={14} /> Copia</button>
          </div>
        </ModalPortal>
      )}
    </PageContainer>
  )
}
