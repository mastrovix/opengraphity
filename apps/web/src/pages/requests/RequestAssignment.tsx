/**
 * WHO WORKS ON A SERVICE REQUEST: A TEAM, THEN ONE OF ITS MEMBERS (D56, tour
 * of 23 Sep 2026).
 *
 * A request now has a team — at creation the fulfilment group of its catalog
 * item — and its assignee must be a member of that team: the API refuses
 * anyone else (`errors.assignment.notMember`). So the team is chosen among the
 * support teams (searchable, as on the incident), and the assignee among the
 * members of the request's team who can receive tickets. Without a team there
 * is nobody to choose yet, and the page says to assign a team first.
 *
 * What happens to the assignee when the team changes is the server's rule (it
 * stays if a member of the new team, it is detached otherwise): the page
 * reads the request again instead of guessing.
 */
import { useId, useState, type CSSProperties } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { DetailField } from '@/components/ui/DetailField'
import { Button } from '@/components/Button'
import { Select } from '@/components/ui/FormControls'
import { TeamPicker } from '@/components/pickers/TeamPicker'
import { TEAM_TYPE } from '@/lib/teamVocabularies'
import { GET_ASSIGNABLE_USERS } from '@/graphql/queries'
import { ASSIGN_SERVICE_REQUEST_TO_TEAM, ASSIGN_SERVICE_REQUEST_TO_USER } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { reloadQueries } from '@/lib/reloadQueries'

/**
 * Chi può ricevere una richiesta: le persone il cui ruolo ha `ticket.assignable`,
 * lo stesso permesso che l'API controlla (ondata 7); qui serve solo a non
 * offrire nella tendina chi verrebbe rifiutato.
 */
const ASSIGNABLE_PERMISSION = 'ticket.assignable'

interface Ref { id: string; name: string }
export interface AssignableUser { id: string; name: string; permissions: string[]; active: boolean; teams: Array<{ id: string }> }
export interface RequestAssignmentView { id: string; team: Ref | null; assignee: Ref | null; completedAt: string | null }

const column: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const note: CSSProperties = { fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }

/**
 * The people who can take the request: active (revisione totale · M-6),
 * allowed to receive tickets, and members of its team.
 */
export function membersWhoCanTake(users: readonly AssignableUser[], teamId: string): AssignableUser[] {
  return users.filter((u) => u.active && u.permissions.includes(ASSIGNABLE_PERMISSION) && u.teams.some((tm) => tm.id === teamId))
}

function TeamField({ request, onChanged }: { request: RequestAssignmentView; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const inputId = useId()
  const [choice, setChoice] = useState<Ref | null>(null)
  const [assignTeam, { loading }] = useMutation(ASSIGN_SERVICE_REQUEST_TO_TEAM, {
    onCompleted: () => { setChoice(null); toast.success(t('toast.request.teamAssigned')); reloadQueries(onChanged) },
    onError: (e) => showError(e),
  })
  const changed = choice !== null && choice.id !== request.team?.id
  return (
    <DetailField label={t('detail.team')} value={
      <div style={column}>
        <TeamPicker role={TEAM_TYPE.SUPPORT} inputId={inputId} label={t('detail.team')} value={choice ?? request.team} onChange={setChoice} />
        <Button variant="secondary" disabled={loading || !changed} onClick={() => { if (choice) void assignTeam({ variables: { id: request.id, teamId: choice.id } }) }}>
          {loading ? t('detail.assigning') : t('detail.assignTeam')}
        </Button>
      </div>
    } />
  )
}

function AssigneeField({ request, onChanged }: { request: RequestAssignmentView; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const selectId = useId()
  // Giro del 14 set 2026 (#41): la richiesta non si poteva assegnare.
  const { data, error } = useQuery<{ users: AssignableUser[] }>(GET_ASSIGNABLE_USERS, { skip: !request.team })
  const [choice, setChoice] = useState<string | null>(null)
  const [assignUser, { loading }] = useMutation(ASSIGN_SERVICE_REQUEST_TO_USER, {
    onCompleted: () => { setChoice(null); toast.success(t('toast.request.assigned')); reloadQueries(onChanged) },
    onError: (e) => showError(e),
  })
  if (!request.team) return <DetailField label={t('detail.assignee')} value={<span style={note}>{t('detail.assignTeamFirst')}</span>} />
  const members = membersWhoCanTake(data?.users ?? [], request.team.id)
  const current = request.assignee?.id ?? ''
  const chosen = choice ?? current
  // Someone assigned before the request had a team stays visible, not silently replaced by «nobody».
  const outsider = request.assignee && !members.some((m) => m.id === request.assignee?.id) ? request.assignee : null
  return (
    <DetailField label={t('detail.assignee')} value={
      <div style={column}>
        <Select id={selectId} aria-label={t('detail.assignee')} value={chosen} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{t('detail.unassign')}</option>
          {outsider && <option value={outsider.id}>{outsider.name}</option>}
          {members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        {error && <span role="alert" style={{ ...note, color: 'var(--color-danger)' }}>{t('detail.assigneesUnavailable', { error: error.message })}</span>}
        {data && members.length === 0 && <span style={note}>{t('detail.noTeamMembers')}</span>}
        <Button variant="secondary" disabled={loading || chosen === current} onClick={() => void assignUser({ variables: { id: request.id, userId: chosen || null } })}>
          {loading ? t('detail.assigning') : t('detail.assign')}
        </Button>
      </div>
    } />
  )
}

/** Team and assignee of a request: chosen while it is open, read once it is done. */
export function RequestAssignment({ request, onChanged }: { request: RequestAssignmentView; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation()
  if (request.completedAt) {
    return (
      <>
        <DetailField label={t('detail.team')} value={request.team?.name ?? null} />
        <DetailField label={t('detail.assignee')} value={request.assignee?.name ?? null} />
      </>
    )
  }
  return (
    <>
      <TeamField request={request} onChanged={onChanged} />
      <AssigneeField request={request} onChanged={onChanged} />
    </>
  )
}
