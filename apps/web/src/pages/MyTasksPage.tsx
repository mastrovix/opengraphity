import { Button } from '@/components/Button'
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
import { ASSIGN_ASSESSMENT_TASK_TO_USER, ASSIGN_DEPLOY_PLAN_TASK_TO_USER, CLAIM_TICKET_TASK } from '@/graphql/mutations'
import { TASK_STATUS, ASSESSMENT_ROLE } from '@/lib/taskStatus'
import { formatDate } from '@/lib/datetime'
import type { TFunction } from 'i18next'
import { showError } from '@/lib/showError'
import { reloadQueries } from '@/lib/reloadQueries'

interface MyTask {
  id:         string
  code:       string
  kind:       string
  role:       string
  action:     string
  status:     string
  /** Il tipo del ticket: decide dove porta il link. */
  entityType: string
  entityId:   string
  entityNumber: string
  /** Solo per i compiti delle change, che nascono per CI. */
  ciId:       string | null
  ciName:     string | null
  phase:      string
  createdAt:  string
}

/** Dove sta il ticket di un compito, per tipo. */
const PAGINA_DEL_TICKET: Record<string, string> = {
  incident:        '/incidents',
  problem:         '/problems',
  change:          '/changes',
  service_request: '/requests',
}

interface MyTasksResult {
  assignedToMe: MyTask[]
  unassigned:   MyTask[]
}

/** Chiavi, non etichette: la lingua la decide il client. */
const KIND_LABEL_KEY: Record<string, string> = {
  task:          'tasks.kindOne',
  assessment:    'changeTasks.kind.assessment',
  'deploy-plan': 'changeTasks.kind.deployPlan',
  validation:    'changeTasks.kind.validation',
  deployment:    'changeTasks.kind.deployment',
  review:        'changeTasks.kind.review',
}

const KIND_COLOR: Record<string, { bg: string; color: string }> = {
  task:          { bg: colors.slateBg, color: 'var(--color-slate-dark)' },
  assessment:    { bg: palette.info.tint, color: colors.brand },
  'deploy-plan': { bg: palette.purple.tint, color: palette.purple.base },
  validation:    { bg: palette.warning.tint, color: palette.warning.text },
  deployment:    { bg: palette.success.tint, color: 'var(--color-success)' },
  review:        { bg: palette.info.tint, color: palette.info.text },
}

const STATE_COLOR: Record<string, { bg: string; color: string; labelKey: string }> = {
  // Il compito generico è «aperto», non «pending»: è il suo ciclo di vita.
  open:          { bg: palette.info.tint, color: colors.brand, labelKey: 'tasks.state.open' },
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
  /**
   * Dove porta la riga. I compiti delle change hanno una pagina propria
   * (`/tasks/:id`, dove si compila l'assessment); il compito generico no — e
   * non gli serve: vive sul ticket, insieme agli altri suoi, e lì si chiude.
   */
  const dove = task.kind === 'task' ? (stradaDelTicket(task) ?? '/my-tasks') : `/tasks/${task.id}`
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
        to={dove}
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
        to={dove}
        style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}
      >
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
          <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginRight: 6 }}>{task.code}</span>
          {/* CH-5: l'azione nella lingua di chi legge, da tipo e ruolo dell'attività (l'API la dà in inglese). */}
          {/* Il compito generico porta il titolo che ha scritto chi ha
              disegnato il passo: dice già cosa c'è da fare, meglio di
              qualunque frase del prodotto. */}
          {task.kind === 'task'
            ? task.action
            : t(`pages.myTasks.actionText.${task.kind === 'assessment' ? `assessment_${task.role}` : task.kind}`, { defaultValue: task.action })}
        </div>
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
          {/* Il NUMERO del ticket non si ripete: sta in cima al gruppo, che è
              lì apposta. Il CI invece c'è solo sui compiti delle change, che
              nascono per CI — scrivere «CI: —» su un compito di una richiesta
              sarebbe inventarsi un dato mancante che mancante non è. */}
          {task.ciName && <>CI: <strong style={{ color: 'var(--color-slate)' }}>{task.ciName}</strong>{' · '}</>}
          {t('changeTasks.createdOn', { date: fmtDate(task.createdAt) })}
        </div>
      </Link>
      <Pill bg={stateColor.bg} color={stateColor.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase', flexShrink: 0 }}>
        {t(stateColor.labelKey)}
      </Pill>
      {onClaim && (
        <Button variant="primary"
          disabled={claimLoading}
          onClick={onClaim}
          style={{ flexShrink:      0 }}
        >
          <UserPlus size={12} /> {t('pages.myTasks.takeIt')}
        </Button>
      )}
    </div>
  )
}

/** Dove porta il numero del ticket, secondo il suo tipo. */
function stradaDelTicket(t: MyTask): string | null {
  const base = PAGINA_DEL_TICKET[t.entityType]
  return base ? `${base}/${t.entityId}` : null
}

/**
 * I compiti raggruppati per TICKET (prima era «per change»): dal 20 set 2026
 * la pagina elenca anche i compiti generici, che stanno su incident, problem
 * e richieste di servizio.
 */
