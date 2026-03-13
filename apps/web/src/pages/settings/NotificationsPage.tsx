import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'

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
  { value: 'change_approved', label: 'Change approvato',     defaultOn: false },
  { value: 'change_failed',   label: 'Change fallito',       defaultOn: false },
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
    <div style={{ padding: '24px 32px', maxWidth: 800 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Notifiche</h1>
        <button
          onClick={openCreate}
          style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: '#4f46e5', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' }}
        >
          + Aggiungi canale
        </button>
      </div>

      {channels.length === 0 ? (
        <div style={{ fontSize: 14, color: '#9ca3af', padding: '40px 0', textAlign: 'center' }}>
          Nessun canale configurato. Aggiungi Slack o Teams per ricevere notifiche.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {channels.map((ch) => {
            const pb = PLATFORM_BADGE[ch.platform] ?? { bg: '#f3f4f6', color: '#374151' }
            const tr = testResult[ch.id]
            return (
              <div key={ch.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', background: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 8px', borderRadius: 4, background: pb.bg, color: pb.color }}>
                  {ch.platform}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{ch.name}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{ch.eventTypes.join(', ')}</div>
                </div>
                {tr === true  && <span style={{ fontSize: 11, color: '#16a34a' }}>✓ Inviato</span>}
                {tr === false && <span style={{ fontSize: 11, color: '#dc2626' }}>✗ Errore</span>}
                <button onClick={() => void handleTest(ch.id)}   style={{ fontSize: 12, color: '#4f46e5', background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Testa</button>
                <button onClick={() => openEdit(ch)}              style={{ fontSize: 12, color: '#374151', background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Modifica</button>
                <button onClick={() => void handleDelete(ch.id)}  style={{ fontSize: 12, color: '#dc2626', background: 'none', border: '1px solid #fee2e2', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>Elimina</button>
              </div>
            )
          })}
        </div>
      )}

      {dialogOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: '28px 32px', width: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 20px' }}>
              {editingId ? 'Modifica canale' : 'Aggiungi canale'}
            </h2>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Platform</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['slack', 'teams'].map((p) => (
                  <button
                    key={p}
                    onClick={() => setForm((f) => ({ ...f, platform: p }))}
                    style={{ fontSize: 13, fontWeight: 600, padding: '6px 18px', borderRadius: 6, cursor: 'pointer', border: '2px solid', borderColor: form.platform === p ? '#4f46e5' : '#e5e7eb', background: form.platform === p ? '#eff0ff' : '#fff', color: form.platform === p ? '#4f46e5' : '#374151' }}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Nome</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>

            {form.platform === 'slack' && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Webhook URL</label>
                  <input
                    value={form.webhookUrl}
                    onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                    placeholder="https://hooks.slack.com/services/..."
                    style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                    Channel ID <span style={{ fontWeight: 400, color: '#9ca3af' }}>(Bot API)</span>
                  </label>
                  <input
                    value={form.channelId}
                    onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                    placeholder="C0XXXXXXXXX"
                    style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Usa Webhook URL per canali pubblici, Channel ID se hai configurato il Bot Token</div>
                </div>
              </>
            )}

            {form.platform === 'teams' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Webhook URL *</label>
                <input
                  value={form.webhookUrl}
                  onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                  placeholder="https://outlook.office.com/webhook/..."
                  style={{ width: '100%', fontSize: 13, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>
            )}

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 8 }}>Eventi da notificare</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ALL_EVENTS.map((ev) => (
                  <label key={ev.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.eventTypes.includes(ev.value)} onChange={() => toggleEvent(ev.value)} />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDialogOpen(false)} style={{ fontSize: 13, padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer' }}>Annulla</button>
              <button onClick={() => void handleSave()}    style={{ fontSize: 13, fontWeight: 600, padding: '8px 16px', border: 'none', borderRadius: 6, background: '#4f46e5', color: '#fff', cursor: 'pointer' }}>Salva</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
