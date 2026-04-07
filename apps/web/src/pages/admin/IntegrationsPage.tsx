import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Plug, Plus, Trash2, X, Copy, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  inputS, selectS, labelS, btnPrimary, btnSecondary,
} from '@/pages/settings/shared/designerStyles'

// ── GraphQL ─────────────────────────────────────────────────────────────────

const GET_INBOUND_WEBHOOKS = gql`query { inboundWebhooks { id name entityType fieldMapping defaultValues transformScript enabled lastReceivedAt receiveCount createdAt } }`
const GET_OUTBOUND_WEBHOOKS = gql`query { outboundWebhooks { id name url method headers events payloadTemplate enabled lastSentAt lastStatusCode sendCount errorCount lastError retryOnFailure } }`
const GET_API_KEYS = gql`query { apiKeys { id name keyPrefix permissions rateLimit enabled lastUsedAt requestCount createdBy expiresAt createdAt } }`

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

const tabS: React.CSSProperties = { padding: '8px 18px', border: 'none', borderBottom: '2px solid transparent', background: 'none', fontSize: 13, fontWeight: 500, color: 'var(--color-slate)', cursor: 'pointer' }
const tabActiveS: React.CSSProperties = { ...tabS, color: 'var(--color-brand)', borderBottomColor: 'var(--color-brand)' }
const thS: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', borderBottom: '1px solid #e5e7eb' }
const tdS: React.CSSProperties = { padding: '8px 12px', fontSize: 13, color: 'var(--color-slate-dark)', borderBottom: '1px solid #f3f4f6' }
const badgeS: React.CSSProperties = { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#f0f4ff', color: 'var(--color-brand)', marginRight: 4 }
const overlayS: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const modalS: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 24, width: 520, maxHeight: '85vh', overflow: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }
const textareaS: React.CSSProperties = { ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12, resize: 'vertical' as const, minHeight: 70 }
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
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
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

  // Queries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inQ = useQuery<any>(GET_INBOUND_WEBHOOKS)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outQ = useQuery<any>(GET_OUTBOUND_WEBHOOKS)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyQ = useQuery<any>(GET_API_KEYS)

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

  // SecretModal rendered inline below (no text inputs, so no focus issue)

  // ── Checkbox helpers ────────────────────────────────────────────────────────

  const toggleList = (list: string[], val: string) => list.includes(val) ? list.filter(v => v !== val) : [...list, val]

  return (
    <PageContainer>
      <PageTitle icon={<Plug size={22} color="var(--color-brand)" />}>Integrazioni</PageTitle>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginTop: 20, marginBottom: 20 }}>
        {TABS.map(t => <button key={t} style={tab === t ? tabActiveS : tabS} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {/* ── TAB: Webhook In ─────────────────────────────────────────────────── */}
      {tab === 'Webhook In' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnPrimary} onClick={() => { resetInForm(); setModal('inbound') }}><Plus size={14} /> Nuovo Webhook In</button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thS}>Nome</th><th style={thS}>Entity Type</th><th style={thS}>Endpoint URL</th>
            <th style={thS}>Attivo</th><th style={thS}>Ricevuti</th><th style={thS}>Ultimo</th><th style={thS}></th>
          </tr></thead>
          <tbody>
            {inbounds.map((w: any) => (
              <tr key={w.id}>
                <td style={tdS}>{w.name}</td>
                <td style={tdS}><span style={badgeS}>{w.entityType}</span></td>
                <td style={tdS}>
                  <span style={{ fontSize: 12, fontFamily: 'monospace' }}>/api/webhooks/in/{w.id}</span>
                  <Copy size={12} style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--color-slate)' }} onClick={() => copyText(`/api/webhooks/in/${w.id}`)} />
                </td>
                <td style={tdS}><Toggle on={w.enabled} onClick={() => handleToggleInbound(w.id, w.enabled)} /></td>
                <td style={tdS}>{w.receiveCount ?? 0}</td>
                <td style={tdS}>{fmtDate(w.lastReceivedAt)}</td>
                <td style={tdS}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btnSecondary} title="Rigenera token" onClick={() => handleRegenToken(w.id)}><RefreshCw size={13} /></button>
                    <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteIn({ variables: { id: w.id } }) }}><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {!inbounds.length && <tr><td style={{ ...tdS, textAlign: 'center', color: 'var(--color-slate)' }} colSpan={7}>Nessun webhook inbound configurato</td></tr>}
          </tbody>
        </table>

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
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thS}>Nome</th><th style={thS}>URL</th><th style={thS}>Events</th>
            <th style={thS}>Attivo</th><th style={thS}>Invii</th><th style={thS}>Ultimo Status</th><th style={thS}>Ultimo Errore</th><th style={thS}></th>
          </tr></thead>
          <tbody>
            {outbounds.map((w: any) => {
              const events: string[] = typeof w.events === 'string' ? JSON.parse(w.events) : (w.events ?? [])
              const ok = w.lastStatusCode && w.lastStatusCode >= 200 && w.lastStatusCode < 300
              return (
                <tr key={w.id}>
                  <td style={tdS}>{w.name}</td>
                  <td style={{ ...tdS, fontSize: 12, fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.url}</td>
                  <td style={tdS}>{events.map(e => <span key={e} style={badgeS}>{e}</span>)}</td>
                  <td style={tdS}><Toggle on={w.enabled} onClick={() => handleToggleOutbound(w.id, w.enabled)} /></td>
                  <td style={tdS}>{w.sendCount ?? 0}</td>
                  <td style={tdS}>{w.lastStatusCode ? <span style={{ ...badgeS, background: ok ? '#dcfce7' : '#fee2e2', color: ok ? '#16a34a' : '#dc2626' }}>{w.lastStatusCode}</span> : '—'}</td>
                  <td style={{ ...tdS, fontSize: 11, color: '#ef4444', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.lastError || '—'}</td>
                  <td style={tdS}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btnSecondary} title="Test" onClick={() => handleTestOutbound(w.id)}><Play size={13} /></button>
                      <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteOut({ variables: { id: w.id } }) }}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!outbounds.length && <tr><td style={{ ...tdS, textAlign: 'center', color: 'var(--color-slate)' }} colSpan={8}>Nessun webhook outbound configurato</td></tr>}
          </tbody>
        </table>

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
                    <label key={ev} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={outForm.events.includes(ev)} onChange={() => setOutForm({ ...outForm, events: toggleList(outForm.events, ev) })} />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
              <div><label style={labelS}>Payload Template</label><textarea style={textareaS} value={outForm.payloadTemplate} onChange={e => setOutForm({ ...outForm, payloadTemplate: e.target.value })} /></div>
              <div><label style={labelS}>Secret</label><input style={inputS} value={outForm.secret} onChange={e => setOutForm({ ...outForm, secret: e.target.value })} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
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
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thS}>Nome</th><th style={thS}>Prefisso</th><th style={thS}>Permessi</th>
            <th style={thS}>Rate Limit</th><th style={thS}>Attivo</th><th style={thS}>Ultimo uso</th><th style={thS}>Richieste</th><th style={thS}></th>
          </tr></thead>
          <tbody>
            {apiKeys.map((k: any) => {
              const perms: string[] = typeof k.permissions === 'string' ? JSON.parse(k.permissions) : (k.permissions ?? [])
              return (
                <tr key={k.id}>
                  <td style={tdS}>{k.name}</td>
                  <td style={{ ...tdS, fontFamily: 'monospace', fontSize: 12 }}>{k.keyPrefix}...</td>
                  <td style={tdS}>{perms.map(p => <span key={p} style={badgeS}>{p}</span>)}</td>
                  <td style={tdS}>{k.rateLimit}/min</td>
                  <td style={tdS}><Toggle on={k.enabled} onClick={() => handleToggleKey(k.id, k.enabled)} /></td>
                  <td style={tdS}>{fmtDate(k.lastUsedAt)}</td>
                  <td style={tdS}>{k.requestCount ?? 0}</td>
                  <td style={tdS}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btnSecondary} title="Rigenera chiave" onClick={() => handleRegenApiKey(k.id)}><RefreshCw size={13} /></button>
                      <button style={{ ...btnSecondary, color: '#ef4444', borderColor: '#fecaca' }} onClick={() => { if (confirm('Eliminare?')) deleteKey({ variables: { id: k.id } }) }}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!apiKeys.length && <tr><td style={{ ...tdS, textAlign: 'center', color: 'var(--color-slate)' }} colSpan={8}>Nessuna API key configurata</td></tr>}
          </tbody>
        </table>

        {modal === 'apikey' && (
          <ModalPortal modalType={modal ?? 'secret'} onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label style={labelS}>Nome</label><input style={inputS} value={keyForm.name} onChange={e => setKeyForm({ ...keyForm, name: e.target.value })} /></div>
              <div>
                <label style={labelS}>Permessi</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  {PERMISSIONS.map(p => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
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
          <div style={{ background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: '#92400e' }}>
            Questo token non sarà più visibile. Copialo ora!
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '8px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 12, wordBreak: 'break-all', border: '1px solid #e5e7eb' }}>{secret}</code>
            <button style={btnSecondary} onClick={() => copyText(secret)}><Copy size={14} /> Copia</button>
          </div>
        </ModalPortal>
      )}
    </PageContainer>
  )
}
