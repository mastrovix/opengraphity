/**
 * Shown when the viewer is not in the responsible team: lists team members
 * and lets the viewer send a reminder ping via SEND_TASK_REMINDER.
 */
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Bell } from 'lucide-react'
import { GET_TEAM_DETAIL } from '@/graphql/queries'
import { SEND_TASK_REMINDER } from '@/graphql/mutations'

export function TeamGatePanel({ teamId, taskId, assigneeId }: {
  teamId: string | null
  taskId: string
  assigneeId?: string | null
}) {
  const { data } = useQuery<{ team: { id: string; name: string; members: Array<{ id: string; name: string; email: string }> } | null }>(
    GET_TEAM_DETAIL, { variables: { id: teamId ?? '' }, skip: !teamId },
  )
  const [sendReminder, { loading: sending }] = useMutation(SEND_TASK_REMINDER, {
    onCompleted: () => toast.success('Sollecito inviato'),
    onError:     (e) => toast.error(e.message),
  })
  const team = data?.team
  if (!team) return null
  return (
    <div style={{ padding: 16, background: '#fef9f0', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 16 }}>
      <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-body)', color: '#92400e', fontWeight: 500 }}>
        Non sei nel team responsabile di questo task. Puoi sollecitare chi deve agire.
      </p>
      <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 8 }}>
        {team.name}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {team.members.map((m) => {
          const isAssigned = m.id === assigneeId
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #fde68a' }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', backgroundColor: 'var(--color-brand-light)',
                color: 'var(--color-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-size-label)', fontWeight: 700, flexShrink: 0,
              }}>
                {m.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <span style={{ flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: isAssigned ? 600 : 400 }}>
                {m.name}
              </span>
              {isAssigned && (
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, backgroundColor: 'var(--color-brand-light)', color: 'var(--color-brand)' }}>
                  Assegnato
                </span>
              )}
              <button
                type="button"
                disabled={sending}
                onClick={() => void sendReminder({ variables: { taskId, userId: m.id } })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 4, border: '1px solid #fde68a',
                  background: '#fff', cursor: sending ? 'not-allowed' : 'pointer',
                  fontSize: 'var(--font-size-label)', color: '#92400e', fontWeight: 500,
                }}
              >
                <Bell size={12} /> Sollecita
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
