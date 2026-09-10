/**
 * Watch/unwatch button + watchers list for entity detail pages.
 * The "add watcher" picker searches server-side (`searchUsers`) instead of
 * loading the whole user directory (E-17 / E-24).
 */
import { useEffect, useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { IS_WATCHING, GET_WATCHERS, SEARCH_USERS } from '@/graphql/queries'
import { WATCH_ENTITY, UNWATCH_ENTITY, ADD_WATCHER, REMOVE_WATCHER } from '@/graphql/mutations'
import { Input } from '@/components/ui/FormControls'
import { alpha, colors, palette } from '@/lib/tokens'

interface Props {
  entityType: string
  entityId:   string
}

interface UserSuggestion { id: string; name: string; email: string }

export function WatcherBar({ entityType, entityId }: Props) {
  const { t } = useTranslation()
  const [showList, setShowList] = useState(false)
  const [showAdd, setShowAdd]   = useState(false)
  const [search, setSearch]     = useState('')
  const [debounced, setDebounced] = useState('')
  const listId = useId()

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const { data: watchingData, refetch: refetchWatching } = useQuery<{ isWatching: boolean }>(IS_WATCHING, { variables: { entityType, entityId } })
  const { data: watchersData, refetch: refetchWatchers } = useQuery<{ watchers: { id: string; name: string; email: string }[] }>(GET_WATCHERS, { variables: { entityType, entityId } })
  const { data: searchData, loading: searching } = useQuery<{ searchUsers: UserSuggestion[] }>(SEARCH_USERS, {
    variables: { search: debounced, limit: 8 },
    skip: !showAdd || debounced.length < 2,
  })

  const watching     = watchingData?.isWatching ?? false
  const watchersList = watchersData?.watchers ?? []
  const suggestions  = (searchData?.searchUsers ?? []).filter(u => !watchersList.some(w => w.id === u.id))

  const onErr = (e: { message: string }) => toast.error(e.message)
  const [watch]    = useMutation(WATCH_ENTITY,   { onCompleted: () => { void refetchWatching(); void refetchWatchers(); toast.success(t('watchers.nowWatching')) }, onError: onErr })
  const [unwatch]  = useMutation(UNWATCH_ENTITY, { onCompleted: () => { void refetchWatching(); void refetchWatchers(); toast.success(t('watchers.stoppedWatching')) }, onError: onErr })
  const [add]      = useMutation(ADD_WATCHER,    { onCompleted: () => { void refetchWatchers(); toast.success(t('watchers.added')) }, onError: onErr })
  const [remove]   = useMutation(REMOVE_WATCHER, { onCompleted: () => { void refetchWatchers(); toast.success(t('watchers.removed')) }, onError: onErr })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      {/* Watch/Unwatch toggle */}
      <button
        type="button"
        aria-pressed={watching}
        onClick={() => {
          if (watching) void unwatch({ variables: { entityType, entityId } })
          else void watch({ variables: { entityType, entityId } })
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6,
          fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer',
          border: `1.5px solid ${watching ? 'var(--color-brand)' : 'var(--border)'}`,
          background: watching ? palette.info.tint : colors.white,
          color: watching ? 'var(--color-brand)' : 'var(--color-slate)',
        }}
      >
        {watching ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        {watching ? t('watchers.watching') : t('watchers.watch')}
      </button>

      {/* Watchers count badge */}
      <button
        type="button"
        aria-expanded={showList}
        aria-controls={listId}
        aria-label={t('watchers.listLabel', { count: watchersList.length })}
        onClick={() => setShowList(!showList)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6,
          fontSize: 'var(--font-size-table)', fontWeight: 600, cursor: 'pointer',
          border: '1px solid var(--border)', background: 'var(--color-slate-bg)', color: 'var(--color-slate)',
        }}
      >
        <Eye size={12} aria-hidden="true" /> {watchersList.length}
      </button>

      {/* Watchers dropdown */}
      {showList && (
        <div id={listId} style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          background: colors.white, border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: `0 4px 12px ${alpha.black10}`, minWidth: 240, zIndex: 50,
          padding: 8,
        }}>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 6, textTransform: 'uppercase' }}>
            {t('watchers.title')} ({watchersList.length})
          </div>
          {watchersList.map(w => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 'var(--font-size-body)' }}>
              <div aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', background: palette.info.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-brand)' }}>
                {(w.name || w.email).charAt(0).toUpperCase()}
              </div>
              <span style={{ flex: 1, color: 'var(--color-slate-dark)' }}>{w.name || w.email}</span>
              <button
                type="button"
                aria-label={t('watchers.remove', { name: w.name || w.email })}
                title={t('watchers.remove', { name: w.name || w.email })}
                onClick={() => void remove({ variables: { entityType, entityId, userId: w.id } })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
              >
                <X size={12} color="var(--color-danger)" aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-expanded={showAdd}
            onClick={() => { setShowAdd(!showAdd); setSearch('') }}
            style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, padding: '4px 0', fontSize: 'var(--font-size-table)', color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
          >
            <Plus size={12} aria-hidden="true" /> {t('watchers.add')}
          </button>
          {showAdd && (
            <div style={{ marginTop: 4 }}>
              <Input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- campo di ricerca montato dopo il click su "Aggiungi": il focus segue l'azione dell'utente
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('watchers.searchPlaceholder')}
                aria-label={t('watchers.searchPlaceholder')}
                style={{ marginBottom: 4 }}
              />
              <div style={{ maxHeight: 140, overflowY: 'auto' }}>
                {debounced.length < 2 && (
                  <div style={{ padding: '4px 6px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('watchers.typeToSearch')}</div>
                )}
                {debounced.length >= 2 && !searching && suggestions.length === 0 && (
                  <div style={{ padding: '4px 6px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('common.noResults')}</div>
                )}
                {suggestions.map(u => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => { void add({ variables: { entityType, entityId, userId: u.id } }); setShowAdd(false); setSearch('') }}
                    className="hover-bg"
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 6px', cursor: 'pointer', fontSize: 'var(--font-size-body)', borderRadius: 4, background: 'none', border: 'none', ['--hover-bg' as string]: palette.info.light }}
                  >
                    {u.name} <span style={{ color: 'var(--color-slate-light)' }}>({u.email})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
