import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'

const SEARCH_USERS = gql`
  query SearchUsers($search: String!) {
    searchUsers(search: $search, limit: 5) { id name email }
  }
`

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onSubmit?: () => void
  rows?: number
  style?: React.CSSProperties
}

export function MentionInput({ value, onChange, placeholder, onSubmit, rows = 3, style }: Props) {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useQuery<any>(SEARCH_USERS, {
    variables: { search: debouncedSearch },
    skip: !mentionState.active || debouncedSearch.length < 1,
  })

  const users: { id: string; name: string; email: string }[] = data?.searchUsers ?? []

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

  const insertMention = useCallback((user: { id: string; name: string }) => {
    const before = value.slice(0, mentionState.startPos)
    const after = value.slice(textareaRef.current?.selectionStart ?? mentionState.startPos + mentionState.search.length + 1)
    const mention = `@[${user.name}](${user.id}) `
    onChange(before + mention + after)
    setMentionState(s => ({ ...s, active: false, search: '' }))
    setTimeout(() => {
      const pos = before.length + mention.length
      textareaRef.current?.setSelectionRange(pos, pos)
      textareaRef.current?.focus()
    }, 0)
  }, [value, onChange, mentionState.startPos, mentionState.search])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    onChange(v)
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
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); onSubmit?.(); return }
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
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical', fontFamily: 'inherit', fontSize: 14, boxSizing: 'border-box' }}
      />
      {mentionState.active && users.length > 0 && (
        <div style={{
          position: 'absolute', top: mentionState.dropdownPos.top, left: mentionState.dropdownPos.left,
          zIndex: 100, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,.12)', minWidth: 220, maxHeight: 200, overflowY: 'auto',
        }}>
          {users.map((u, i) => (
            <div
              key={u.id}
              onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}
              style={{
                padding: '6px 10px', cursor: 'pointer', fontSize: 13,
                background: i === selectedIdx ? '#f0f9ff' : 'transparent',
              }}
            >
              <strong>{u.name}</strong>{' '}
              <span style={{ color: '#6b7280' }}>({u.email})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
