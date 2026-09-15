import { useQuery, useMutation } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ClipboardList, UserPlus } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { colors, palette, lookupOrError } from '@/lib/tokens'
import { GET_MY_TASKS } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import { ASSIGN_ASSESSMENT_TASK_TO_USER } from '@/graphql/mutations'
import { TASK_STATUS, ASSESSMENT_ROLE } from '@/lib/taskStatus'
import { formatDate } from '@/lib/datetime'
import type { TFunction } from 'i18next'
import { showError } from '@/lib/showError'

interface MyTask {
  id:         string
  code:       string
  kind:       string
  role:       string
  action:     string
  status:     string
  changeId:   string
  changeCode: string
  ciId:       string
  ciName:     string
  phase:      string
  createdAt:  string
}

interface MyTasksResult {
  assignedToMe: MyTask[]
  unassigned:   MyTask[]
}

/** Chiavi, non etichette: la lingua la decide il client. */
const KIND_LABEL_KEY: Record<string, string> = {
  assessment:    'changeTasks.kind.assessment',
  'deploy-plan': 'changeTasks.kind.deployPlan',
  validation:    'changeTasks.kind.validation',
  deployment:    'changeTasks.kind.deployment',
  review:        'changeTasks.kind.review',
}

const KIND_COLOR: Record<string, { bg: string; color: string }> = {
  assessment:    { bg: palette.info.tint, color: colors.brand },
  'deploy-plan': { bg: palette.purple.tint, color: palette.purple.base },
  validation:    { bg: palette.warning.tint, color: palette.warning.text },
  deployment:    { bg: palette.success.tint, color: 'var(--color-success)' },
  review:        { bg: palette.info.tint, color: palette.info.text },
}

const STATE_COLOR: Record<string, { bg: string; color: string; labelKey: string }> = {
  pending:       { bg: colors.slateBg, color: 'var(--color-slate-light)', labelKey: 'changeTasks.state.todo' },
  'in-progress': { bg: palette.warning.tint, color: palette.warning.text, labelKey: 'changeTasks.dot.inProgress' },
  in_progress:   { bg: palette.warning.tint, color: palette.warning.text, labelKey: 'changeTasks.dot.inProgress' },
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatDate(iso)
}

function kindWithRole(task: MyTask, t: TFunction): string {
  if (task.kind === 'assessment') {
    return t(task.role === ASSESSMENT_ROLE.OWNER ? 'changeTasks.kind.assessmentFunctional' : 'changeTasks.kind.assessmentTechnical')
  }
  return KIND_LABEL_KEY[task.kind] ? t(KIND_LABEL_KEY[task.kind]!) : task.kind
}

interface TaskRowProps {
  task:            MyTask
  onClaim?:        () => void
  claimLoading?:   boolean
}

function TaskRow({ task, onClaim, claimLoading }: TaskRowProps) {
  const { t } = useTranslation()
  const kindColor  = lookupOrError(KIND_COLOR,  task.kind,   'KIND_COLOR',  KIND_COLOR['assessment']!)
  const stateColor = lookupOrError(STATE_COLOR, task.status, 'STATE_COLOR', STATE_COLOR[TASK_STATUS.PENDING]!)
  return (
    <div
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          12,
        padding:      '12px 0',
        borderBottom: `1px solid ${palette.neutral.borderLight}`,
      }}
    >
      <Link
        to={`/tasks/${task.id}`}
        style={{
          textDecoration: 'none',
          fontSize:        'var(--font-size-label)',
          fontWeight:      600,
          padding:         '3px 10px',
          borderRadius:    6,
          backgroundColor: kindColor.bg,
          color:           kindColor.color,
          textTransform:   'uppercase',
          flexShrink:      0,
          minWidth:        150,
          textAlign:       'center',
          cursor:          'pointer',
        }}
      >
        {kindWithRole(task, t)}
      </Link>
      <Link
        to={`/tasks/${task.id}`}
        style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}
      >
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
          <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginRight: 6 }}>{task.code}</span>
          {/* CH-5: l'azione nella lingua di chi legge, da tipo e ruolo dell'attività (l'API la dà in inglese). */}
          {t(`pages.myTasks.actionText.${task.kind === 'assessment' ? `assessment_${task.role}` : task.kind}`, { defaultValue: task.action })}
        </div>
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
          <strong style={{ color: 'var(--color-slate)' }}>{task.changeCode}</strong>
          {' · '}
          CI: <strong style={{ color: 'var(--color-slate)' }}>{task.ciName}</strong>
          {' · '}
          {t('changeTasks.createdOn', { date: fmtDate(task.createdAt) })}
        </div>
      </Link>
      <Pill bg={stateColor.bg} color={stateColor.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase', flexShrink: 0 }}>
        {t(stateColor.labelKey)}
      </Pill>
      {onClaim && (
        <button
          type="button"
          disabled={claimLoading}
          onClick={onClaim}
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             4,
            padding:         '6px 12px',
            borderRadius:    6,
            border:          'none',
            backgroundColor: 'var(--color-brand)',
            color:           colors.white,
            fontSize:        'var(--font-size-label)',
            fontWeight:      600,
            cursor:          claimLoading ? 'not-allowed' : 'pointer',
            opacity:         claimLoading ? 0.5 : 1,
            flexShrink:      0,
          }}
        >
          <UserPlus size={12} /> {t('pages.myTasks.takeIt')}
        </button>
      )}
    </div>
  )
}

