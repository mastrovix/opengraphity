import { useQuery, useMutation } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ClipboardList, UserPlus } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SectionCard } from '@/components/ui/SectionCard'
import { EmptyState } from '@/components/EmptyState'
import { lookupOrError } from '@/lib/tokens'
import { GET_MY_TASKS, GET_ME } from '@/graphql/queries'
import { ASSIGN_ASSESSMENT_TASK_TO_USER } from '@/graphql/mutations'

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

const KIND_LABEL: Record<string, string> = {
  assessment:    'Assessment',
  'deploy-plan': 'Piano Deploy',
  validation:    'Validation',
  deployment:    'Deployment',
  review:        'Review',
}

const KIND_COLOR: Record<string, { bg: string; color: string }> = {
  assessment:    { bg: '#dbeafe', color: '#2563eb' },
  'deploy-plan': { bg: '#ede9fe', color: '#7c3aed' },
  validation:    { bg: '#fef3c7', color: '#ca8a04' },
  deployment:    { bg: '#dcfce7', color: '#16a34a' },
  review:        { bg: '#e0f2fe', color: '#0369a1' },
}

const STATE_COLOR: Record<string, { bg: string; color: string; label: string }> = {
  pending:       { bg: '#f1f5f9', color: 'var(--color-slate-light)', label: 'Da fare' },
  'in-progress': { bg: '#fef3c7', color: '#b45309',                  label: 'In corso' },
  in_progress:   { bg: '#fef3c7', color: '#b45309',                  label: 'In corso' },
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return iso }
}

function kindWithRole(t: MyTask): string {
  if (t.kind === 'assessment') {
    return t.role === 'owner' ? 'Assessment Functional' : 'Assessment Technical'
  }
  return KIND_LABEL[t.kind] ?? t.kind
}

interface TaskRowProps {
  task:            MyTask
  onClaim?:        () => void
  claimLoading?:   boolean
}

function TaskRow({ task, onClaim, claimLoading }: TaskRowProps) {
  const kindColor  = lookupOrError(KIND_COLOR,  task.kind,   'KIND_COLOR',  KIND_COLOR['assessment']!)
  const stateColor = lookupOrError(STATE_COLOR, task.status, 'STATE_COLOR', STATE_COLOR['pending']!)
  return (
    <div
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          12,
        padding:      '12px 0',
        borderBottom: '1px solid #f3f4f6',
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
        {kindWithRole(task)}
      </Link>
      <Link
        to={`/tasks/${task.id}`}
        style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}
      >
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
          <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginRight: 6 }}>{task.code}</span>{task.action}
        </div>
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
          <strong style={{ color: 'var(--color-slate)' }}>{task.changeCode}</strong>
          {' · '}
          CI: <strong style={{ color: 'var(--color-slate)' }}>{task.ciName}</strong>
          {' · '}
          Creato il {fmtDate(task.createdAt)}
        </div>
      </Link>
      <span style={{
        fontSize:        'var(--font-size-label)',
        fontWeight:      600,
        padding:         '2px 8px',
        borderRadius:    6,
        backgroundColor: stateColor.bg,
        color:           stateColor.color,
        textTransform:   'uppercase',
        flexShrink:      0,
      }}>
        {stateColor.label}
      </span>
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
            color:           '#fff',
            fontSize:        'var(--font-size-label)',
            fontWeight:      600,
            cursor:          claimLoading ? 'not-allowed' : 'pointer',
            opacity:         claimLoading ? 0.5 : 1,
            flexShrink:      0,
          }}
        >
          <UserPlus size={12} /> Prendi in carico
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
  const { data: meData } = useQuery<{ me: { id: string } | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const currentUserId = meData?.me?.id ?? null

  const { data, loading, refetch } = useQuery<{ myTasks: MyTasksResult }>(GET_MY_TASKS, {
    fetchPolicy: 'cache-and-network',
  })

  const [claimTask, { loading: claiming }] = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER, {
    onCompleted: async () => { toast.success('Task presa in carico'); await refetch() },
    onError:     (e) => toast.error(e.message),
  })

  const assignedToMe = data?.myTasks?.assignedToMe ?? []
  const unassigned   = data?.myTasks?.unassigned ?? []
  const total        = assignedToMe.length + unassigned.length

  const assignedGroups   = groupByChange(assignedToMe)
  const unassignedGroups = groupByChange(unassigned)

  const handleClaim = (task: MyTask) => {
    if (!currentUserId) { toast.error('Utente non identificato'); return }
    if (task.kind !== 'assessment' && task.kind !== 'deploy-plan') return
    void claimTask({ variables: { taskId: task.id, userId: currentUserId } })
  }

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<ClipboardList size={22} color="var(--color-brand)" />}>
          I miei task
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '4px 0 0' }}>
          {loading && total === 0
            ? '—'
            : `${total} task (${assignedToMe.length} assegnati a te · ${unassigned.length} da prendere in carico)`
          }
        </p>
      </div>

      {!loading && total === 0 && (
        <EmptyState
          icon={<ClipboardList size={32} />}
          title="Nessun task per te"
          description="Quando un change entra in una fase che ti coinvolge, i task appariranno qui."
        />
      )}

      {/* ── Assegnati a me ── */}
      {assignedToMe.length > 0 && (
        <SectionCard title="Assegnati a me" count={assignedToMe.length} defaultOpen>
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
        <SectionCard title="Da assegnare" count={unassigned.length} defaultOpen>
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
    </PageContainer>
  )
}