function groupByTicket(tasks: MyTask[]): Array<{ entityNumber: string; strada: string | null; tasks: MyTask[] }> {
  const m = new Map<string, { entityNumber: string; strada: string | null; tasks: MyTask[] }>()
  for (const t of tasks) {
    const g = m.get(t.entityNumber) ?? { entityNumber: t.entityNumber, strada: stradaDelTicket(t), tasks: [] }
    g.tasks.push(t)
    m.set(t.entityNumber, g)
  }
  return Array.from(m.values()).sort((a, b) => b.entityNumber.localeCompare(a.entityNumber))
}

/**
 * I compiti di UN ticket, con il suo numero in cima (rimedio, 20 set 2026).
 *
 * Il raggruppamento c'era già ma non si vedeva: un `div` nudo. Con i soli
 * compiti di change non dava fastidio; da quando l'elenco mescola prefissi
 * diversi (`INC…`, `PRB…`, `CHG…`, `RICH-…`) le righe uscivano ordinate per
 * prefisso alfabetico e sembravano in ordine casuale. Il numero in cima
 * spiega l'ordine, e porta al ticket: `strada` era già calcolata e non la
 * usava nessuno.
 */
function IntestazioneDelTicket({ gruppo, children }: {
  gruppo: { entityNumber: string; strada: string | null; tasks: MyTask[] }
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', padding: '6px 0 2px' }}>
        {gruppo.strada
          ? <Link to={gruppo.strada} style={{ color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{gruppo.entityNumber}</Link>
          : gruppo.entityNumber}
      </div>
      {children}
    </div>
  )
}

export function MyTasksPage() {
  const { t } = useTranslation()
  const { me, can } = useMe()
  const currentUserId = me?.id ?? null

  const { data, loading, error, refetch } = useQuery<{ myTasks: MyTasksResult }>(GET_MY_TASKS, {
    fetchPolicy: 'cache-and-network',
  })

  const [claimTicketTask, { loading: prendendo }] = useMutation(CLAIM_TICKET_TASK, {
    onCompleted: () => { toast.success(t('toast.task.claimed')); reloadQueries(refetch) },
    onError:     (e) => showError(e),
  })

  const [claimAssessment, { loading: claimingAssessment }] = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER, {
    onCompleted: () => { toast.success(t('toast.task.claimed')); reloadQueries(refetch) },
    onError:     (e) => showError(e),
  })
  // A deploy plan is its own node, with its own mutation: the assessment one
  // answered NotFound on a deploy-plan id (review of 23 Sep 2026), as TaskViewPage knew.
  const [claimDeployPlan, { loading: claimingDeployPlan }] = useMutation(ASSIGN_DEPLOY_PLAN_TASK_TO_USER, {
    onCompleted: () => { toast.success(t('toast.task.claimed')); reloadQueries(refetch) },
    onError:     (e) => showError(e),
  })
  const claiming = claimingAssessment || claimingDeployPlan

  const assignedToMe = data?.myTasks?.assignedToMe ?? []
  const unassigned   = data?.myTasks?.unassigned ?? []
  const total        = assignedToMe.length + unassigned.length

  const assignedGroups   = groupByTicket(assignedToMe)
  const unassignedGroups = groupByTicket(unassigned)

  /**
   * «Lo prendo io». Due mutation diverse perché sono due nodi diversi: i
   * compiti delle change hanno la loro, i compiti generici la propria — che
   * non chiede l'utente, perché è sempre chi clicca.
   */
  const handleClaim = (task: MyTask) => {
    if (task.kind === 'task') { void claimTicketTask({ variables: { taskId: task.id } }); return }
    if (!currentUserId) { toast.error(t('toast.task.userUnknown')); return }
    if (task.kind === 'assessment') void claimAssessment({ variables: { taskId: task.id, userId: currentUserId } })
    else if (task.kind === 'deploy-plan') void claimDeployPlan({ variables: { taskId: task.id, userId: currentUserId } })
  }

  /**
   * Si può prendere: i compiti delle change che lo prevedono, e quelli
   * generici — ma solo se chi guarda può SCRIVERE quel tipo di ticket. Il
   * server lo pretende (`claimTicketTask` chiede `incident.write` e
   * compagnia), quindi offrire il pulsante a chi ha la sola lettura voleva
   * dire prometterglielo e poi dargli un errore.
   */
  const PERMESSO_SCRITTURA: Record<string, string> = {
    incident: 'incident.write', problem: 'problem.write',
    change: 'change.write', service_request: 'request.write',
  }
  const siPuoPrendere = (t: MyTask) => {
    if (t.kind === 'assessment' || t.kind === 'deploy-plan') return true
    if (t.kind !== 'task') return false
    const p = PERMESSO_SCRITTURA[t.entityType]
    return p !== undefined && can(p as Parameters<typeof can>[0])
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
                <IntestazioneDelTicket key={g.entityNumber} gruppo={g}>
                  {g.tasks.map((t) => <TaskRow key={t.id} task={t} />)}
                </IntestazioneDelTicket>
              ))}
            </SectionCard>
          )}

          {/* ── Da assegnare ── */}
          {unassigned.length > 0 && (
            <SectionCard title={t('pages.myTasks.unassigned')} count={unassigned.length} defaultOpen>
              {unassignedGroups.map((g) => (
                <IntestazioneDelTicket key={g.entityNumber} gruppo={g}>
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      onClaim={siPuoPrendere(t) ? () => handleClaim(t) : undefined}
                      claimLoading={claiming || prendendo}
                    />
                  ))}
                </IntestazioneDelTicket>
              ))}
            </SectionCard>
          )}
        </>
      )}
    </PageContainer>
  )
}
