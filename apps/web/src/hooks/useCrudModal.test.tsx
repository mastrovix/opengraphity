/**
 * Every CRUD page opens its create/edit modal through this hook. If it
 * regresses, "New" opens pre-filled with the last edited item (and a save
 * would create a copy of it), or an item whose stored data cannot be turned
 * into a draft opens an editor on silently emptied fields that a save would
 * overwrite. These tests pin both, plus the draft editing helpers.
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCrudModal } from './useCrudModal'

interface Team { id: string; name: string; config: string }
interface Draft { name: string; tags: string[] }

const toDraft = (team: Team): Draft => ({ name: team.name, tags: JSON.parse(team.config) as string[] })
const TEAM: Team = { id: 't1', name: 'Network', config: '["core"]' }

describe('useCrudModal', () => {
  it('starts closed, with the empty draft and nothing being edited', () => {
    const { result } = renderHook(() => useCrudModal<Team, Draft>({ name: '', tags: [] }, toDraft))
    expect(result.current.open).toBe(false)
    expect(result.current.editing).toBeNull()
    expect(result.current.isEditing).toBe(false)
    expect(result.current.draft).toEqual({ name: '', tags: [] })
  })

  it('edit opens on the item\'s draft; create afterwards opens on a clean draft', () => {
    const { result } = renderHook(() => useCrudModal<Team, Draft>(() => ({ name: '', tags: [] }), toDraft))
    act(() => { result.current.openEdit(TEAM) })
    expect(result.current.open).toBe(true)
    expect(result.current.editing).toBe(TEAM)
    expect(result.current.isEditing).toBe(true)
    expect(result.current.draft).toEqual({ name: 'Network', tags: ['core'] })

    act(() => { result.current.close() })
    expect(result.current.open).toBe(false)
    expect(result.current.editing).toBeNull()

    act(() => { result.current.openCreate() })
    expect(result.current.open).toBe(true)
    expect(result.current.isEditing).toBe(false)
    // the previous edit must not leak into "New"
    expect(result.current.draft).toEqual({ name: '', tags: [] })
  })

  it('a factory empty draft gives a fresh object each time, so edits do not accumulate', () => {
    const { result } = renderHook(() => useCrudModal<Team, Draft>(() => ({ name: '', tags: [] }), toDraft))
    act(() => { result.current.openCreate() })
    const first = result.current.draft
    act(() => { result.current.patch({ name: 'typed' }) })
    act(() => { result.current.openCreate() })
    expect(result.current.draft).not.toBe(first)
    expect(result.current.draft.name).toBe('')
  })

  it('when the item cannot be turned into a draft, the error reaches the page and the modal stays closed', () => {
    const { result } = renderHook(() => useCrudModal<Team, Draft>({ name: '', tags: [] }, toDraft))
    expect(() => { act(() => { result.current.openEdit({ ...TEAM, config: '{corrupt' }) }) }).toThrow(SyntaxError)
    expect(result.current.open).toBe(false)
    expect(result.current.editing).toBeNull()
    expect(result.current.draft).toEqual({ name: '', tags: [] })
  })

  it('patch merges into the draft; setDraft replaces it or updates it from the previous one', () => {
    const { result } = renderHook(() => useCrudModal<Team, Draft>({ name: '', tags: [] }, toDraft))
    act(() => { result.current.openEdit(TEAM) })
    act(() => { result.current.patch({ name: 'Network Ops' }) })
    expect(result.current.draft).toEqual({ name: 'Network Ops', tags: ['core'] })
    act(() => { result.current.setDraft((prev) => ({ ...prev, tags: [...prev.tags, 'edge'] })) })
    expect(result.current.draft.tags).toEqual(['core', 'edge'])
    act(() => { result.current.setDraft({ name: 'x', tags: [] }) })
    expect(result.current.draft).toEqual({ name: 'x', tags: [] })
  })
})
