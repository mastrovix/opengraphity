import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import { Search, Loader2 } from 'lucide-react'
import { apolloClient } from '@/lib/apollo'
import { ciPath } from '@/lib/ciPath'

const GLOBAL_SEARCH = gql`
  query GlobalSearch($query: String!, $limitPerType: Int) {
    globalSearch(query: $query, limitPerType: $limitPerType) {
      entityType
      id
      number
      title
      status
      ciType
      slug
    }
  }
`

interface SearchHit {
  entityType: string
  id: string
  number: string | null
  title: string
  status: string | null
  ciType: string | null
  slug: string | null
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const GROUP_ORDER = ['incident', 'change', 'problem', 'service_request', 'ci', 'kb_article']

function routeFor(hit: SearchHit): string {
  switch (hit.entityType) {
    case 'incident':        return `/incidents/${hit.id}`
    case 'change':          return `/changes/${hit.id}`
    case 'problem':         return `/problems/${hit.id}`
    case 'service_request': return `/requests/${hit.id}`
    case 'kb_article':      return `/knowledge-base/${hit.slug ?? hit.id}`
    case 'ci':              return hit.ciType ? ciPath({ id: hit.id, type: hit.ciType }) : `/ci/unknown/${hit.id}`
    default:                return '/'
  }
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  const [query, setQuery]         = useState('')
  const [hits, setHits]           = useState<SearchHit[]>([])
  const [loading, setLoading]     = useState(false)
  const [searched, setSearched]   = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Reset state each time the palette opens, then autofocus the input
  useEffect(() => {
    if (open) {
      setQuery('')
      setHits([])
      setLoading(false)
      setSearched(false)
      setSelectedIdx(0)
      // Focus after mount
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Debounced search
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setHits([])
      setLoading(false)
      setSearched(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      apolloClient
        .query<{ globalSearch: SearchHit[] }>({
          query:       GLOBAL_SEARCH,
          variables:   { query: trimmed, limitPerType: 5 },
          fetchPolicy: 'network-only',
        })
        .then(({ data }) => {
          if (cancelled) return
          setHits(data?.globalSearch ?? [])
          setSelectedIdx(0)
          setSearched(true)
        })
        .catch(() => {
          if (cancelled) return
          setHits([])
          setSearched(true)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, open])

  // Group hits by entityType, in a stable order — flat list preserved for keyboard nav
  const { groups, flat } = useMemo(() => {
    const byType = new Map<string, SearchHit[]>()
    for (const hit of hits) {
      const list = byType.get(hit.entityType) ?? []
      list.push(hit)
      byType.set(hit.entityType, list)
    }
    const orderedTypes = [
      ...GROUP_ORDER.filter((tp) => byType.has(tp)),
      ...[...byType.keys()].filter((tp) => !GROUP_ORDER.includes(tp)),
    ]
    const flatList: SearchHit[] = []
    const grouped = orderedTypes.map((type) => {
      const items = byType.get(type)!
      const startIdx = flatList.length
      flatList.push(...items)
      return { type, items, startIdx }
    })
    return { groups: grouped, flat: flatList }
  }, [hits])

  const openHit = useCallback((hit: SearchHit) => {
    onClose()
    navigate(routeFor(hit))
  }, [navigate, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => (flat.length === 0 ? 0 : Math.min(i + 1, flat.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = flat[selectedIdx]
      if (hit) openHit(hit)
    }
  }, [flat, selectedIdx, onClose, openHit])

  // Keep the selected row visible while navigating with arrows
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (!open) return null

  const trimmed = query.trim()

  return (
    <div
      style={{
        position:       'fixed',
        inset:          0,
        background:     'rgba(0,0,0,0.45)',
        zIndex:         1100,
        display:        'flex',
        justifyContent: 'center',
        alignItems:     'flex-start',
        paddingTop:     '12vh',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search.placeholder')}
        style={{
          background:    '#fff',
          borderRadius:  10,
          boxShadow:     '0 20px 60px rgba(0,0,0,0.25)',
          width:         560,
          maxWidth:      '90vw',
          maxHeight:     '60vh',
          overflow:      'hidden',
          display:       'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Input row */}
        <div
          style={{
            display:      'flex',
            alignItems:   'center',
            gap:          10,
            padding:      '14px 16px',
            borderBottom: '1px solid #e5e7eb',
            flexShrink:   0,
          }}
        >
          {loading
            ? <Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-slate-light)', flexShrink: 0 }} />
            : <Search size={16} style={{ color: 'var(--color-slate-light)', flexShrink: 0 }} />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            style={{
              flex:       1,
              border:     'none',
              outline:    'none',
              fontSize:   14,
              color:      'var(--color-slate-dark)',
              background: 'transparent',
            }}
          />
          <kbd
            style={{
              fontSize:     10,
              color:        'var(--color-slate-light)',
              border:       '1px solid #e5e7eb',
              borderRadius: 4,
              padding:      '2px 6px',
              background:   '#f8fafc',
              flexShrink:   0,
            }}
          >
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {trimmed.length < 2 && (
            <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>
              {t('search.typeToSearch')}
            </div>
          )}

          {trimmed.length >= 2 && !loading && searched && flat.length === 0 && (
            <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>
              {t('search.noResults')}
            </div>
          )}

          {groups.map(({ type, items, startIdx }) => (
            <div key={type}>
              <div
                style={{
                  padding:       '8px 16px 4px',
                  fontSize:      10,
                  fontWeight:    700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color:         'var(--color-slate-light)',
                }}
              >
                {t(`search.groups.${type}`, type)}
              </div>
              {items.map((hit, i) => {
                const idx = startIdx + i
                const selected = idx === selectedIdx
                return (
                  <div
                    key={`${hit.entityType}-${hit.id}`}
                    data-idx={idx}
                    onClick={() => openHit(hit)}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    style={{
                      display:         'flex',
                      alignItems:      'center',
                      gap:             8,
                      padding:         '8px 16px',
                      cursor:          'pointer',
                      backgroundColor: selected ? '#f1f5f9' : 'transparent',
                      fontSize:        13,
                    }}
                  >
                    {hit.number && (
                      <span style={{ color: 'var(--color-slate-light)', fontWeight: 600, flexShrink: 0 }}>
                        {hit.number}
                      </span>
                    )}
                    <span
                      style={{
                        color:        'var(--color-slate-dark)',
                        flex:         1,
                        whiteSpace:   'nowrap',
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {hit.title}
                    </span>
                    {hit.status && (
                      <span
                        style={{
                          fontSize:     10,
                          color:        'var(--color-slate-light)',
                          border:       '1px solid #e5e7eb',
                          borderRadius: 999,
                          padding:      '1px 8px',
                          flexShrink:   0,
                          whiteSpace:   'nowrap',
                        }}
                      >
                        {hit.status}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