function groupByChange(tasks: MyTask[]): Array<{ changeId: string; changeCode: string; tasks: MyTask[] }> {
  const m = new Map<string, { changeId: string; changeCode: string; tasks: MyTask[] }>()
  for (const t of tasks) {
    const g = m.get(t.changeCode) ?? { changeId: t.changeId, changeCode: t.changeCode, tasks: [] }
    g.tasks.push(t)
    m.set(t.changeCode, g)
  }
  return Array.from(m.values()).sort((a, b) => b.changeCode.localeCompare(a.changeCode))
}

export function MyTasksPage() {
  const { t } = useTranslation()
  const { me } = useMe()
  const currentUserId = me?.id ?? null

  const { data, loading, error, refetch } = useQuery<{ myTasks: MyTasksResult }>(GET_MY_TASKS, {
    fetchPolicy: 'cache-and-network',
  })

  const [claimTask, { loading: claiming }] = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER, {
    onCompleted: async () => { toast.success(t('toast.task.claimed')); await refetch() },
    onError:     (e) => showError(e),
  })

  const assignedToMe = data?.myTasks?.assignedToMe ?? []
  const unassigned   = data?.myTasks?.unassigned ?? []
  const total        = assignedToMe.length + unassigned.length

  const assignedGroups   = groupByChange(assignedToMe)
  const unassignedGroups = groupByChange(unassigned)

  const handleClaim = (task: MyTask) => {
    if (!currentUserId) { toast.error(t('toast.task.userUnknown')); return }
    if (task.kind !== 'assessment' && task.kind !== 'deploy-plan') return
    void claimTask({ variables: { taskId: task.id, userId: currentUserId } })
  }

  return (
    <PageContainer>
      <ListPageHeader
        icon={<ClipboardList size={22} color="var(--color-icon-accent)" />}
        title={t('sidebar.myTasks')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading && total === 0
              ? '—'
              : t('pages.myTasks.count', { total, mine: assignedToMe.length, free: unassigned.length })
            }
          </p>
        }
      />

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          {!loading && total === 0 && (
            <EmptyState
              icon={<ClipboardList size={32} />}
              title={t('pages.myTasks.emptyTitle')}
              description={t('pages.myTasks.emptyDescription')}
            />
          )}

          {/* ── Assegnati a me ── */}
          {assignedToMe.length > 0 && (
            <SectionCard title={t('pages.myTasks.assignedToMe')} count={assignedToMe.length} defaultOpen>
              {assignedGroups.map((g) => (
                <div key={g.changeId} style={{ marginBottom: 4 }}>
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                    />
                  ))}
                </div>
              ))}
            </SectionCard>
          )}

          {/* ── Da assegnare ── */}
          {unassigned.length > 0 && (
            <SectionCard title={t('pages.myTasks.unassigned')} count={unassigned.length} defaultOpen>
              {unassignedGroups.map((g) => (
                <div key={g.changeId} style={{ marginBottom: 4 }}>
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      onClaim={(t.kind === 'assessment' || t.kind === 'deploy-plan') ? () => handleClaim(t) : undefined}
                      claimLoading={claiming}
                    />
                  ))}
                </div>
              ))}
            </SectionCard>
          )}
        </>
      )}
    </PageContainer>
  )
}
