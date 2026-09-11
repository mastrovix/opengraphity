/**
 * Integrazioni (admin): webhook in ingresso, webhook in uscita, API key.
 * Le sorgenti di monitoraggio (entityType = event) compaiono nell'elenco dei
 * webhook in ingresso ma si gestiscono da Monitoraggio → Sorgenti: qui hanno
 * solo il link "Gestisci in Monitoraggio", senza URL copiabile (D·1.4).
 * L'endpoint mostrato è quello reale (`sourceEndpointUrl`, rotta
 * `/api/webhooks/inbound/:id`); etichette e messaggi in i18n (D·6.4).
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n/i18n'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Plug, Plus, Trash2, Copy, Play, RefreshCw } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { toast } from 'sonner'
import { inputS, selectS, labelS, textareaS as sharedTextareaS } from '@/components/ui/styles'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Toggle } from '@/components/ui/Toggle'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { useMutationWithToast, errorMessage } from '@/hooks/useMutationWithToast'
import { useListQueryState } from '@/hooks/useListQueryState'
import { useConfirm } from '@/hooks/useConfirm'
import { sourceEndpointUrl } from '@/pages/monitoring/configSnippets'
import { palette } from '@/lib/tokens'

// ── GraphQL ─────────────────────────────────────────────────────────────────
// Every operation is named: `operationName` shows up in the errorLink logs and
// the API logs instead of `undefined` (E-06). Exported for the page test.

export const GET_INBOUND_WEBHOOKS = gql`query InboundWebhooks($filters: String, $sortField: String, $sortDirection: String) { inboundWebhooks(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name entityType connectorKind fieldMapping defaultValues transformScript enabled lastReceivedAt receiveCount createdAt } }`
export const GET_OUTBOUND_WEBHOOKS = gql`query OutboundWebhooks($filters: String, $sortField: String, $sortDirection: String) { outboundWebhooks(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name url method headers events payloadTemplate enabled lastSentAt lastStatusCode sendCount errorCount lastError retryOnFailure } }`
export const GET_API_KEYS = gql`query ApiKeys($filters: String, $sortField: String, $sortDirection: String) { apiKeys(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name keyPrefix permissions rateLimit enabled lastUsedAt requestCount createdBy expiresAt createdAt } }`

// ── Row types (mirror of the GraphQL selections above) ─────────────────────
interface InboundWebhook  { id: string; name: string; entityType: string; connectorKind: string | null; fieldMapping: string; defaultValues: string; transformScript: string | null; enabled: boolean; lastReceivedAt: string | null; receiveCount: number; createdAt: string }
interface OutboundWebhook { id: string; name: string; url: string; method: string; headers: string; events: string[] | string; payloadTemplate: string | null; enabled: boolean; lastSentAt: string | null; lastStatusCode: number | null; sendCount: number; errorCount: number; lastError: string | null; retryOnFailure: boolean }
interface ApiKeyRow       { id: string; name: string; keyPrefix: string; permissions: string[] | string; rateLimit: number; enabled: boolean; lastUsedAt: string | null; requestCount: number; createdBy: string | null; expiresAt: string | null; createdAt: string }

const CREATE_INBOUND = gql`mutation CreateInboundWebhook($input: CreateInboundWebhookInput!) { createInboundWebhook(input: $input) { id token } }`
const UPDATE_INBOUND = gql`mutation UpdateInboundWebhook($id: ID!, $input: UpdateInboundWebhookInput!) { updateInboundWebhook(id: $id, input: $input) { id } }`
const DELETE_INBOUND = gql`mutation DeleteInboundWebhook($id: ID!) { deleteInboundWebhook(id: $id) { deleted resolvedEvents affectedCIs } }`
const REGEN_WEBHOOK_TOKEN = gql`mutation RegenerateWebhookToken($id: ID!) { regenerateWebhookToken(id: $id) { token } }`

const CREATE_OUTBOUND = gql`mutation CreateOutboundWebhook($input: CreateOutboundWebhookInput!) { createOutboundWebhook(input: $input) { id } }`
const UPDATE_OUTBOUND = gql`mutation UpdateOutboundWebhook($id: ID!, $input: UpdateOutboundWebhookInput!) { updateOutboundWebhook(id: $id, input: $input) { id } }`
const DELETE_OUTBOUND = gql`mutation DeleteOutboundWebhook($id: ID!) { deleteOutboundWebhook(id: $id) }`
const TEST_OUTBOUND = gql`mutation TestOutboundWebhook($id: ID!) { testOutboundWebhook(id: $id) { success statusCode error } }`

const CREATE_API_KEY = gql`mutation CreateApiKey($input: CreateApiKeyInput!) { createApiKey(input: $input) { id key } }`
const UPDATE_API_KEY = gql`mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) { updateApiKey(id: $id, input: $input) { id } }`
const DELETE_API_KEY = gql`mutation DeleteApiKey($id: ID!) { deleteApiKey(id: $id) }`
const REGEN_API_KEY = gql`mutation RegenerateApiKey($id: ID!) { regenerateApiKey(id: $id) { key } }`

// ── Constants ───────────────────────────────────────────────────────────────

type TabKey = 'inbound' | 'outbound' | 'apikeys'
type ModalKey = 'inbound' | 'outbound' | 'apikey' | 'secret'
// `event` NON è tra le opzioni: le sorgenti di monitoraggio si creano dalla
// procedura guidata di Monitoraggio → Sorgenti (senza JSON); qui restano
// visibili in elenco con il link "gestisci in Monitoraggio".
const ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request', 'ci'] as const
const HTTP_METHODS = ['POST', 'PUT', 'PATCH'] as const
const OUTBOUND_EVENTS = ['incident.created', 'incident.resolved', 'change.approved', 'change.completed', 'problem.created', 'sla.breached'] as const
const PERMISSIONS = ['incidents:read', 'incidents:write', 'changes:read', 'changes:write', 'problems:read', 'problems:write', 'ci:read', 'ci:write', 'kb:read'] as const

const textareaS: React.CSSProperties = { ...sharedTextareaS, minHeight: 70 }
// Pill overrides: these badges are regular-weight with a small right gap.
const PILL_S: React.CSSProperties = { fontWeight: 400, marginRight: 4 }
const ROW_ACTIONS: React.CSSProperties = { display: 'flex', gap: 6 }

function fmtDate(d: string | null) { return d ? new Date(d).toLocaleString(i18n.language, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' }
function copyText(text: string) { void navigator.clipboard.writeText(text); toast.success(i18n.t('toast.integration.copied')) }

/** Chiave i18n del titolo di ogni modale. */
const MODAL_TITLE_KEYS: Record<ModalKey, string> = {
  inbound: 'admin.integrations.newInbound', outbound: 'admin.integrations.newOutbound', apikey: 'admin.integrations.newApiKey', secret: 'admin.integrations.secretTitle',
}

