/**
 * ASSESSMENT QUESTIONS: the questions a change assessment asks, their answers
 * and scores, and the CI types they are asked for.
 *
 * The answers feed the risk score of every change, so what matters here is
 * what reaches the API: the text trimmed, the answers in the order shown with
 * the ids of the ones that already exist (answers already given stay linked,
 * B-2), and a question that is not «always present» assigned to exactly the
 * CI types ticked, with the weight and position typed — saved when the field
 * is left, not at every keystroke (E-15). A question is deleted only after
 * confirming, and every refusal of the API is shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { QuestionAdminPage } from './QuestionAdminPage'

// The fake Apollo answers "not saving"; the mutations named here are held in flight.
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  return {
    ...m,
    useMutation: (...args: Parameters<typeof m.useMutation>) => {
      const [fn, r] = m.useMutation(...args)
      return [fn, inFlight.has(nomeOperazione(args[0])) ? { ...r, loading: true } : r]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

interface Option { id?: string; label: string; score: number; sortOrder: number }
interface Question { id: string; text: string; category: string; isCore: boolean; isActive: boolean; createdAt: string; options: Option[] }

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q-1', text: 'Is the change reversible?', category: 'functional', isCore: true, isActive: true, createdAt: '2026-09-01T00:00:00Z',
  options: [
    { id: 'o-1', label: 'Yes, in minutes', score: 1, sortOrder: 0 },
    { id: 'o-2', label: 'Only with a restore', score: 3, sortOrder: 1 },
    { id: 'o-3', label: 'No', score: 5, sortOrder: 2 },
  ],
  ...over,
})
const TECHNICAL = question({
  id: 'q-2', text: 'Is the database schema changed?', category: 'technical', isCore: false, isActive: false,
  options: [{ id: 'o-9', label: 'Yes', score: 4, sortOrder: 0 }, { id: 'o-10', label: 'No', score: 1, sortOrder: 1 }],
})
const CI_TYPES = [
  { id: 'ct-srv', name: 'server', label: 'Server', active: true },
  { id: 'ct-db', name: 'database', label: 'Database', active: true },
  { id: 'ct-mf', name: 'mainframe', label: 'Mainframe', active: false },
]

const questions = (...qs: Question[]) => { apolloFinto.risposte['GetQuestionsAdmin'] = { assessmentQuestionsAdmin: qs } }

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  questions(question(), TECHNICAL)
  apolloFinto.risposte['GetCITypes'] = { ciTypes: CI_TYPES }
  apolloFinto.risposte['GetQuestionCITypeAssignments'] = { questionCITypeAssignments: [] }
})

type User = ReturnType<typeof renderWithProviders>['user']

const mount = () => renderWithProviders(<QuestionAdminPage />)
const listItem = (text: string) => screen.getByRole('button', { name: new RegExp(text.replace(/[?]/g, '\\?')) })
const textField = () => screen.getByLabelText('Text')
const categoryField = () => screen.getByLabelText('Category')
const coreBox = () => screen.getByRole('checkbox', { name: 'Always present' })
const answer = (n: number) => screen.getByLabelText(`Answer ${n} text`)
const score = (n: number) => screen.getByLabelText(`Answer ${n} score`)
const save = () => screen.getByRole('button', { name: 'Save' })
const ciTypeBox = (name: string) => screen.getByRole('checkbox', { name: `Assign the question to CI type ${name}` })
const ciTypeRow = (name: string) => ciTypeBox(name).parentElement!
const sentOptions = (op: string) => (apolloFinto.chiamata(op)?.['input'] as { options: Option[] }).options

/** Types over the whole value of a number field, as a user who selects it first. */
async function overwrite(user: User, input: HTMLElement, value: string) {
  const current = (input as HTMLInputElement).value
  await user.type(input, value, { initialSelectionStart: 0, initialSelectionEnd: current.length })
}

async function open(user: User, text: string) {
  await user.click(listItem(text))
  await waitFor(() => expect(textField()).toHaveValue(text))
}

// ── The list ─────────────────────────────────────────────────────────────────

