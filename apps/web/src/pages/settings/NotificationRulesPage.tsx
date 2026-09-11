import { useCallback, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
import { useConfirm } from '@/hooks/useConfirm'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Plus, Bell } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { GET_NOTIFICATION_RULES, GET_NOTIFICATION_ROUTING } from '@/graphql/queries'
import { UPDATE_NOTIFICATION_RULE, CREATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE } from '@/graphql/mutations'
import { fontSize, fontWeight, colors } from '@/lib/tokens'
import { RuleRow, routableFor, RULE_CATEGORIES, STANDARD_EVENTS } from './NotificationRuleList'
import type { NotificationRule, NotificationRouting, UpdateInput } from './NotificationRuleList'
import { NewRuleDialog } from './NotificationRuleForm'
import type { CreateInput } from './NotificationRuleForm'
import { QueryError } from '@/components/QueryError'

// ── Constants ─────────────────────────────────────────────────────────────────
// Le sezioni (RULE_CATEGORIES) e i canali consegnabili (routableFor) vivono in
// NotificationRuleList.tsx, condivisi con il dialogo della nuova regola.

const TH: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontSize: 'var(--font-size-table)',
  fontWeight: fontWeight.semibold, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NotificationRulesPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [showDialog, setShowDialog] = useState(false)

  const { data, loading, refetch } = useQuery<{ notificationRules: NotificationRule[] }>(
    GET_NOTIFICATION_RULES,
    { fetchPolicy: 'cache-and-network' },
  )
  // Canali consegnabili per tipo di evento: senza questa tabella la pagina non
  // può offrire i canali in modo onesto, quindi un errore qui è un errore
  // della pagina, non un elenco di canali «a prescindere».
  const routingQuery = useQuery<{ notificationRouting: NotificationRouting }>(GET_NOTIFICATION_ROUTING)
  const routing = routingQuery.data?.notificationRouting

  // Errors → toast with the server message; success → refetch() of the
  // active query (E-08).
  const [updateRule] = useMutationWithToast<{ updateNotificationRule: NotificationRule }>(
    UPDATE_NOTIFICATION_RULE,
    { refetch },
  )

  const [createRule, { loading: creating }] = useMutationWithToast<{ createNotificationRule: NotificationRule }>(
    CREATE_NOTIFICATION_RULE,
    { refetch, onSuccess: () => setShowDialog(false) },
  )

  const [deleteRule] = useMutationWithToast<{ deleteNotificationRule: boolean }>(
    DELETE_NOTIFICATION_RULE,
    { refetch },
  )

  const handleUpdate = useCallback((id: string, input: UpdateInput) => {
    void updateRule({ variables: { id, input } })
  }, [updateRule])

  const handleCreate = useCallback((input: CreateInput) => {
    void createRule({ variables: { input } })
  }, [createRule])

  const handleDelete = useCallback(async (id: string) => {
    if (await confirm({ title: t('notificationRules.deleteRule'), danger: true })) {
      void deleteRule({ variables: { id } })
    }
  }, [confirm, deleteRule, t])

  const allRules   = data?.notificationRules ?? []
  const byEvent    = allRules.reduce<Record<string, NotificationRule>>((acc, r) => { acc[r.eventType] = r; return acc }, {})
  const customRules = allRules.filter((r) => !STANDARD_EVENTS.includes(r.eventType))

  const tableHeader = (
    <tr style={{ background: 'var(--color-slate-bg)', borderBottom: `1px solid ${colors.border}` }}>
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
          <PageTitle icon={<Bell size={22} color="var(--color-icon-accent)" />}>
            {t('notificationRules.title')}
          </PageTitle>
          <p style={{ fontSize: fontSize.body, color: 'var(--color-slate)', margin: 0 }}>
            {t('notificationRules.description')}
          </p>
        </div>
        <button type="button"
          onClick={() => setShowDialog(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', backgroundColor: 'var(--color-brand)', color: colors.white,
            border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500,
            cursor: 'pointer', transition: 'background-color 150ms',
          }}
        >
          <Plus size={14} />
          {t('notificationRules.addRule')}
        </button>
      </div>

      {routingQuery.error ? (
        <QueryError message={routingQuery.error.message} onRetry={() => void routingQuery.refetch()} />
      ) : (loading && !data) || !routing ? (
        <div style={{ color: 'var(--color-slate-light)', fontSize: fontSize.body }}>{t('common.loading', 'Caricamento…')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {RULE_CATEGORIES.map(({ key, events }) => {
            const rules = events.map((e) => byEvent[e]).filter(Boolean) as NotificationRule[]
            if (!rules.length) return null
            return (
              <section key={key} aria-labelledby={`notification-rules-${key}`}>
                <h2 id={`notification-rules-${key}`} style={{
                  fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                  color: 'var(--color-slate-dark)', margin: '0 0 10px', paddingBottom: 8,
                  borderBottom: `2px solid ${colors.border}`,
                }}>
                  {t(`notificationRules.category.${key}`)}
                </h2>
                <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden', background: colors.white }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>{tableHeader}</thead>
                    <tbody>
                      {rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} routable={routableFor(routing, rule.eventType)} onUpdate={handleUpdate} onDelete={handleDelete} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}

          {/* Custom rules */}
          {customRules.length > 0 && (
            <section aria-labelledby="notification-rules-custom">
              <h2 id="notification-rules-custom" style={{
                fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                color: 'var(--color-slate-dark)', margin: '0 0 10px', paddingBottom: 8,
                borderBottom: `2px solid ${colors.border}`,
              }}>
                {t('notificationRules.category.custom')}
              </h2>
              <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden', background: colors.white }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>{tableHeader}</thead>
                  <tbody>
                    {customRules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} routable={routableFor(routing, rule.eventType)} onUpdate={handleUpdate} onDelete={handleDelete} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {showDialog && routing && (
        <NewRuleDialog
          routing={routing}
          onSave={handleCreate}
          onClose={() => setShowDialog(false)}
          saving={creating}
        />
      )}
    </PageContainer>
  )
}
