/**
 * Watch/unwatch button + watchers list for entity detail pages.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { IS_WATCHING, GET_WATCHERS } from '@/graphql/queries'
import { WATCH_ENTITY, UNWATCH_ENTITY, ADD_WATCHER, REMOVE_WATCHER } from '@/graphql/mutations'
import { gql } from '@apollo/client'

const GET_USERS_WATCHER = gql`query GetUsersWatcher { users { id name email } }`

interface Props {
  entityType: string
  entityId:   string
}

export function WatcherBar({ entityType, entityId }: Props) {
  const [showList, setShowList] = useState(false)
  const [showAdd, setShowAdd]   = useState(false)

  const { data: watchingData, refetch: refetchWatching } = useQuery<{ isWatching: boolean }>(IS_WATCHING, { variables: { entityType, entityId } })
  const { data: watchersData, refetch: refetchWatchers } = useQuery<{ watchers: { id: string; name: string; email: string }[] }>(GET_WATCHERS, { variables: { entityType, entityId } })
  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS_WATCHER, { skip: !showAdd })

  const watching  = watchingData?.isWatching ?? false
  const watchersList = watchersData?.watchers ?? []
  const users = usersData?.users ?? []

  const [watch]    = useMutation(WATCH_ENTITY,   { onCompleted: () => { refetchWatching(); refetchWatchers(); toast.success('Ora stai osservando') } })
  const [unwatch]  = useMutation(UNWATCH_ENTITY, { onCompleted: () => { refetchWatching(); refetchWatchers(); toast.success('Non stai più osservando') } })
  const [add]      = useMutation(ADD_WATCHER,    { onCompleted: () => { refetchWatchers(); toast.success('Osservatore aggiunto') } })
  const [remove]   = useMutation(REMOVE_WATCHER, { onCompleted: () => { refetchWatchers(); toast.success('Osservatore rimosso') } })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      {/* Watch/Unwatch toggle */}
      <button
        onClick={() => {
          if (watching) unwatch({ variables: { entityType, entityId } })
          else watch({ variables: { entityType, entityId } })
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6,
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
          border: `1.5px solid ${watching ? 'var(--color-brand)' : '#e5e7eb'}`,
          background: watching ? '#e0f2fe' : '#fff',
          color: watching ? 'var(--color-brand)' : 'var(--color-slate)',
        }}
      >
        {watching ? <EyeOff size={14} /> : <Eye size={14} />}
        {watching ? 'Osservando' : 'Osserva'}
      </button>

      {/* Watchers count badge */}
      <button
        onClick={() => setShowList(!showList)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6,
          fontSize: 11, fontWeight: 600, cursor: 'pointer',
          border: '1px solid #e5e7eb', background: '#f9fafb', color: 'var(--color-slate)',
        }}
      >
        <Eye size={12} /> {watchersList.length}
      </button>

      {/* Watchers dropdown */}
      {showList && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', minWidth: 220, zIndex: 50,
          padding: 8,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 6, textTransform: 'uppercase' }}>
            Osservatori ({watchersList.length})
          </div>
          {watchersList.map(w => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12 }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--color-brand)' }}>
                {(w.name || w.email).charAt(0).toUpperCase()}
              </div>
              <span style={{ flex: 1, color: 'var(--color-slate-dark)' }}>{w.name || w.email}</span>
              <button onClick={() => remove({ variables: { entityType, entityId, userId: w.id } })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                <X size={12} color="#ef4444" />
              </button>
            </div>
          ))}
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, padding: '4px 0', fontSize: 11, color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
          >
            <Plus size={12} /> Aggiungi osservatore
          </button>
          {showAdd && (
            <div style={{ marginTop: 4, maxHeight: 120, overflowY: 'auto' }}>
              {users.filter(u => !watchersList.find(w => w.id === u.id)).map(u => (
                <div
                  key={u.id}
                  onClick={() => { add({ variables: { entityType, entityId, userId: u.id } }); setShowAdd(false) }}
                  style={{ padding: '4px 6px', cursor: 'pointer', fontSize: 12, borderRadius: 4 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f0f9ff' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  {u.name} <span style={{ color: 'var(--color-slate-light)' }}>({u.email})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