describe('the list of questions', () => {
  it('counts the questions and shows their category, «always present» and inactive badges', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'Questions (2)' })).toBeInTheDocument()
    const first = listItem('Is the change reversible?')
    expect(within(first).getByText('Functional')).toBeInTheDocument()
    expect(within(first).getByText('CORE')).toBeInTheDocument()
    expect(within(first).queryByText('INACTIVE')).toBeNull()
    const second = listItem('Is the database schema changed?')
    // The category in the viewer's language, not the stored value.
    expect(within(second).getByText('Technical')).toBeInTheDocument()
    expect(within(second).getByText('INACTIVE')).toBeInTheDocument()
    expect(within(second).queryByText('CORE')).toBeNull()
  })

  it('the category filter narrows the list, without caring about case, and the header says how many of how many', async () => {
    questions(question(), TECHNICAL, question({ id: 'q-3', text: 'Is a firewall rule added?', category: 'TECHNICAL' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user } = mount()
    await user.selectOptions(screen.getByLabelText('Filter questions by category'), 'technical')
    expect(screen.getByRole('heading', { name: 'Questions (2 / 3)' })).toBeInTheDocument()
    expect(screen.queryByText('Is the change reversible?')).toBeNull()
    expect(screen.getByText('Is a firewall rule added?')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Filter questions by category'), '')
    expect(screen.getByRole('heading', { name: 'Questions (3)' })).toBeInTheDocument()
  })

  it('a filter that keeps every question does not say "n / n"', async () => {
    questions(question(), question({ id: 'q-5', text: 'Is a rollback plan written?' }))
    const { user } = mount()
    await user.selectOptions(screen.getByLabelText('Filter questions by category'), 'functional')
    expect(screen.getByRole('heading', { name: 'Questions (2)' })).toBeInTheDocument()
  })

  it('a category outside the known two is flagged in red and logged, not shown as a normal pill', () => {
    questions(question({ category: 'legacy' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    const pill = within(listItem('Is the change reversible?')).getByText('legacy')
    expect(pill).toHaveStyle({ background: 'var(--color-danger)' })
    expect(error).toHaveBeenCalledWith('[CATEGORY_COLORS] unknown value: "legacy"')
  })

  it('with no question, says so, and the editor asks to pick or create one', () => {
    questions()
    mount()
    expect(screen.getByText('No question')).toBeInTheDocument()
    expect(screen.getByText('Pick a question, or create a new one')).toBeInTheDocument()
    expect(screen.queryByLabelText('Text')).toBeNull()
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('editing a question', () => {
  it('a question picked in the list opens in the editor, and is shown as selected', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    expect(listItem('Is the change reversible?')).toHaveAttribute('aria-pressed', 'true')
    expect(listItem('Is the database schema changed?')).toHaveAttribute('aria-pressed', 'false')
    expect(categoryField()).toHaveValue('functional')
    expect(within(categoryField()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Functional', 'Technical'])
    expect(coreBox()).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeChecked()
    expect([answer(1), answer(2), answer(3)].map((a) => (a as HTMLInputElement).value)).toEqual(['Yes, in minutes', 'Only with a restore', 'No'])
    expect(score(3)).toHaveValue(5)
    // Always present: assigned by itself to every CI type, so there is nothing to tick.
    expect(screen.getByText(/assigned by itself to every active CI type/)).toBeInTheDocument()
    expect(screen.queryByText('CI type assignments')).toBeNull()
    expect(apolloFinto.chiamate['GetQuestionCITypeAssignments']).toBeUndefined()
  })

  it('Save sends the text trimmed, the flags, and the answers with the ids of those that exist', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.clear(textField())
    await user.type(textField(), '  Can the change be rolled back?  ')
    await user.selectOptions(categoryField(), 'technical')
    await user.click(screen.getByRole('checkbox', { name: 'Active' }))
    await user.clear(answer(2))
    await user.type(answer(2), 'Only from a backup')
    await user.click(save())
    expect(apolloFinto.chiamata('UpdateAssessmentQuestion')).toEqual({ id: 'q-1', input: {
      text: 'Can the change be rolled back?', category: 'technical', isCore: true, isActive: false,
      options: [
        { id: 'o-1', label: 'Yes, in minutes', score: 1, sortOrder: 0 },
        { id: 'o-2', label: 'Only from a backup', score: 3, sortOrder: 1 },
        { id: 'o-3', label: 'No', score: 5, sortOrder: 2 },
      ],
    } })
    expect(toast.success).toHaveBeenCalledWith('Question updated')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('refuses to save without text, and without at least one answer', async () => {
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    await user.clear(textField())
    await user.type(textField(), '   ')
    await user.click(save())
    expect(toast.error).toHaveBeenLastCalledWith('Text is required')
    await user.type(textField(), 'Schema?')
    await user.click(screen.getByRole('button', { name: 'Remove answer 2' }))
    await user.click(screen.getByRole('button', { name: 'Remove answer 1' }))
    await user.click(save())
    expect(toast.error).toHaveBeenLastCalledWith('At least one option is required')
    expect(apolloFinto.chiamate['UpdateAssessmentQuestion']).toBeUndefined()
  })

  it('answers are moved, added and removed, and the order shown is the order sent', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    // The first answer cannot go up, the last cannot go down.
    expect(screen.getByRole('button', { name: 'Move answer 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move answer 3 down' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move answer 3 up' }))
    expect(answer(2)).toHaveValue('No')
    await user.click(screen.getByRole('button', { name: 'Move answer 1 down' }))
    expect(answer(1)).toHaveValue('No')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.type(answer(4), 'Partially')
    await overwrite(user, score(4), '2')
    await user.click(save())
    expect(sentOptions('UpdateAssessmentQuestion')).toEqual([
      { id: 'o-3', label: 'No', score: 5, sortOrder: 0 },
      { id: 'o-1', label: 'Yes, in minutes', score: 1, sortOrder: 1 },
      { id: 'o-2', label: 'Only with a restore', score: 3, sortOrder: 2 },
      // A new answer has no id: the API creates it.
      { label: 'Partially', score: 2, sortOrder: 3 },
    ])
  })

  it('removing an answer keeps the others in their order', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.click(screen.getByRole('button', { name: 'Remove answer 1' }))
    await user.click(save())
    expect(sentOptions('UpdateAssessmentQuestion').map((o) => o.id)).toEqual(['o-2', 'o-3'])
  })

  it('an emptied score, once left, is 1: the lowest score an answer can have', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.clear(score(3))
    await user.tab()
    expect(score(3)).toHaveValue(1)
    await user.click(save())
    expect(sentOptions('UpdateAssessmentQuestion')[2]).toEqual({ id: 'o-3', label: 'No', score: 1, sortOrder: 2 })
  })

  // Found by this test (tour of 23 Sep 2026), fixed: an emptied score snapped back to 1 AT ONCE, while
  // the field was still being edited, so clearing it and typing «4» gave 14. It now waits for the digit.
  it('clearing a score and typing a new one gives the number typed', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.clear(score(3))
    await user.type(score(3), '4')
    expect(score(3)).toHaveValue(4)
  })

  // Found by this test (tour of 23 Sep 2026), fixed: a new answer row started with score 0 — the value
  // the field's own `min={1}` and the API (`errors.question.scoreBelowOne`) refuse.
  it('a new answer starts at the lowest valid score, 1, not at 0', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New' }))
    expect(score(1)).toHaveValue(1)
    await open(user, 'Is the change reversible?')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(score(4)).toHaveValue(1)
  })

  // Found by this test (tour of 23 Sep 2026), fixed: after a removal the new answer took the position
  // of an existing one ([1, 2, 2]), and the two that tied came back from the API in any order.
  it('after removing an answer and adding one, every answer is saved with a position of its own', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.click(screen.getByRole('button', { name: 'Remove answer 1' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.type(answer(3), 'Partially')
    await user.click(save())
    const positions = sentOptions('UpdateAssessmentQuestion').map((o) => o.sortOrder)
    expect(new Set(positions).size).toBe(positions.length)
  })

  it('a refused update shows the reason and keeps what was typed', async () => {
    apolloFinto.esiti['UpdateAssessmentQuestion'] = { error: new Error('the score must be an integer of 1 or more') }
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.clear(textField())
    await user.type(textField(), 'Reversible?')
    await user.click(save())
    expect(toast.error).toHaveBeenCalledWith('the score must be an integer of 1 or more')
    expect(textField()).toHaveValue('Reversible?')
  })
})

// ── Always present, and CI types ─────────────────────────────────────────────

describe('always present, or assigned to CI types', () => {
  it('unticking «Always present» saves it at once and offers the active CI types to assign', async () => {
    const { user } = mount()
    await open(user, 'Is the change reversible?')
    await user.click(coreBox())
    expect(apolloFinto.chiamata('SetQuestionCore')).toEqual({ questionId: 'q-1', isCore: false })
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.getByText('CI type assignments')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetQuestionCITypeAssignments')).toEqual({ questionId: 'q-1' })
    expect(ciTypeRow('Server')).toHaveTextContent('Server')
    expect(ciTypeRow('Database')).toHaveTextContent('Database')
    // An inactive CI type is not offered.
    expect(screen.queryByRole('checkbox', { name: 'Assign the question to CI type Mainframe' })).toBeNull()
    await user.click(coreBox())
    expect(apolloFinto.chiamata('SetQuestionCore')).toEqual({ questionId: 'q-1', isCore: true })
    expect(screen.queryByText('CI type assignments')).toBeNull()
  })

  it('ticking a CI type assigns the question with weight 1, unticking removes it', async () => {
    apolloFinto.risposte['GetQuestionCITypeAssignments'] = { questionCITypeAssignments: [{ ciTypeId: 'ct-db', ciTypeName: 'database', weight: 2, sortOrder: 4 }] }
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    expect(ciTypeBox('Server')).not.toBeChecked()
    expect(ciTypeBox('Database')).toBeChecked()
    // Weight and position are shown only for an assigned type.
    expect(within(ciTypeRow('Server')).queryByTitle('Weight')).toBeNull()
    expect(within(ciTypeRow('Database')).getByTitle('Weight')).toHaveValue(2)
    expect(within(ciTypeRow('Database')).getByTitle('Sort order')).toHaveValue(4)
    await user.click(ciTypeBox('Server'))
    expect(apolloFinto.chiamata('AssignQuestionToCIType')).toEqual({ questionId: 'q-2', ciTypeId: 'ct-srv', weight: 1, sortOrder: 0 })
    await user.click(ciTypeBox('Database'))
    expect(apolloFinto.chiamata('RemoveQuestionFromCIType')).toEqual({ questionId: 'q-2', ciTypeId: 'ct-db' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  // Fixed on 23 Sep 2026: the checkbox was announced with the type's internal name («server»).
  it('a CI type is offered and announced with its label in the reader\'s language, not its internal name', async () => {
    apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ ...CI_TYPES[0], labels: [{ language: 'en', label: 'Physical server' }] }] }
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    expect(ciTypeRow('Physical server')).toHaveTextContent('Physical server')
    expect(screen.queryByRole('checkbox', { name: /CI type server$/ })).toBeNull()
  })

  it('weight and position are saved when the field is left, only when changed and valid', async () => {
    apolloFinto.risposte['GetQuestionCITypeAssignments'] = { questionCITypeAssignments: [{ ciTypeId: 'ct-db', ciTypeName: 'database', weight: 2, sortOrder: 4 }] }
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    const weight = within(ciTypeRow('Database')).getByTitle('Weight')
    const position = within(ciTypeRow('Database')).getByTitle('Sort order')
    // Typing does not save at every keystroke (E-15)...
    await user.clear(weight)
    await user.type(weight, '35')
    expect(apolloFinto.chiamate['AssignQuestionToCIType']).toBeUndefined()
    // ...Enter does, with the position the type already has.
    await user.keyboard('{Enter}')
    expect(apolloFinto.chiamate['AssignQuestionToCIType']).toEqual([{ questionId: 'q-2', ciTypeId: 'ct-db', weight: 35, sortOrder: 4 }])
    // A weight below 1, or no number at all, goes back to the saved value and is not sent.
    await user.clear(weight)
    await user.type(weight, '0')
    await user.tab()
    expect(weight).toHaveValue(2)
    await user.clear(weight)
    await user.tab()
    expect(weight).toHaveValue(2)
    // The same value is not sent again.
    await user.click(position)
    await user.tab()
    expect(apolloFinto.chiamate['AssignQuestionToCIType']).toHaveLength(1)
    await user.clear(position)
    await user.type(position, '0')
    await user.tab()
    expect(apolloFinto.chiamata('AssignQuestionToCIType')).toEqual({ questionId: 'q-2', ciTypeId: 'ct-db', weight: 2, sortOrder: 0 })
  })

  it('while an assignment is being saved, the CI type controls cannot be touched', async () => {
    apolloFinto.risposte['GetQuestionCITypeAssignments'] = { questionCITypeAssignments: [{ ciTypeId: 'ct-db', ciTypeName: 'database', weight: 2, sortOrder: 4 }] }
    inFlight.add('AssignQuestionToCIType')
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    expect(ciTypeBox('Server')).toBeDisabled()
    expect(within(ciTypeRow('Database')).getByTitle('Weight')).toBeDisabled()
    expect(within(ciTypeRow('Database')).getByTitle('Sort order')).toBeDisabled()
  })
})

// ── Creating ─────────────────────────────────────────────────────────────────

describe('creating a question', () => {
  it('New opens an empty editor: functional, always present, one empty answer, no Active switch and no Delete', async () => {
    const { user } = mount()
    await open(user, 'Is the database schema changed?')
    await user.click(screen.getByRole('button', { name: 'New' }))
    expect(textField()).toHaveValue('')
    expect(categoryField()).toHaveValue('functional')
    expect(coreBox()).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Active' })).toBeNull()
    expect(answer(1)).toHaveValue('')
    expect(screen.queryByLabelText('Answer 2 text')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    // No question of the list is selected any more.
    expect(listItem('Is the database schema changed?')).toHaveAttribute('aria-pressed', 'false')
  })

  it('a new question not always present must be saved before it can be assigned to CI types', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New' }))
    await user.click(coreBox())
    expect(screen.getByText('Save the question before assigning it to specific CI types.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Assign the question to CI type/ })).toBeNull()
    expect(apolloFinto.chiamate['SetQuestionCore']).toBeUndefined()
  })

  it('Save creates it, says so, and then shows it in the editor as a saved question', async () => {
    const created = question({ id: 'q-new', text: 'Does it need downtime?', category: 'technical', options: [{ id: 'o-n', label: 'Yes', score: 3, sortOrder: 0 }] })
    // The list read after the creation contains the new question.
    apolloFinto.risposte['GetQuestionsAdmin'] = () => ({
      assessmentQuestionsAdmin: apolloFinto.chiamate['CreateAssessmentQuestion'] ? [question(), created] : [question()],
    })
    apolloFinto.esiti['CreateAssessmentQuestion'] = { data: { createAssessmentQuestion: { id: 'q-new' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New' }))
    await user.type(textField(), '  Does it need downtime?  ')
    await user.selectOptions(categoryField(), 'technical')
    await user.type(answer(1), 'Yes')
    await overwrite(user, score(1), '3')
    await user.click(save())
    expect(apolloFinto.chiamata('CreateAssessmentQuestion')).toEqual({ input: {
      text: 'Does it need downtime?', category: 'technical', isCore: true,
      options: [{ label: 'Yes', score: 3, sortOrder: 0 }],
    } })
    expect(toast.success).toHaveBeenCalledWith('Question created')
    await waitFor(() => expect(listItem('Does it need downtime?')).toHaveAttribute('aria-pressed', 'true'))
    // Now a saved question: it can be switched off and deleted.
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('a refused creation shows the reason and keeps the new question in the editor', async () => {
    apolloFinto.esiti['CreateAssessmentQuestion'] = { error: new Error('One answer option has no text') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New' }))
    await user.type(textField(), 'Downtime?')
    await user.click(save())
    expect(toast.error).toHaveBeenCalledWith('One answer option has no text')
    expect(textField()).toHaveValue('Downtime?')
    expect(toast.success).not.toHaveBeenCalled()
  })
})

// ── Deleting ─────────────────────────────────────────────────────────────────

describe('deleting a question', () => {
  const askDelete = async (user: User) => {
    await open(user, 'Is the change reversible?')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Delete this question?')).toBeInTheDocument()
    expect(within(dialog).getByText('Not possible if answers are linked to it.')).toBeInTheDocument()
    return dialog
  }

  it('asks first; confirming deletes it and empties the editor', async () => {
    const { user } = mount()
    const dialog = await askDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteAssessmentQuestion')).toEqual({ id: 'q-1' }))
    expect(toast.success).toHaveBeenCalledWith('Question deleted')
    await waitFor(() => expect(screen.getByText('Pick a question, or create a new one')).toBeInTheDocument())
  })

  it('declining deletes nothing', async () => {
    const { user } = mount()
    const dialog = await askDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamate['DeleteAssessmentQuestion']).toBeUndefined()
    expect(textField()).toHaveValue('Is the change reversible?')
  })

  it('a refused delete shows the reason and keeps the question open', async () => {
    apolloFinto.esiti['DeleteAssessmentQuestion'] = { error: new Error('answers are linked to this question') }
    const { user } = mount()
    const dialog = await askDelete(user)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('answers are linked to this question'))
    expect(textField()).toHaveValue('Is the change reversible?')
  })
})
