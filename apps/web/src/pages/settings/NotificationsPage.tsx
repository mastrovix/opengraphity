import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { Modal } from '@/components/Modal'
import { Bell } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'

const GET_NOTIFICATION_CHANNELS = gql`
  query GetNotificationChannels {
    notificationChannels {
      id platform name webhookUrl channelId eventTypes active createdAt
    }
  }
`
const CREATE_NOTIFICATION_CHANNEL = gql`
  mutation CreateNotificationChannel($input: CreateNotificationChannelInput!) {
    createNotificationChannel(input: $input) {
      id platform name webhookUrl channelId eventTypes active createdAt
    }
  }
`
const UPDATE_NOTIFICATION_CHANNEL = gql`
  mutation UpdateNotificationChannel($id: ID!, $input: CreateNotificationChannelInput!) {
    updateNotificationChannel(id: $id, input: $input) {
      id platform name webhookUrl channelId eventTypes active createdAt
    }
  }
`
const DELETE_NOTIFICATION_CHANNEL = gql`
  mutation DeleteNotificationChannel($id: ID!) {
    deleteNotificationChannel(id: $id)
  }
`
const TEST_NOTIFICATION_CHANNEL = gql`
  mutation TestNotificationChannel($id: ID!) {
    testNotificationChannel(id: $id)
  }
`

const ALL_EVENTS = [
  { value: 'sla_breach',      label: 'SLA Breach',           defaultOn: true  },
  { value: 'escalation',      label: 'Escalation',           defaultOn: true  },
  { value: 'assigned',        label: 'Assegnazione a me',    defaultOn: true  },
  { value: 'resolved',        label: 'Risoluzione incident', defaultOn: false },
  { value: 'change_approved',       label: 'Change approvato',           defaultOn: false },
  { value: 'change_failed',         label: 'Change fallito',             defaultOn: false },
  { value: 'change_task_assigned',  label: 'Task assessment assegnato',  defaultOn: false },
]

interface Channel {
  id: string
  platform: string
  name: string
  webhookUrl: string | null
  channelId: string | null
  eventTypes: string[]
  active: boolean
  createdAt: string
}

interface FormState {
  platform: string
  name: string
  webhookUrl: string
  channelId: string
  eventTypes: string[]
}

const defaultForm = (): FormState => ({
  platform:   'slack',
  name:       '',
  webhookUrl: '',
  channelId:  '',
  eventTypes: ALL_EVENTS.filter((e) => e.defaultOn).map((e) => e.value),
})

const PLATFORM_BADGE: Record<string, { bg: string; color: string }> = {
  slack: { bg: '#f0f4ff', color: '#4a154b' },
  teams: { bg: '#f0f4ff', color: '#464eb8' },
}