// Defined outside the page component so it is not remounted on every re-render.
function ModalPortal({ modalType, children, onClose }: { modalType: ModalKey; children: React.ReactNode; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal open onClose={onClose} title={t(MODAL_TITLE_KEYS[modalType])} width={520} closeOnOverlay={false}>
      {children}
    </Modal>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [tab, setTab] = useState<TabKey>('inbound')
  const [modal, setModal] = useState<ModalKey | null>(null)
  const [secret, setSecret] = useState('')
  // Each tab owns its own sort/filter: an `entityType` filter set on "Webhook In"
  // must not silently narrow "API Keys" (E-06 d).
  const inList  = useListQueryState()
  const outList = useListQueryState()
  const keyList = useListQueryState()
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`

  const TABS: TabItem<TabKey>[] = [
    { key: 'inbound',  label: t('admin.integrations.webhookIn') },
    { key: 'outbound', label: t('admin.integrations.webhookOut') },
    { key: 'apikeys',  label: t('admin.integrations.apiKeys') },
  ]

  const yesNo = [{ value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }]
  const INBOUND_FILTERS: FieldConfig[] = [
    { key: 'entityType', label: t('admin.integrations.filters.entityType'), type: 'enum', options: [
      { value: 'incident', label: t('admin.integrations.entityIncident') }, { value: 'change', label: t('admin.integrations.entityChange') }, { value: 'problem', label: t('admin.integrations.entityProblem') },
      { value: 'event', label: t('admin.integrations.entityEvent') },
    ]},
    { key: 'enabled', label: t('admin.integrations.filters.enabled'), type: 'enum', options: yesNo },
    { key: 'name', label: t('admin.integrations.filters.name'), type: 'text' },
  ]
  const OUTBOUND_FILTERS: FieldConfig[] = [
    { key: 'enabled', label: t('admin.integrations.filters.enabled'), type: 'enum', options: yesNo },
    { key: 'name', label: t('admin.integrations.filters.name'), type: 'text' },
  ]
  const APIKEY_FILTERS: FieldConfig[] = [
    { key: 'enabled', label: t('admin.integrations.filters.enabled'), type: 'enum', options: yesNo },
    { key: 'name', label: t('admin.integrations.filters.name'), type: 'text' },
  ]

  // Queries — the active tab's sort/filters are the query variables
  const inQ = useQuery<{ inboundWebhooks: InboundWebhook[] }>(GET_INBOUND_WEBHOOKS, { variables: inList.variables })
  const outQ = useQuery<{ outboundWebhooks: OutboundWebhook[] }>(GET_OUTBOUND_WEBHOOKS, { variables: outList.variables })
  const keyQ = useQuery<{ apiKeys: ApiKeyRow[] }>(GET_API_KEYS, { variables: keyList.variables })

  // Writes refresh the ACTIVE list query via its `refetch()` (keeps the live
  // sort/filter variables; `refetchQueries: [{ query }]` without variables
  // would populate another cache entry). Mutations whose result the handler
  // needs inline (token/key/test outcome) are awaited and report the real
  // server message on failure; fire-and-forget ones toast via the hook.
  const refetchIn  = { onCompleted: () => { void inQ.refetch() } }
  const refetchOut = { onCompleted: () => { void outQ.refetch() } }
  const refetchKey = { onCompleted: () => { void keyQ.refetch() } }

  // Inbound mutations
  const [createIn] = useMutation(CREATE_INBOUND, refetchIn)
  const [updateIn] = useMutationWithToast(UPDATE_INBOUND, { refetch: inQ.refetch })
  const [deleteIn] = useMutationWithToast(DELETE_INBOUND, { successMessage: t('admin.integrations.webhookDeleted'), refetch: inQ.refetch })
  const [regenToken] = useMutation(REGEN_WEBHOOK_TOKEN)

  // Outbound mutations
  const [createOut] = useMutation(CREATE_OUTBOUND, refetchOut)
  const [updateOut] = useMutationWithToast(UPDATE_OUTBOUND, { refetch: outQ.refetch })
  const [deleteOut] = useMutationWithToast(DELETE_OUTBOUND, { successMessage: t('admin.integrations.webhookDeleted'), refetch: outQ.refetch })
  const [testOut] = useMutation(TEST_OUTBOUND)

  // API key mutations
  const [createKey] = useMutation(CREATE_API_KEY, refetchKey)
  const [updateKey] = useMutationWithToast(UPDATE_API_KEY, { refetch: keyQ.refetch })
  const [deleteKey] = useMutationWithToast(DELETE_API_KEY, { successMessage: t('admin.integrations.apiKeyDeleted'), refetch: keyQ.refetch })
  const [regenKey] = useMutation(REGEN_API_KEY)

  // ── Form state ──────────────────────────────────────────────────────────────

  const [inForm, setInForm] = useState({ name: '', entityType: 'incident', fieldMapping: '{}', defaultValues: '{}', transformScript: '' })
  const [outForm, setOutForm] = useState({ name: '', url: '', method: 'POST', headers: '{}', events: [] as string[], payloadTemplate: '', secret: '', retryOnFailure: true })
  const [keyForm, setKeyForm] = useState({ name: '', permissions: [] as string[], rateLimit: 1000, expiresAt: '' })

  const resetInForm = () => setInForm({ name: '', entityType: 'incident', fieldMapping: '{}', defaultValues: '{}', transformScript: '' })
  const inFormValid = Boolean(inForm.name)
  const resetOutForm = () => setOutForm({ name: '', url: '', method: 'POST', headers: '{}', events: [], payloadTemplate: '', secret: '', retryOnFailure: true })
  const resetKeyForm = () => setKeyForm({ name: '', permissions: [], rateLimit: 1000, expiresAt: '' })

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleCreateInbound() {
    try {
      const res = await createIn({ variables: { input: { ...inForm } } })
      setModal(null); resetInForm()
      const token = (res.data as { createInboundWebhook?: { token: string } } | undefined)?.createInboundWebhook?.token
      if (!token) throw new Error(t('admin.integrations.errors.tokenMissing'))
      setSecret(token); setModal('secret')
    } catch (e) { toast.error(t('toast.integration.webhookCreateFailed', { error: errorMessage(e) })) }
  }

  async function handleCreateOutbound() {
    try {
      await createOut({ variables: { input: { ...outForm } } })
      setModal(null); resetOutForm(); toast.success(t('toast.integration.outboundCreated'))
    } catch (e) { toast.error(t('toast.integration.webhookCreateFailed', { error: errorMessage(e) })) }
  }

  async function handleCreateApiKey() {
    try {
      const res = await createKey({ variables: { input: { ...keyForm, rateLimit: Number(keyForm.rateLimit) } } })
      setModal(null); resetKeyForm()
      const key = (res.data as { createApiKey?: { key: string } } | undefined)?.createApiKey?.key
      if (!key) throw new Error(t('admin.integrations.errors.keyMissing'))
      setSecret(key); setModal('secret')
    } catch (e) { toast.error(t('toast.integration.apiKeyCreateFailed', { error: errorMessage(e) })) }
  }

  // Toggles: errors are toasted by useMutationWithToast with the server message.
  function handleToggleInbound(id: string, enabled: boolean) {
    void updateIn({ variables: { id, input: { enabled: !enabled } } })
  }
  function handleToggleOutbound(id: string, enabled: boolean) {
    void updateOut({ variables: { id, input: { enabled: !enabled } } })
  }
  function handleToggleKey(id: string, enabled: boolean) {
    void updateKey({ variables: { id, input: { enabled: !enabled } } })
  }

  async function handleDeleteInbound(row: InboundWebhook) {
    if (await confirm({ title: t('admin.integrations.deleteWebhookTitle'), body: row.name, danger: true })) void deleteIn({ variables: { id: row.id } })
  }
  async function handleDeleteOutbound(row: OutboundWebhook) {
    if (await confirm({ title: t('admin.integrations.deleteWebhookTitle'), body: row.name, danger: true })) void deleteOut({ variables: { id: row.id } })
  }
  async function handleDeleteKey(row: ApiKeyRow) {
    if (await confirm({ title: t('admin.integrations.deleteApiKeyTitle'), body: row.name, danger: true })) void deleteKey({ variables: { id: row.id } })
  }

  async function handleTestOutbound(id: string) {
    try {
      const res = await testOut({ variables: { id } })
      const r = (res.data as { testOutboundWebhook?: { success: boolean; statusCode: number | null; error: string | null } } | undefined)?.testOutboundWebhook
      if (!r) throw new Error(t('admin.integrations.errors.emptyResponse'))
      if (r.success) toast.success(t('toast.integration.testOk', { status: r.statusCode }))
      else toast.error(t('toast.integration.testFailed', { error: r.error }))
    } catch (e) { toast.error(t('toast.integration.testError', { error: errorMessage(e) })) }
  }

  async function handleRegenToken(id: string) {
    try {
      const res = await regenToken({ variables: { id } })
      const token = (res.data as { regenerateWebhookToken?: { token: string } } | undefined)?.regenerateWebhookToken?.token
      if (!token) throw new Error(t('monitoring.errors.tokenMissing', { operation: 'regenerateWebhookToken' }))
      setSecret(token); setModal('secret')
    } catch (e) { toast.error(t('toast.integration.tokenRegenFailed', { error: errorMessage(e) })) }
  }

  async function handleRegenApiKey(id: string) {
    try {
      const res = await regenKey({ variables: { id } })
      const key = (res.data as { regenerateApiKey?: { key: string } } | undefined)?.regenerateApiKey?.key
      if (!key) throw new Error(t('admin.integrations.errors.keyMissing'))
      setSecret(key); setModal('secret')
    } catch (e) { toast.error(t('toast.integration.keyRegenFailed', { error: errorMessage(e) })) }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  const inbounds: InboundWebhook[]   = inQ.data?.inboundWebhooks ?? []
  const outbounds: OutboundWebhook[] = outQ.data?.outboundWebhooks ?? []
  const apiKeys: ApiKeyRow[]         = keyQ.data?.apiKeys ?? []

  // ── Column definitions ─────────────────────────────────────────────────────

  const inboundColumns: ColumnDef<InboundWebhook>[] = [
    { key: 'name', label: t('admin.integrations.columns.name'), sortable: true },
    { key: 'entityType', label: t('admin.integrations.columns.entityType'), sortable: true, render: (v) => <Pill bg={palette.info.bg} color="var(--color-brand)" radius={12} style={PILL_S}>{String(v)}</Pill> },
    { key: 'connectorKind', label: t('admin.integrations.connectorKind'), sortable: true, render: (v) => v ? <Pill bg={palette.purple.bg} color={palette.purple.dark} radius={12} style={PILL_S}>{String(v)}</Pill> : '—' },
    // Endpoint reale (rotta /api/webhooks/inbound/:id). Per le sorgenti evento
    // l'URL si copia da Monitoraggio → Sorgenti, insieme al token: qui solo il link.
    { key: 'id', label: t('admin.integrations.columns.endpoint'), sortable: true, render: (v, row) => {
      const url = sourceEndpointUrl(String(v))
      return row.entityType === 'event' ? (
        <Link to={`/monitoring/sources/${row.id}`} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500, whiteSpace: 'nowrap' }}>
          {t('admin.integrations.manageInMonitoring')} →
        </Link>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 'var(--font-size-body)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{url}</span>
          <Button variant="ghost" size="xs" aria-label={t('admin.integrations.copyEndpoint')} title={t('admin.integrations.copyEndpoint')} onClick={() => copyText(url)} style={{ padding: 2, color: 'var(--color-slate)' }}>
            <Copy size={12} aria-hidden="true" />
          </Button>
        </span>
      )
    } },
    { key: 'enabled', label: t('admin.integrations.columns.enabled'), sortable: true, render: (_v, row) => <Toggle checked={row.enabled} onChange={() => handleToggleInbound(row.id, row.enabled)} label={t('admin.integrations.toggleLabel', { name: row.name })} /> },
    { key: 'receiveCount', label: t('admin.integrations.columns.received'), sortable: true, render: (v) => String(v ?? 0) },
    { key: 'lastReceivedAt', label: t('admin.integrations.columns.lastReceived'), sortable: true, render: (v) => fmtDate(v as string | null) },
    { key: 'createdAt', label: '', render: (_v, row) => row.entityType === 'event' ? null : (
      <div style={ROW_ACTIONS}>
        <Button variant="icon" size="xs" title={t('admin.integrations.regenToken')} aria-label={t('admin.integrations.regenToken')} onClick={() => void handleRegenToken(row.id)}><RefreshCw size={13} aria-hidden="true" /></Button>
        <Button variant="danger" size="xs" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => void handleDeleteInbound(row)}><Trash2 size={13} aria-hidden="true" /></Button>
      </div>
    ) },
  ]

  const outboundColumns: ColumnDef<OutboundWebhook>[] = [
    { key: 'name', label: t('admin.integrations.columns.name'), sortable: true },
    { key: 'url', label: t('admin.integrations.columns.url'), sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-body)', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{String(v)}</span> },
    { key: 'events', label: t('admin.integrations.columns.events'), sortable: true, render: (v) => {
      const events: string[] = typeof v === 'string' ? JSON.parse(v) : (v as string[] ?? [])
      return <>{events.map(e => <Pill key={e} bg={palette.info.bg} color="var(--color-brand)" radius={12} style={PILL_S}>{e}</Pill>)}</>
    } },
    { key: 'enabled', label: t('admin.integrations.columns.enabled'), sortable: true, render: (_v, row) => <Toggle checked={row.enabled} onChange={() => handleToggleOutbound(row.id, row.enabled)} label={t('admin.integrations.toggleLabel', { name: row.name })} /> },
    { key: 'sendCount', label: t('admin.integrations.columns.sent'), sortable: true, render: (v) => String(v ?? 0) },
    { key: 'lastStatusCode', label: t('admin.integrations.columns.lastStatus'), sortable: true, render: (v) => {
      if (!v) return '—'
      const ok = Number(v) >= 200 && Number(v) < 300
      return <Pill bg={ok ? palette.success.tint : palette.danger.tint} color={ok ? 'var(--color-success)' : 'var(--color-trigger-sla-breach)'} radius={12} style={PILL_S}>{String(v)}</Pill>
    } },
    { key: 'lastError', label: t('admin.integrations.columns.lastError'), sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-danger)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{v ? String(v) : '—'}</span> },
    { key: 'retryOnFailure', label: '', render: (_v, row) => (
      <div style={ROW_ACTIONS}>
        <Button variant="icon" size="xs" title={t('admin.integrations.test')} aria-label={t('admin.integrations.test')} onClick={() => void handleTestOutbound(row.id)}><Play size={13} aria-hidden="true" /></Button>
        <Button variant="danger" size="xs" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => void handleDeleteOutbound(row)}><Trash2 size={13} aria-hidden="true" /></Button>
      </div>
    ) },
  ]

  const apiKeyColumns: ColumnDef<ApiKeyRow>[] = [
    { key: 'name', label: t('admin.integrations.columns.name'), sortable: true },
    { key: 'keyPrefix', label: t('admin.integrations.columns.keyPrefix'), sortable: true, render: (v) => <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-body)' }}>{String(v)}...</span> },
    { key: 'permissions', label: t('admin.integrations.columns.permissions'), sortable: true, render: (v) => {
      const perms: string[] = typeof v === 'string' ? JSON.parse(v) : (v as string[] ?? [])
      return <>{perms.map(p => <Pill key={p} bg={palette.info.bg} color="var(--color-brand)" radius={12} style={PILL_S}>{p}</Pill>)}</>
    } },
    { key: 'rateLimit', label: t('admin.integrations.columns.rateLimit'), sortable: true, render: (v) => `${String(v)}/min` },
    { key: 'enabled', label: t('admin.integrations.columns.enabled'), sortable: true, render: (_v, row) => <Toggle checked={row.enabled} onChange={() => handleToggleKey(row.id, row.enabled)} label={t('admin.integrations.toggleLabel', { name: row.name })} /> },
    { key: 'lastUsedAt', label: t('admin.integrations.columns.lastUsed'), sortable: true, render: (v) => fmtDate(v as string | null) },
    { key: 'requestCount', label: t('admin.integrations.columns.requests'), sortable: true, render: (v) => String(v ?? 0) },
    { key: 'createdAt', label: '', render: (_v, row) => (
      <div style={ROW_ACTIONS}>
        <Button variant="icon" size="xs" title={t('admin.integrations.regenKey')} aria-label={t('admin.integrations.regenKey')} onClick={() => void handleRegenApiKey(row.id)}><RefreshCw size={13} aria-hidden="true" /></Button>
        <Button variant="danger" size="xs" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => void handleDeleteKey(row)}><Trash2 size={13} aria-hidden="true" /></Button>
      </div>
    ) },
  ]

  // ── Checkbox helpers ────────────────────────────────────────────────────────

  const toggleList = (list: string[], val: string) => list.includes(val) ? list.filter(v => v !== val) : [...list, val]

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Plug size={22} color="var(--color-icon-accent)" />}>{t('admin.integrations.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('admin.integrations.subtitle')}
        </p>
      </div>

      <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel={t('admin.integrations.tabsLabel')} />

      {/* ── TAB: Webhook In ─────────────────────────────────────────────────── */}
      {tab === 'inbound' && <>
        <p style={{ margin: '0 0 12px', padding: '8px 12px', background: 'var(--color-brand-light)', borderRadius: 8, fontSize: 'var(--font-size-body)', color: palette.info.text }}>
          {t('admin.integrations.eventsNote')}{' '}
          <Link to="/monitoring/sources" style={{ color: 'var(--color-brand)', fontWeight: 600 }}>{t('admin.integrations.eventsNoteLink')}</Link>.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => { resetInForm(); setModal('inbound') }}>{t('admin.integrations.newInbound')}</Button>
        </div>
        <FilterBuilder fields={INBOUND_FILTERS} onApply={inList.setFilterGroup} />
        <SortableFilterTable<InboundWebhook> onSort={inList.handleSort} sortField={inList.sortField} sortDir={inList.sortDir}
          columns={inboundColumns}
          data={inbounds}
          loading={inQ.loading}
          emptyMessage={t('admin.integrations.emptyInbound')}
          label={t('admin.integrations.tableInbound')}
        />

        {modal === 'inbound' && (
          <ModalPortal modalType="inbound" onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label htmlFor={fid('in-name')} style={labelS}>{t('admin.integrations.form.name')}</label><Input id={fid('in-name')} style={inputS} value={inForm.name} onChange={e => setInForm({ ...inForm, name: e.target.value })} /></div>
              <div><label htmlFor={fid('in-entity-type')} style={labelS}>{t('admin.integrations.form.entityType')}</label>
                <Select id={fid('in-entity-type')} style={selectS} value={inForm.entityType} onChange={e => setInForm({ ...inForm, entityType: e.target.value })}>
                  {ENTITY_TYPES.map(et => <option key={et} value={et}>{et}</option>)}
                </Select>
              </div>
              <div><label htmlFor={fid('in-field-mapping')} style={labelS}>{t('admin.integrations.form.fieldMapping')}</label><textarea id={fid('in-field-mapping')} style={textareaS} value={inForm.fieldMapping} onChange={e => setInForm({ ...inForm, fieldMapping: e.target.value })} /></div>
              <div><label htmlFor={fid('in-default-values')} style={labelS}>{t('admin.integrations.form.defaultValues')}</label><textarea id={fid('in-default-values')} style={textareaS} value={inForm.defaultValues} onChange={e => setInForm({ ...inForm, defaultValues: e.target.value })} /></div>
              <div><label htmlFor={fid('in-transform-script')} style={labelS}>{t('admin.integrations.form.transformScript')}</label><textarea id={fid('in-transform-script')} style={textareaS} value={inForm.transformScript} onChange={e => setInForm({ ...inForm, transformScript: e.target.value })} /></div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <Button variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
                <Button onClick={() => void handleCreateInbound()} disabled={!inFormValid}>{t('common.create')}</Button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* ── TAB: Webhook Out ────────────────────────────────────────────────── */}
      {tab === 'outbound' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => { resetOutForm(); setModal('outbound') }}>{t('admin.integrations.newOutbound')}</Button>
        </div>
        <FilterBuilder fields={OUTBOUND_FILTERS} onApply={outList.setFilterGroup} />
        <SortableFilterTable<OutboundWebhook> onSort={outList.handleSort} sortField={outList.sortField} sortDir={outList.sortDir}
          columns={outboundColumns}
          data={outbounds}
          loading={outQ.loading}
          emptyMessage={t('admin.integrations.emptyOutbound')}
          label={t('admin.integrations.tableOutbound')}
        />

        {modal === 'outbound' && (
          <ModalPortal modalType="outbound" onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label htmlFor={fid('out-name')} style={labelS}>{t('admin.integrations.form.name')}</label><Input id={fid('out-name')} style={inputS} value={outForm.name} onChange={e => setOutForm({ ...outForm, name: e.target.value })} /></div>
              <div><label htmlFor={fid('out-url')} style={labelS}>{t('admin.integrations.form.url')}</label><Input id={fid('out-url')} style={inputS} value={outForm.url} onChange={e => setOutForm({ ...outForm, url: e.target.value })} placeholder="https://..." /></div>
              <div><label htmlFor={fid('out-method')} style={labelS}>{t('admin.integrations.form.method')}</label>
                <Select id={fid('out-method')} style={selectS} value={outForm.method} onChange={e => setOutForm({ ...outForm, method: e.target.value })}>
                  {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </Select>
              </div>
              <div><label htmlFor={fid('out-headers')} style={labelS}>{t('admin.integrations.form.headers')}</label><textarea id={fid('out-headers')} style={textareaS} value={outForm.headers} onChange={e => setOutForm({ ...outForm, headers: e.target.value })} /></div>
              <div>
                <div style={labelS}>{t('admin.integrations.form.events')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {OUTBOUND_EVENTS.map(ev => (
                    <label key={ev} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={outForm.events.includes(ev)} onChange={() => setOutForm({ ...outForm, events: toggleList(outForm.events, ev) })} />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
              <div><label htmlFor={fid('out-payload-template')} style={labelS}>{t('admin.integrations.form.payloadTemplate')}</label><textarea id={fid('out-payload-template')} style={textareaS} value={outForm.payloadTemplate} onChange={e => setOutForm({ ...outForm, payloadTemplate: e.target.value })} /></div>
              <div><label htmlFor={fid('out-secret')} style={labelS}>{t('admin.integrations.form.secret')}</label><Input id={fid('out-secret')} style={inputS} value={outForm.secret} onChange={e => setOutForm({ ...outForm, secret: e.target.value })} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                <input type="checkbox" checked={outForm.retryOnFailure} onChange={e => setOutForm({ ...outForm, retryOnFailure: e.target.checked })} />
                {t('admin.integrations.retryOnFailure')}
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <Button variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
                <Button onClick={() => void handleCreateOutbound()} disabled={!outForm.name || !outForm.url}>{t('common.create')}</Button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* ── TAB: API Keys ───────────────────────────────────────────────────── */}
      {tab === 'apikeys' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => { resetKeyForm(); setModal('apikey') }}>{t('admin.integrations.newApiKey')}</Button>
        </div>
        <FilterBuilder fields={APIKEY_FILTERS} onApply={keyList.setFilterGroup} />
        <SortableFilterTable<ApiKeyRow> onSort={keyList.handleSort} sortField={keyList.sortField} sortDir={keyList.sortDir}
          columns={apiKeyColumns}
          data={apiKeys}
          loading={keyQ.loading}
          emptyMessage={t('admin.integrations.emptyApiKeys')}
          label={t('admin.integrations.tableApiKeys')}
        />

        {modal === 'apikey' && (
          <ModalPortal modalType="apikey" onClose={() => setModal(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label htmlFor={fid('key-name')} style={labelS}>{t('admin.integrations.form.name')}</label><Input id={fid('key-name')} style={inputS} value={keyForm.name} onChange={e => setKeyForm({ ...keyForm, name: e.target.value })} /></div>
              <div>
                <div style={labelS}>{t('admin.integrations.form.permissions')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  {PERMISSIONS.map(p => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={keyForm.permissions.includes(p)} onChange={() => setKeyForm({ ...keyForm, permissions: toggleList(keyForm.permissions, p) })} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <div><label htmlFor={fid('key-rate-limit')} style={labelS}>{t('admin.integrations.form.rateLimit')}</label><Input id={fid('key-rate-limit')} style={inputS} type="number" value={keyForm.rateLimit} onChange={e => setKeyForm({ ...keyForm, rateLimit: Number(e.target.value) })} /></div>
              <div><label htmlFor={fid('key-expires-at')} style={labelS}>{t('admin.integrations.form.expiresAt')}</label><Input id={fid('key-expires-at')} style={inputS} type="date" value={keyForm.expiresAt} onChange={e => setKeyForm({ ...keyForm, expiresAt: e.target.value })} /></div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <Button variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
                <Button onClick={() => void handleCreateApiKey()} disabled={!keyForm.name || !keyForm.permissions.length}>{t('common.create')}</Button>
              </div>
            </div>
          </ModalPortal>
        )}
      </>}

      {/* Secret reveal modal */}
      {modal === 'secret' && (
        <ModalPortal modalType="secret" onClose={() => { setModal(null); setSecret('') }}>
          <div role="alert" style={{ background: 'var(--color-warning-bg)', border: `1px solid ${palette.warning.border}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 'var(--font-size-body)', color: palette.warning.strong }}>
            {t('admin.integrations.secretWarning')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '8px 12px', background: 'var(--color-slate-bg)', borderRadius: 6, fontSize: 'var(--font-size-body)', wordBreak: 'break-all', border: '1px solid var(--border)' }}>{secret}</code>
            <Button variant="secondary" icon={<Copy size={14} aria-hidden="true" />} onClick={() => copyText(secret)}>{t('admin.integrations.copy')}</Button>
          </div>
        </ModalPortal>
      )}
    </PageContainer>
  )
}
