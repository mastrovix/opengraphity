import { Pill } from '@/components/ui/Pill'
import { Chip } from '@/components/ui/Chip'
import { Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { PageContainer } from '@/components/PageContainer'
import { Modal } from '@/components/Modal'
import { Bell } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { lookupStyle, colors, palette, vendorColors } from '@/lib/tokens'
import { useConfirm } from '@/hooks/useConfirm'
import { useTranslation } from 'react-i18next'
import { showError } from '@/lib/showError'

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

/** Etichette come CHIAVI: la casella si legge nella lingua del cliente. */
const ALL_EVENTS = [
  { value: 'sla_breach',           labelKey: 'pages.notifications.event.slaBreach',         defaultOn: true  },
  { value: 'escalation',           labelKey: 'pages.notifications.event.escalation',        defaultOn: true  },
  { value: 'assigned',             labelKey: 'pages.notifications.event.assignedToMe',      defaultOn: true  },
  { value: 'resolved',             labelKey: 'pages.notifications.event.incidentResolved',  defaultOn: false },
  { value: 'change_approved',      labelKey: 'pages.notifications.event.changeApproved',    defaultOn: false },
  { value: 'change_failed',        labelKey: 'pages.notifications.event.changeFailed',      defaultOn: false },
  { value: 'change_task_assigned', labelKey: 'pages.notifications.event.assessmentAssigned', defaultOn: false },
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
  slack: { bg: palette.info.bg, color: vendorColors.slack },
  teams: { bg: palette.info.bg, color: vendorColors.teams },
}

export default function NotificationsPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const fid = useId()
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
    try {
      if (editingId) {
        await updateChannel({ variables: { id: editingId, input } })
      } else {
        await createChannel({ variables: { input } })
      }
    } catch (e) {
      // Il dialog resta aperto: l'utente non perde i dati inseriti.
      showError(e)
      return
    }
    setDialogOpen(false)
    void refetch()
  }

  async function handleDelete(id: string) {
    if (!(await confirm({ title: t('admin.notificationChannels.deleteTitle'), danger: true }))) return
    try {
      await deleteChannel({ variables: { id } })
    } catch (e) {
      showError(e)
      return
    }
    void refetch()
  }

  async function handleTest(id: string) {
    setTestResult((p) => ({ ...p, [id]: null }))
    try {
      const res = await testChannel({ variables: { id } })
      setTestResult((p) => ({ ...p, [id]: (res.data as { testNotificationChannel?: boolean } | null)?.testNotificationChannel ?? false }))
    } catch (e) {
      showError(e)
      setTestResult((p) => ({ ...p, [id]: false }))
    }
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
        <PageTitle icon={<Bell size={22} color="var(--color-icon-accent)" />}>
          {t('sidebar.notifications')}
        </PageTitle>
        <Button variant="primary"
          onClick={openCreate}
        >
          + {t('pages.notifications.addChannel')}
        </Button>
      </div>

      {channels.length === 0 ? (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', padding: '40px 0', textAlign: 'center' }}>
          {t('pages.notifications.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {channels.map((ch) => {
            const pb = lookupStyle(PLATFORM_BADGE, ch.platform, 'PLATFORM_BADGE')
            const tr = testResult[ch.id]
            return (
              <div key={ch.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', background: colors.white, display: 'flex', alignItems: 'center', gap: 12 }}>
                <Pill bg={pb.bg} color={pb.color} radius={4} style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {ch.platform}
                </Pill>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{ch.name}</div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>{ch.eventTypes.join(', ')}</div>
                </div>
                {tr === true  && <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-success)' }}>{t('pages.notifications.testSent')}</span>}
                {tr === false && <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{t('pages.notifications.testFailed')}</span>}
                <Button variant="secondary" onClick={() => handleTest(ch.id)}>{t('pages.notifications.test')}</Button>
                <Button variant="secondary" onClick={() => openEdit(ch)}>{t('common.edit')}</Button>
                <Button variant="danger" onClick={() => handleDelete(ch.id)}>{t('common.delete')}</Button>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t(editingId ? 'pages.notifications.editChannel' : 'pages.notifications.addChannel')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => handleSave()}>{t('common.save')}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <div id={`${fid}-platform`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>{t('pages.notifications.platform')}</div>
          <div role="group" aria-labelledby={`${fid}-platform`} style={{ display: 'flex', gap: 8 }}>
            {['slack', 'teams'].map((p) => (
              <Chip pressed={form.platform === p} key={p} onClick={() => setForm((f) => ({ ...f, platform: p }))}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </Chip>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor={`${fid}-name`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>{t('common.name')}</label>
          <Input
            id={`${fid}-name`}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>

        {form.platform === 'slack' && (
          <>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={`${fid}-slack-webhook`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>{t('pages.notifications.webhookUrl')}</label>
              <Input
                id={`${fid}-slack-webhook`}
                value={form.webhookUrl}
                onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                placeholder="https://hooks.slack.com/services/..."
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={`${fid}-channel-id`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>
                {t('pages.notifications.channelId')} <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>{t('pages.notifications.channelIdProtocol')}</span>
              </label>
              <Input
                id={`${fid}-channel-id`}
                value={form.channelId}
                onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
                placeholder="C0XXXXXXXXX"
              />
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('pages.notifications.slackHint')}</div>
            </div>
          </>
        )}

        {form.platform === 'teams' && (
          <div style={{ marginBottom: 14 }}>
            <label htmlFor={`${fid}-teams-webhook`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>{t('pages.notifications.webhookUrlRequired')}</label>
            <Input
              id={`${fid}-teams-webhook`}
              value={form.webhookUrl}
              onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
              placeholder="https://outlook.office.com/webhook/..."
            />
          </div>
        )}

        <fieldset style={{ marginBottom: 20, border: 'none', padding: 0, margin: '0 0 20px' }}>
          <legend style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 8, padding: 0 }}>{t('pages.notifications.eventsToNotify')}</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ALL_EVENTS.map((ev) => (
              <label key={ev.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.eventTypes.includes(ev.value)} onChange={() => toggleEvent(ev.value)} />
                {t(ev.labelKey)}
              </label>
            ))}
          </div>
        </fieldset>
      </Modal>
    </PageContainer>
  )
}
