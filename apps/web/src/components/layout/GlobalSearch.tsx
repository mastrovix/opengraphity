import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import {
  Search, Loader2, Server, GitPullRequest, AlertCircle, SearchCheck,
  ClipboardList, BookOpen,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { apolloClient } from '@/lib/apollo'
import { ciPath } from '@/lib/ciPath'

const GLOBAL_SEARCH = gql`
  query GlobalSearch($query: String!, $limit: Int) {
    globalSearch(query: $query, limit: $limit) {
      cis        { id name type }
      changes    { id code title }
      incidents  { id number title }
      problems   { id number title }
      tasks      { id code taskType status changeCode changeId ciName }
      kbArticles { id title slug }
    }
  }
`

interface SearchCI      { id: string; name: string; type: string | null }
interface SearchChange  { id: string; code: string; title: string }
interface SearchTicket  { id: string; number: string; title: string }
interface SearchTask    { id: string; code: string; taskType: string; status: string; changeCode: string; changeId: string; ciName: string }
interface SearchArticle { id: string; title: string; slug: string }

interface GlobalSearchResults {
  cis:        SearchCI[]
  changes:    SearchChange[]
  incidents:  SearchTicket[]
  problems:   SearchTicket[]
  tasks:      SearchTask[]
  kbArticles: SearchArticle[]
}

const EMPTY: GlobalSearchResults = { cis: [], changes: [], incidents: [], problems: [], tasks: [], kbArticles: [] }

interface FlatItem {
  key:      string
  route:    string
  primary:  string
  title:    string
  badge?:   string
}

interface Group {
  type:     keyof GlobalSearchResults
  icon:     LucideIcon
  items:    FlatItem[]
  startIdx: number
}

// Icone coerenti con la Sidebar (incidents/problems/changes/my-tasks/kb) + Server per i CI
const GROUP_ICONS: Record<keyof GlobalSearchResults, LucideIcon> = {
  cis:        Server,
  changes:    GitPullRequest,
  incidents:  AlertCircle,
  problems:   SearchCheck,
  tasks:      ClipboardList,
  kbArticles: BookOpen,
}

const GROUP_ORDER: (keyof GlobalSearchResults)[] = ['cis', 'changes', 'incidents', 'problems', 'tasks', 'kbArticles']

function toFlatItems(type: keyof GlobalSearchResults, results: GlobalSearchResults): FlatItem[] {
  switch (type) {
    case 'cis':
      return results.cis.map((ci) => ({
        key:     `ci-${ci.id}`,
        route:   ci.type ? ciPath({ id: ci.id, type: ci.type }) : `/ci/unknown/${ci.id}`,
        primary: ci.name,
        title:   ci.type ? ci.type.replace(/_/g, ' ') : '',
      }))
    case 'changes':
      return results.changes.map((c) => ({ key: `chg-${c.id}`, route: `/changes/${c.id}`, primary: c.code, title: c.title }))
    case 'incidents':
      return results.incidents.map((i) => ({ key: `inc-${i.id}`, route: `/incidents/${i.id}`, primary: i.number, title: i.title }))
    case 'problems':
      return results.problems.map((p) => ({ key: `prb-${p.id}`, route: `/problems/${p.id}`, primary: p.number, title: p.title }))
    case 'tasks':
      return results.tasks.map((t) => ({
        key:     `task-${t.id}`,
        route:   `/tasks/${t.id}`,
        primary: t.code,
        title:   t.taskType,
        badge:   t.changeCode,
      }))
    case 'kbArticles':
      return results.kbArticles.map((a) => ({ key: `kb-${a.id}`, route: `/knowledge-base/${a.slug}`, primary: '', title: a.title }))
  }
}

// ── colori allineati alla Topbar/Sidebar ──────────────────────────────────────
const C = {
  border:      '#2e3744',
  textDefault: '#e2e8f0',
  textMuted:   'var(--color-slate-light)',
  inputBg:     'rgba(255,255,255,0.06)',
}

export function GlobalSearch() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const rootRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  const [query, setQuery]             = useState('')
  const [results, setResults]         = useState<GlobalSearchResults>(EMPTY)
  const [loading, setLoading]         = useState(false)
  const [searched, setSearched]       = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [open, setOpen]               = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Cmd+K / Ctrl+K → focus sul box
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Chiudi il dropdown al click fuori
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // Ricerca con debounce 300ms, min 2 caratteri
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults(EMPTY)
      setLoading(false)
      setSearched(false)
      setSearchError(null)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      apolloClient
        .query<{ globalSearch: GlobalSearchResults }>({
          query:       GLOBAL_SEARCH,
          variables:   { query: trimmed, limit: 5 },
          fetchPolicy: 'network-only',
        })
        .then(({ data }) => {
          if (cancelled) return
          setResults(data?.globalSearch ?? EMPTY)
          setSelectedIdx(0)
          setSearched(true)
          setSearchError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setResults(EMPTY)
          setSearched(true)
          setSearchError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

  // Gruppi ordinati + lista piatta per la navigazione da tastiera
  const { groups, flat } = useMemo(() => {
    const flatList: FlatItem[] = []
    const grouped: Group[] = []
    for (const type of GROUP_ORDER) {
      const items = toFlatItems(type, results)
      if (items.length === 0) continue
      grouped.push({ type, icon: GROUP_ICONS[type], items, startIdx: flatList.length })
      flatList.push(...items)
    }
    return { groups: grouped, flat: flatList }
  }, [results])

  const openItem = useCallback((item: FlatItem) => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    navigate(item.route)
  }, [navigate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      inputRef.current?.blur()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => (flat.length === 0 ? 0 : Math.min(i + 1, flat.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[selectedIdx]
      if (item) openItem(item)
    }
  }, [flat, selectedIdx, openItem])

  // Mantieni visibile la riga selezionata durante la navigazione con le frecce
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const trimmed = query.trim()
  const showDropdown = open && trimmed.length >= 2

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* Search box */}
      <div
        style={{
          display:      'flex',
          alignItems:   'center',
          gap:          8,
          height:       32,
          width:        260,
          padding:      '0 10px',
          borderRadius: 6,
          border:       `1px solid ${C.border}`,
          background:   C.inputBg,
        }}
      >
        {loading
          ? <Loader2 size={14} className="animate-spin" style={{ color: C.textMuted, flexShrink: 0 }} />
          : <Search size={14} style={{ color: C.textMuted, flexShrink: 0 }} />}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          style={{
            flex:       1,
            minWidth:   0,
            border:     'none',
            outline:    'none',
            fontSize:   12,
            color:      C.textDefault,
            background: 'transparent',
          }}
        />
      </div>

      {/* Dropdown risultati */}
      {showDropdown && (
        <div
          role="listbox"
          style={{
            position:      'absolute',
            top:           38,
            right:         0,
            width:         440,
            maxHeight:     '60vh',
            overflowY:     'auto',
            background:    '#fff',
            border:        '1px solid #e5e7eb',
            borderRadius:  10,
            boxShadow:     '0 12px 40px rgba(0,0,0,0.2)',
            zIndex:        60,
            padding:       '4px 0',
          }}
          ref={listRef}
        >
          {!loading && searched && searchError && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: 'var(--color-danger, #ef4444)' }}>
              Errore di ricerca: {searchError}
            </div>
          )}

          {!loading && searched && !searchError && flat.length === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>
              {t('search.noResults', { query: trimmed })}
            </div>
          )}

          {!searched && flat.length === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>
              <Loader2 size={14} className="animate-spin" style={{ display: 'inline-block' }} />
            </div>
          )}

          {groups.map(({ type, icon: Icon, items, startIdx }) => (
            <div key={type}>
              <div
                style={{
                  display:       'flex',
                  alignItems:    'center',
                  gap:           6,
                  padding:       '8px 14px 4px',
                  fontSize:      10,
                  fontWeight:    700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color:         'var(--color-slate-light)',
                }}
              >
                <Icon size={12} />
                {t(`search.groups.${type}`)}
              </div>
              {items.map((item, i) => {
                const idx = startIdx + i
                const selected = idx === selectedIdx
                return (
                  <div
                    key={item.key}
                    data-idx={idx}
                    role="option"
                    aria-selected={selected}
                    onClick={() => openItem(item)}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    style={{
                      display:         'flex',
                      alignItems:      'center',
                      gap:             8,
                      padding:         '7px 14px',
                      cursor:          'pointer',
                      backgroundColor: selected ? '#f1f5f9' : 'transparent',
                      fontSize:        13,
                    }}
                  >
                    {item.primary && (
                      <span style={{ color: 'var(--color-slate-light)', fontWeight: 600, flexShrink: 0 }}>
                        {item.primary}
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
                      {item.title}
                    </span>
                    {item.badge && (
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
                        {item.badge}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
