import { useCallback, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Plus, Bell } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { GET_NOTIFICATION_RULES } from '@/graphql/queries'
import { UPDATE_NOTIFICATION_RULE, CREATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE } from '@/graphql/mutations'
import { fontSize, fontWeight } from '@/lib/tokens'
import { RuleRow } from './NotificationRuleList'
import type { NotificationRule, UpdateInput } from './NotificationRuleList'
import { NewRuleDialog } from './NotificationRuleForm'
import type { CreateInput } from './NotificationRuleForm'

// ── Constants ─────────────────────────────────────────────────────────────────

const STANDARD_EVENTS = [
  'incident.created', 'incident.assigned', 'incident.in_progress',
  'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
  'incident.escalation',
  'change.approved', 'change.completed', 'change.failed', 'change.rejected', 'change.task_assigned',
  'problem.created', 'problem.under_investigation', 'problem.deferred', 'problem.resolved', 'problem.closed',
  'sla.warning', 'sla.breached',
  'digest.daily',
]

const CATEGORIES: { key: string; events: string[] }[] = [
  {
    key: 'Incident',
    events: [
      'incident.created', 'incident.assigned', 'incident.in_progress',
      'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
    ],
  },
  {
    key: 'Change',
    events: [
      'change.approved', 'change.completed', 'change.failed',
      'change.rejected', 'change.task_assigned',
    ],
  },
  {
    key: 'Problem',
    events: [
      'problem.created', 'problem.under_investigation', 'problem.deferred',
      'problem.resolved', 'problem.closed',
    ],
  },
  {
    key: 'SLA',
    events: ['sla.warning', 'sla.breached'],
  },
  {
    key: 'Escalation',
    events: ['incident.escalation'],
  },
  {
    key: 'Digest',
    events: ['digest.daily'],
  },
]

const TH: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontSize: 11,
  fontWeight: fontWeight.semibold, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NotificationRulesPage() {
  const { t } = useTranslation()
  const [showDialog, setShowDialog] = useState(false)

  const { data, loading } = useQuery<{ notificationRules: NotificationRule[] }>(
    GET_NOTIFICATION_RULES,
    { fetchPolicy: 'cache-and-network' },
  )

  const refetchQ = [{ query: GET_NOTIFICATION_RULES }]

  const [updateRule] = useMutation<{ updateNotificationRule: NotificationRule }>(
    UPDATE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const [createRule, { loading: creating }] = useMutation<{ createNotificationRule: NotificationRule }>(
    CREATE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const [deleteRule] = useMutation<{ deleteNotificationRule: boolean }>(
    DELETE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const handleUpdate = useCallback((id: string, input: UpdateInput) => {
    updateRule({ variables: { id, input } })
  }, [updateRule])

  const handleCreate = useCallback((input: CreateInput) => {
    createRule({ variables: { input } }).then(() => setShowDialog(false))
  }, [createRule])

  const handleDelete = useCallback((id: string) => {
    if (window.confirm(t('notificationRules.deleteRule') + '?')) {
      deleteRule({ variables: { id } })
    }
  }, [deleteRule, t])

  const allRules   = data?.notificationRules ?? []
  const byEvent    = allRules.reduce<Record<string, NotificationRule>>((acc, r) => { acc[r.eventType] = r; return acc }, {})
  const customRules = allRules.filter((r) => !STANDARD_EVENTS.includes(r.eventType))

  const tableHeader = (
    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
      <th style={{ ...TH, width: 52 }}>{t('notificationRules.enabled')}</th>
      <th style={TH}>{t('notificationRules.event')}</th>
      <th style={{ ...TH, width: 120 }}>{t('notificationRules.header.severity')}</th>
      <th style={TH}>{t('notificationRules.header.channels')}</th>
      <th style={{ ...TH, width: 160 }}>{t('notificationRules.header.target')}</th>
      <th style={{ ...TH, width: 36 }} />
    </tr>
  )

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <PageTitle icon={<Bell size={22} color="var(--color-brand)" />}>
            {t('notificationRules.title')}
          </PageTitle>
          <p style={{ fontSize: fontSize.body, color: '#64748b', margin: 0 }}>
            {t('notificationRules.description')}
          </p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500,
            cursor: 'pointer', transition: 'background-color 150ms',
          }}
        >
          <Plus size={14} />
          {t('notificationRules.addRule')}
        </button>
      </div>

      {loading && !data ? (
        <div style={{ color: '#94a3b8', fontSize: fontSize.body }}>{t('common.loading', 'Caricamento…')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CATEGORIES.map(({ key, events }) => {
            const rules = events.map((e) => byEvent[e]).filter(Boolean) as NotificationRule[]
            if (!rules.length) return null
            return (
              <section key={key}>
                <h2 style={{
                  fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                  color: '#0f172a', margin: '0 0 10px', paddingBottom: 8,
                  borderBottom: '2px solid #e2e8f0',
                }}>
                  {t(`notificationRules.category.${key.toLowerCase()}`, key)}
                </h2>
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>{tableHeader}</thead>
                    <tbody>
                      {rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} onUpdate={handleUpdate} onDelete={handleDelete} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}

          {/* Custom rules */}
          {customRules.length > 0 && (
            <section>
              <h2 style={{
                fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                color: '#0f172a', margin: '0 0 10px', paddingBottom: 8,
                borderBottom: '2px solid #e2e8f0',
              }}>
                {t('notificationRules.category.custom', 'Custom')}
              </h2>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>{tableHeader}</thead>
                  <tbody>
                    {customRules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} onUpdate={handleUpdate} onDelete={handleDelete} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {showDialog && (
        <NewRuleDialog
          onSave={handleCreate}
          onClose={() => setShowDialog(false)}
          saving={creating}
        />
      )}
    </PageContainer>
  )
}
