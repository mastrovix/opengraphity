/**
 * Create/edit modal state for CRUD pages (E-10): open flag, the item being
 * edited (null = create) and the form draft, with the three transitions every
 * page rewrote by hand (`openCreate`, `openEdit`, `close`).
 *
 *   const modal = useCrudModal<Team, TeamDraft>(EMPTY_DRAFT, (team) => ({ name: team.name, … }))
 *   <Button onClick={modal.openCreate}>Nuovo</Button>
 *   <Button onClick={() => modal.openEdit(row)}>Modifica</Button>
 *   <Modal open={modal.open} onClose={modal.close} title={modal.editing ? 'Modifica' : 'Nuovo'} …>
 *     <Input value={modal.draft.name} onChange={(e) => modal.patch({ name: e.target.value })} />
 *
 * `toDraft` may THROW (e.g. corrupt JSON stored in the item): the modal is
 * then not opened and the error is rethrown so the page can toast it — never
 * open an editor on silently-emptied data that a save would overwrite.
 */
import { useCallback, useState } from 'react'

export interface CrudModalState<TItem, TDraft> {
  open:       boolean
  /** Item being edited; `null` while creating (or closed). */
  editing:    TItem | null
  isEditing:  boolean
  draft:      TDraft
  setDraft:   (draft: TDraft | ((prev: TDraft) => TDraft)) => void
  /** Shallow-merge a partial into the draft. */
  patch:      (partial: Partial<TDraft>) => void
  openCreate: () => void
  openEdit:   (item: TItem) => void
  close:      () => void
}

export function useCrudModal<TItem, TDraft extends object>(
  emptyDraft: TDraft | (() => TDraft),
  toDraft:    (item: TItem) => TDraft,
): CrudModalState<TItem, TDraft> {
  const makeEmpty = useCallback(
    () => (typeof emptyDraft === 'function' ? (emptyDraft as () => TDraft)() : emptyDraft),
    [emptyDraft],
  )
  const [open, setOpen]       = useState(false)
  const [editing, setEditing] = useState<TItem | null>(null)
  const [draft, setDraft]     = useState<TDraft>(makeEmpty)

  const openCreate = useCallback(() => {
    setEditing(null)
    setDraft(makeEmpty())
    setOpen(true)
  }, [makeEmpty])

  const openEdit = useCallback((item: TItem) => {
    const next = toDraft(item) // may throw: caller handles (see header comment)
    setEditing(item)
    setDraft(next)
    setOpen(true)
  }, [toDraft])

  const close = useCallback(() => {
    setOpen(false)
    setEditing(null)
  }, [])

  const patch = useCallback((partial: Partial<TDraft>) => {
    setDraft((prev) => ({ ...prev, ...partial }))
  }, [])

  return { open, editing, isEditing: editing !== null, draft, setDraft, patch, openCreate, openEdit, close }
}