export default function NotificationsPage() {
  const { data, refetch } = useQuery<{ notificationChannels: Channel[] }>(GET_NOTIFICATION_CHANNELS)
  const [createChannel] = useMutation(CREATE_NOTIFICATION_CHANNEL)
  const [updateChannel] = useMutation(UPDATE_NOTIFICATION_CHANNEL)
  const [deleteChannel] = useMutation(DELETE_NOTIFICATION_CHANNEL)
  const [testChannel]   = useMutation(TEST_NOTIFICATION_CHANNEL)

  const [dialogOpen, setDialogOpen]   = useState(false)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [form, setForm]               = useState<FormState>(defaultForm())
  const [testResult, setTestResult]   = useState<Record<string, boolean | null>>({})

  const channels = data?.notificationChannels ?? []

  function openCreate() {
    setEditingId(null)
    setForm(defaultForm())
    setDialogOpen(true)
  }

  function openEdit(ch: Channel) {
    setEditingId(ch.id)
    setForm({
      platform:   ch.platform,
      name:       ch.name,
      webhookUrl: ch.webhookUrl ?? '',
      channelId:  ch.channelId ?? '',
      eventTypes: ch.eventTypes,
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    const input = {
      platform:   form.platform,
      name:       form.name,
      webhookUrl: form.webhookUrl || null,
      channelId:  form.channelId  || null,
      eventTypes: form.eventTypes,
    }
    if (editingId) {
      await updateChannel({ variables: { id: editingId, input } })
    } else {
      await createChannel({ variables: { input } })
    }
    setDialogOpen(false)
    void refetch()
  }

  async function handleDelete(id: string) {
    if (!confirm('Eliminare questo canale?')) return
    await deleteChannel({ variables: { id } })
    void refetch()
  }

  async function handleTest(id: string) {
    setTestResult((p) => ({ ...p, [id]: null }))
    const res = await testChannel({ variables: { id } })
    setTestResult((p) => ({ ...p, [id]: (res.data as { testNotificationChannel?: boolean } | null)?.testNotificationChannel ?? false }))
  }

  function toggleEvent(val: string) {
    setForm((f) => ({
      ...f,
      eventTypes: f.eventTypes.includes(val)
        ? f.eventTypes.filter((e) => e !== val)
        : [...f.eventTypes, val],
    }))
  }

  return (
    <PageContainer>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <PageTitle icon={<Bell size={22} color="#38bdf8" />}>
          Notifiche
        </PageTitle>
        <button
          onClick={openCreate}
          style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: '#fff', background: 'var(--color-brand)', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' }}
        >
          + Aggiungi canale
        </button>
      </div>

      {channels.length === 0 ? (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', padding: '40px 0', textAlign: 'center' }}>
          Nessun canale configurato. Aggiungi Slack o Teams per ricevere notifiche.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {channels.map((ch) => {
            const pb = PLATFORM_BADGE[ch.platform] ?? { bg: '#f3f4f6', color: 'var(--color-slate)' }
            const tr = testResult[ch.id]
            return (
              <div key={ch.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 8px', borderRadius: 4, background: pb.bg, color: pb.color }}>
                  {ch.platform}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{ch.name}</div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>{ch.eventTypes.join(', ')}</div>
                </div>
                {tr === true  && <span style={{ fontSize: 'var(--font-size-body)', color: '#16a34a' }}>✓ Inviato</span>}
                {tr === false && <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>✗ Errore</span>}
                <button onClick={() => void handleTest(ch.id)}   style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Testa</button>
                <button onClick={() => openEdit(ch)}              style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Modifica</button>
                <button onClick={() => void handleDelete(ch.id)}  style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', background: 'none', border: '1px solid #fee2e2', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Elimina</button>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingId ? 'Modifica canale' : 'Aggiungi canale'}
        footer={
          <>
            <button onClick={() => setDialogOpen(false)} style={{ fontSize: 'var(--font-size-card-title)', padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: 'var(--color-slate)', cursor: 'pointer' }}>Annulla</button>
            <button onClick={() => void handleSave()} style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--color-brand)', color: '#fff', cursor: 'pointer' }}>Salva</button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>Platform</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['slack', 'teams'].map((p) => (
              <button
                key={p}
                onClick={() => setForm((f) => ({ ...f, platform: p }))}
                style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, padding: '6px 18px', borderRadius: 6, cursor: 'pointer', border: '2px solid', borderColor: form.platform === p ? 'var(--color-brand)' : '#e5e7eb', background: form.platform === p ? '#eff0ff' : '#fff', color: form.platform === p ? 'var(--color-brand)' : 'var(--color-slate)' }}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>Nome</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            style={{ width: '100%', fontSize: 'var(--font-size-card-title)', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
          />
        </div>

        {form.platform === 'slack' && (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>Webhook URL</label>
              <input
                value={form.webhookUrl}
                onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                placeholder="https://hooks.slack.com/services/..."
                style={{ width: '100%', fontSize: 'var(--font-size-card-title)', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>
                Channel ID <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>(Bot API)</span>
              </label>
              <input
                value={form.channelId}
                onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                placeholder="C0XXXXXXXXX"
                style={{ width: '100%', fontSize: 'var(--font-size-card-title)', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4 }}>Usa Webhook URL per canali pubblici, Channel ID se hai configurato il Bot Token</div>
            </div>
          </>
        )}

        {form.platform === 'teams' && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>Webhook URL *</label>
            <input
              value={form.webhookUrl}
              onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
              placeholder="https://outlook.office.com/webhook/..."
              style={{ width: '100%', fontSize: 'var(--font-size-card-title)', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
            />
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 8 }}>Eventi da notificare</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ALL_EVENTS.map((ev) => (
              <label key={ev.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.eventTypes.includes(ev.value)} onChange={() => toggleEvent(ev.value)} />
                {ev.label}
              </label>
            ))}
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
