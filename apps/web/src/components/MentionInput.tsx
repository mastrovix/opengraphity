import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@apollo/client/react'
import { SEARCH_USERS } from '@/graphql/queries'
import { alpha, colors, palette } from '@/lib/tokens'

interface UserSuggestion { id: string; name: string; email: string }

/**
 * WHAT THE FIELD SHOWS, WHAT IT KEEPS (tour of 24 Sep 2026, G15). The value
 * carries a mention as `@[Name](id)` — the id is what notifies the person —
 * and the field showed exactly that, the uuid included, until the comment was
 * sent. Now the field shows `@Name` and the value keeps the token: a mention
 * the writer edits into something else becomes plain text.
 */
const MENTION_TOKEN = /@\[([^\]]+)\]\(([^)\s]+)\)/g

/** The mentions a value carries, by the name the field shows. */
export function mentionsOf(value: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of value.matchAll(MENTION_TOKEN)) out.set(m[1]!, m[2]!)
  return out
}

/** The text the field shows: `@Name` for each mention token. */
export function mentionDisplay(value: string): string {
  return value.replace(MENTION_TOKEN, '@$1')
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Back from what the field shows to the value: each `@Name` of a known mention becomes its token again. */
export function mentionMarkup(display: string, mentions: ReadonlyMap<string, string>): string {
  if (mentions.size === 0) return display
  // Longest names first: «@Anna Maria» before «@Anna».
  const names = [...mentions.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const pattern = new RegExp(`@(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
  return display.replace(pattern, (_, name: string) => `@[${name}](${mentions.get(name)!})`)
}

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Il nome accessibile del campo (il segnaposto non lo è). */
  label?: string
  onSubmit?: () => void
  rows?: number
  style?: React.CSSProperties
}

export function MentionInput({ value, onChange, placeholder, label, onSubmit, rows = 3, style }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mentionState, setMentionState] = useState<{
    active: boolean
    startPos: number
    search: string
    dropdownPos: { top: number; left: number }
  }>({ active: false, startPos: 0, search: '', dropdownPos: { top: 0, left: 0 } })
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const { data } = useQuery<{ searchUsers: UserSuggestion[] }>(SEARCH_USERS, {
    variables: { search: debouncedSearch, limit: 5 },
    skip: !mentionState.active || debouncedSearch.length < 1,
  })

  const users: UserSuggestion[] = data?.searchUsers ?? []
  const display = mentionDisplay(value)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(mentionState.search), 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [mentionState.search])

  useEffect(() => { setSelectedIdx(0) }, [users.length])

  const computeDropdownPos = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return { top: 0, left: 0 }
    return { top: ta.offsetHeight + 2, left: 0 }
  }, [])

  // Positions are in the text the field shows.
  const insertMention = useCallback((user: { id: string; name: string }) => {
    const before = display.slice(0, mentionState.startPos)
    const after = display.slice(textareaRef.current?.selectionStart ?? mentionState.startPos + mentionState.search.length + 1)
    const mention = `@${user.name} `
    const mentions = new Map(mentionsOf(value)).set(user.name, user.id)
    onChange(mentionMarkup(before + mention + after, mentions))
    setMentionState(s => ({ ...s, active: false, search: '' }))
    setTimeout(() => {
      const pos = before.length + mention.length
      textareaRef.current?.setSelectionRange(pos, pos)
      textareaRef.current?.focus()
    }, 0)
  }, [value, display, onChange, mentionState.startPos, mentionState.search])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    onChange(mentionMarkup(v, mentionsOf(value)))
    const pos = e.target.selectionStart
    const textBefore = v.slice(0, pos)
    const atIdx = textBefore.lastIndexOf('@')
    if (atIdx >= 0) {
      const afterAt = textBefore.slice(atIdx + 1)
      if (!/\s/.test(afterAt) && (atIdx === 0 || /\s/.test(textBefore[atIdx - 1]))) {
        setMentionState({ active: true, startPos: atIdx, search: afterAt, dropdownPos: computeDropdownPos() })
        return
      }
    }
    if (mentionState.active) setMentionState(s => ({ ...s, active: false, search: '' }))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // D13: ⌘+Enter on a Mac, Ctrl+Enter elsewhere — both send.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit?.(); return }
    if (!mentionState.active) return
    if (e.key === 'Escape') { e.preventDefault(); setMentionState(s => ({ ...s, active: false })); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, users.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && users[selectedIdx]) { e.preventDefault(); insertMention(users[selectedIdx]) }
  }

  return (
    <div style={{ position: 'relative', ...style }}>
      <textarea
        ref={textareaRef}
        value={display}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        rows={rows}
        style={{ width: '100%', padding: 8, borderRadius: 6, border: `1px solid ${palette.neutral.borderStrong}`, resize: 'vertical', fontFamily: 'inherit', fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }}
      />
      {mentionState.active && users.length > 0 && (
        <div role="listbox" style={{
          position: 'absolute', top: mentionState.dropdownPos.top, left: mentionState.dropdownPos.left,
          zIndex: 100, background: colors.white, border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: `0 4px 12px ${alpha.black12}`, minWidth: 220, maxHeight: 200, overflowY: 'auto',
        }}>
          {users.map((u, i) => (
            <div
              key={u.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === selectedIdx}
              onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}
              style={{
                padding: '6px 10px', cursor: 'pointer', fontSize: 'var(--font-size-body)',
                background: i === selectedIdx ? palette.info.light : 'transparent',
              }}
            >
              <strong>{u.name}</strong>{' '}
              <span style={{ color: 'var(--color-slate)' }}>({u.email})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
