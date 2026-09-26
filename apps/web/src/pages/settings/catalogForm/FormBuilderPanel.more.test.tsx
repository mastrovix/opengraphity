/**
 * THE FORM BUILDER, part two: dragging, and designing with AI.
 *
 * Dragging is how most fields reach a form, and it is written by hand on
 * pointer and touch events, because HTML5 drag does not exist under a finger.
 * If it regresses, a field lands in the wrong section or position, one gesture
 * drops twice, a gesture meant to be cancelled moves something, or an iPad
 * cannot drag at all — which is how the owner found the first version broken.
 * jsdom has no layout, so the test plays the part of the browser's hit test:
 * `elementFromPoint` answers with the element the pointer is over.
 *
 * The AI designer creates fields in the shared library before anything lands;
 * the panel decides WHERE the proposed sections land. The mistake it must not
 * make is the one it once made: landing the design of a NEW request on
 * whatever form happened to be open, or on the next one opened after the
 * request was abandoned.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, screen, within, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { emptyCatalogForm } from '@opengraphity/types'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { Progetto } from './ProgettoAI'
import {
  ITEMS, LAPTOP_FORM, LIBRARY, afterMutation, answerForms, chooseItem, dropBoxOf, fieldsIn, libraryField, openItem,
  prepareApollo, publish, sectionOrder, withDictionary,
} from './__tests__/formBuilderFixtures'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FormBuilderPanel } = await import('./FormBuilderPanel')

/** What the pointer is over, as the browser's hit test would say. */
let underPointer: Element | null = null

beforeEach(() => {
  prepareApollo()
  toast.success.mockReset()
  toast.error.mockReset()
  toast.info.mockReset()
  underPointer = null
  document.elementFromPoint = vi.fn(() => underPointer)
})

/** Opens the panel on an item, with its stored form on the canvas. */
async function openOn(name = 'New laptop', ui = <FormBuilderPanel />) {
  const r = renderWithProviders(ui)
  await openItem(r.user, name)
  return r
}

function pointer(type: string, target: Element | Window, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent(target, new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true, button: 0, ...init,
  }))
}

/** A mouse drag: press on the grip, move over the target, release there. */
function drag(grip: Element, target: Element) {
  pointer('pointerdown', grip, 10, 300)
  underPointer = target
  pointer('pointermove', window, 40, 320)
  pointer('pointerup', window, 40, 320)
}

/** The label that follows the pointer (hidden from screen readers: it is only a picture of the gesture). */
const shadowOf = (text: string) => screen.queryAllByText(text).find((el) => el.getAttribute('aria-hidden') === 'true') ?? null

const fieldGrip = (label: string) => screen.getByRole('button', { name: new RegExp(`^Move «${label}»`) })
const sectionGrip = (title: string) => screen.getByRole('button', { name: new RegExp(`^Move the section «${title}»`) })
const libraryGrip = (label: string) => screen.getByRole('button', { name: `Drag «${label}» into a section` })

async function openLibrary(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: /^Library/ }))
}

describe('dragging with the mouse', () => {
  it('a library field dropped on a section goes to its end; dropped on a field, before that field', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    drag(libraryGrip('Budget'), dropBoxOf('Money'))
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])
    drag(libraryGrip('Laptop model'), screen.getByRole('button', { name: 'Urgent' }))
    expect(fieldsIn('Details')).toEqual(['Requester', 'Laptop model', 'Urgent'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('a field type dropped on the canvas asks for the new field, and it lands where the type fell', async () => {
    apolloFinto.risposte['GetFormFields'] = afterMutation('CreateFormField',
      { formFields: LIBRARY }, { formFields: [...LIBRARY, libraryField('due_date', 'date', 'Due date', { shared: false })] })
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-due_date' } } }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Field types/ }))

    drag(screen.getByRole('button', { name: 'Drag «Yes/no» into a section' }), dropBoxOf('Money'))
    expect(within(screen.getByRole('dialog', { name: 'New field · Yes/no' })).getByText('It will go into the «Money» section.')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    drag(screen.getByRole('button', { name: 'Drag «Date» into a section' }), screen.getByRole('button', { name: 'Urgent' }))
    const editor = screen.getByRole('dialog', { name: 'New field · Date' })
    expect(within(editor).getByText('It will go into the «Details» section.')).toBeInTheDocument()
    // Dropping creates nothing: the name of a field is forever, so it is asked for first.
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Due date')
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => expect(fieldsIn('Details')).toEqual(['Requester', 'Due date', 'Urgent']))
  })

  it('a field dropped in another section moves there; in its own section, before the field it is dropped on', async () => {
    await openOn()
    drag(fieldGrip('Requester'), dropBoxOf('Money'))
    expect(fieldsIn('Details')).toEqual(['Urgent'])
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Requester'])
    drag(fieldGrip('Requester'), screen.getByRole('button', { name: 'Cost centre' }))
    expect(fieldsIn('Money')).toEqual(['Requester', 'Cost centre'])
    // Down within its own section, to the end.
    drag(fieldGrip('Requester'), dropBoxOf('Money'))
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Requester'])
  })

  it('a field dropped on itself, or just below itself, stays, and nothing is marked as changed', async () => {
    await openOn()
    drag(fieldGrip('Requester'), screen.getByRole('button', { name: 'Requester' }))
    drag(fieldGrip('Requester'), screen.getByRole('button', { name: 'Urgent' }))
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
    expect(screen.queryByText('Changes not published yet')).toBeNull()
  })

  it('a section dropped on another one takes its place, on its header or anywhere inside it', async () => {
    await openOn()
    pointer('pointerdown', sectionGrip('Money'), 10, 300)
    underPointer = screen.getByRole('button', { name: 'Details' })
    pointer('pointermove', window, 20, 100)
    // The grip of the section it will take the place of lights up.
    expect(sectionGrip('Details').style.background).toContain('var(--color-brand-light)')
    pointer('pointerup', window, 20, 100)
    expect(sectionOrder()).toEqual(['Money', 'Details'])
    expect(sectionGrip('Details').style.background).not.toContain('var(--color-brand-light)')

    // Over one of its fields: a section is not dropped into a field, it takes that field's section.
    drag(sectionGrip('Money'), screen.getByRole('button', { name: 'Urgent' }))
    expect(sectionOrder()).toEqual(['Details', 'Money'])
    drag(sectionGrip('Details'), dropBoxOf('Details'))
    expect(sectionOrder()).toEqual(['Details', 'Money'])
  })

  it('a field dropped on a section header goes into that section, at its end', async () => {
    await openOn()
    drag(fieldGrip('Cost centre'), screen.getByRole('button', { name: 'Details' }))
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent', 'Cost centre'])
    expect(fieldsIn('Money')).toEqual([])
  })

  it('the dragged label follows the pointer, and the box under it is highlighted', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 100, 200)
    expect(shadowOf('Budget')).toHaveStyle({ left: '112px', top: '212px' })
    underPointer = dropBoxOf('Money')
    pointer('pointermove', window, 150, 260)
    expect(shadowOf('Budget')).toHaveStyle({ left: '162px', top: '272px' })
    expect(dropBoxOf('Money').style.border).toContain('var(--color-brand)')
    expect(dropBoxOf('Details').style.border).not.toContain('var(--color-brand)')
    pointer('pointerup', window, 150, 260)
    expect(shadowOf('Budget')).toBeNull()
    expect(dropBoxOf('Money').style.border).not.toContain('var(--color-brand)')
  })

  it('Escape, or a pointer the browser takes back, ends the drag without moving anything', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    underPointer = dropBoxOf('Money')
    pointer('pointermove', window, 40, 320)
    // Another key leaves the gesture alone.
    fireEvent.keyDown(window, { key: 'Shift' })
    expect(shadowOf('Budget')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(shadowOf('Budget')).toBeNull()
    pointer('pointerup', window, 40, 320)
    expect(fieldsIn('Money')).toEqual(['Cost centre'])

    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    pointer('pointermove', window, 40, 320)
    pointer('pointercancel', window, 40, 320)
    expect(shadowOf('Budget')).toBeNull()
    pointer('pointerup', window, 40, 320)
    expect(fieldsIn('Money')).toEqual(['Cost centre'])
    expect(screen.queryByText('Changes not published yet')).toBeNull()
  })

  it('a right click or a secondary pointer does not start a drag; a pen does', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 10, 300, { button: 2 })
    expect(shadowOf('Budget')).toBeNull()
    pointer('pointerdown', libraryGrip('Budget'), 10, 300, { isPrimary: false })
    expect(shadowOf('Budget')).toBeNull()

    pointer('pointerdown', libraryGrip('Budget'), 10, 300, { pointerType: 'pen' })
    expect(shadowOf('Budget')).not.toBeNull()
    underPointer = dropBoxOf('Money')
    pointer('pointermove', window, 40, 320, { pointerType: 'pen' })
    pointer('pointerup', window, 40, 320, { pointerType: 'pen' })
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])
  })

  it('released over nothing, it drops where the pointer last found a target; with none, nothing moves', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    // A fast gesture: the release point misses, the last move did not.
    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    underPointer = dropBoxOf('Money')
    pointer('pointermove', window, 40, 320)
    underPointer = null
    pointer('pointerup', window, 45, 330)
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])

    // Over the page but outside every section, from start to end.
    pointer('pointerdown', libraryGrip('Laptop model'), 10, 300)
    underPointer = document.body
    pointer('pointermove', window, 40, 320)
    pointer('pointerup', window, 40, 320)
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])
  })

  it('a drag that never ended is closed by the next one: one drop, not two', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    pointer('pointerdown', libraryGrip('Laptop model'), 10, 300)
    expect(shadowOf('Budget')).toBeNull()
    underPointer = dropBoxOf('Money')
    pointer('pointermove', window, 40, 320)
    pointer('pointerup', window, 40, 320)
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Laptop model'])
  })

  it('near the top and bottom edges the container of the form scrolls, and the target is read again', async () => {
    // The animation frames run when the test says so.
    const frames = new Map<number, FrameRequestCallback>()
    let lastId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.set(++lastId, cb); return lastId })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const runFrames = () => act(() => {
      const due = [...frames.values()]
      frames.clear()
      for (const cb of due) cb(0)
    })

    const { user } = renderWithProviders(<div data-testid="page" style={{ overflowY: 'auto' }}><FormBuilderPanel /></div>)
    const page = screen.getByTestId('page')
    Object.defineProperty(page, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(page, 'clientHeight', { configurable: true, value: 600 })
    let scrolled = 500
    Object.defineProperty(page, 'scrollTop', { configurable: true, get: () => scrolled, set: (v: number) => { scrolled = v } })
    await openItem(user, 'New laptop')
    await openLibrary(user)

    pointer('pointerdown', libraryGrip('Budget'), 100, 300)
    runFrames()
    expect(scrolled).toBe(500)
    underPointer = dropBoxOf('Details')
    pointer('pointermove', window, 100, 20)
    runFrames()
    expect(scrolled).toBe(488)
    // The pointer is still, the content moves under it: what is under it now is the target.
    underPointer = dropBoxOf('Money')
    runFrames()
    expect(scrolled).toBe(476)
    expect(dropBoxOf('Money').style.border).toContain('var(--color-brand)')
    pointer('pointermove', window, 100, window.innerHeight - 8)
    runFrames()
    expect(scrolled).toBe(488)
    pointer('pointerup', window, 100, window.innerHeight - 8)
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])
    // Nothing keeps scrolling after the drop.
    expect(frames.size).toBe(0)
  })

  it('an untitled section is carried by its position; with no section left, a field has nowhere to land', async () => {
    const { user } = await openOn('App access')
    pointer('pointerdown', sectionGrip('1'), 10, 300)
    expect(shadowOf('1')).not.toBeNull()
    pointer('pointerup', window, 10, 300)

    await user.click(screen.getByRole('button', { name: 'Section with no title' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Section properties' })).getByRole('button', { name: 'Remove this section' }))
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    expect(shadowOf('Budget')).not.toBeNull()
    underPointer = document.body
    pointer('pointermove', window, 40, 320)
    pointer('pointerup', window, 40, 320)
    expect(shadowOf('Budget')).toBeNull()
    expect(sectionOrder()).toEqual([])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('a drag still going when the panel goes away stops following the pointer', async () => {
    const { user, unmount } = await openOn()
    await openLibrary(user)
    pointer('pointerdown', libraryGrip('Budget'), 10, 300)
    unmount()
    vi.mocked(document.elementFromPoint).mockClear()
    pointer('pointermove', window, 40, 320)
    pointer('pointerup', window, 40, 320)
    expect(document.elementFromPoint).not.toHaveBeenCalled()
  })
})

describe('dragging with a finger', () => {
  it('touch events drive the drag, and the pointer events a finger also fires are ignored', async () => {
    const { user } = await openOn()
    await openLibrary(user)
    const grip = libraryGrip('Budget')
    pointer('pointerdown', grip, 10, 300, { pointerType: 'touch' })
    expect(shadowOf('Budget')).toBeNull()
    fireEvent.touchStart(grip, { touches: [{ clientX: 10, clientY: 300 }] })
    expect(shadowOf('Budget')).toHaveStyle({ left: '22px', top: '312px' })
    underPointer = dropBoxOf('Money')
    fireEvent.touchMove(window, { touches: [{ clientX: 30, clientY: 320 }] })
    expect(shadowOf('Budget')).toHaveStyle({ left: '42px', top: '332px' })
    // A move that carries no finger is not a move.
    fireEvent.touchMove(window, { touches: [] })
    expect(shadowOf('Budget')).toHaveStyle({ left: '42px', top: '332px' })
    // When the finger lifts it is only in `changedTouches`.
    fireEvent.touchEnd(window, { changedTouches: [{ clientX: 30, clientY: 320 }] })
    expect(shadowOf('Budget')).toBeNull()
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Budget'])
  })

  it('a field type is dragged with a finger too, and asks for the new field where it fell', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Field types/ }))
    fireEvent.touchStart(screen.getByRole('button', { name: 'Drag «Date» into a section' }), { touches: [{ clientX: 10, clientY: 300 }] })
    underPointer = dropBoxOf('Money')
    fireEvent.touchMove(window, { touches: [{ clientX: 30, clientY: 320 }] })
    fireEvent.touchEnd(window, { changedTouches: [{ clientX: 30, clientY: 320 }] })
    expect(within(screen.getByRole('dialog', { name: 'New field · Date' })).getByText('It will go into the «Money» section.')).toBeInTheDocument()
  })

  it('a touch with no finger starts nothing; one that ends without a point, or is cancelled, moves nothing', async () => {
    await openOn()
    fireEvent.touchStart(sectionGrip('Money'), { touches: [] })
    expect(shadowOf('Money')).toBeNull()

    underPointer = screen.getByRole('button', { name: 'Details' })
    fireEvent.touchStart(sectionGrip('Money'), { touches: [{ clientX: 10, clientY: 300 }] })
    expect(shadowOf('Money')).not.toBeNull()
    fireEvent.touchMove(window, { touches: [{ clientX: 10, clientY: 100 }] })
    fireEvent.touchEnd(window, { changedTouches: [] })
    expect(shadowOf('Money')).toBeNull()
    expect(sectionOrder()).toEqual(['Details', 'Money'])

    fireEvent.touchStart(sectionGrip('Money'), { touches: [{ clientX: 10, clientY: 300 }] })
    fireEvent.touchMove(window, { touches: [{ clientX: 10, clientY: 100 }] })
    fireEvent.touchCancel(window, {})
    expect(shadowOf('Money')).toBeNull()
    // The gesture is over: a late lift moves nothing.
    fireEvent.touchEnd(window, { changedTouches: [{ clientX: 10, clientY: 100 }] })
    expect(sectionOrder()).toEqual(['Details', 'Money'])

    // A finger that does finish on a section moves the dragged one there.
    fireEvent.touchStart(sectionGrip('Money'), { touches: [{ clientX: 10, clientY: 300 }] })
    fireEvent.touchMove(window, { touches: [{ clientX: 10, clientY: 100 }] })
    fireEvent.touchEnd(window, { changedTouches: [{ clientX: 10, clientY: 100 }] })
    expect(sectionOrder()).toEqual(['Money', 'Details'])
  })
})

describe('designing with AI', () => {
  const PROPOSAL: Progetto = {
    prompt: 'A laptop for a new hire, with the date it is needed by',
    maxFieldsPerForm: 40,
    item: null,
    // The id collides with a section already on the laptop form.
    sections: [{ id: 'money', titleIt: 'Consegna', titleEn: 'Delivery', columns: 1, items: [
      { field: 'budget', source: 'library', required: true, width: 'full', endUser: true, readOnly: false, visibleWhen: null, why: 'the cost' },
      { field: 'delivery_date', source: 'new', required: false, width: 'full', endUser: true, readOnly: false, visibleWhen: null, why: 'the date' },
    ] }],
    newFields: [{
      name: 'delivery_date', fieldType: 'date', labelIt: 'Data di consegna', labelEn: 'Delivery date', helpIt: null, helpEn: null,
      vocabulary: null, refTypes: [], formula: null, validationScript: null, why: 'the date',
    }],
    newVocabularies: [], discarded: [], notes: [],
  }
  const ITEM = {
    name: 'Laptop for interns', description: 'Two weeks loan', category: 'hardware', priority: null, requiresApproval: true,
    workflowDefinitionId: null, workflowDefinitionName: null, why: '',
  }

  function switchOn(proposal: Progetto = PROPOSAL) {
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { formDesigner: true } } }
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: proposal } }
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-delivery_date' } } }
    apolloFinto.risposte['GetFormFields'] = afterMutation('CreateFormField',
      { formFields: LIBRARY }, { formFields: [...LIBRARY, libraryField('delivery_date', 'date', 'Delivery date', { shared: false })] })
  }

  /** A new item the designer can create, with an empty form of its own. */
  function creatableItem(id: string, name: string) {
    apolloFinto.esiti['CreateServiceCatalogItem'] = { data: { createServiceCatalogItem: { id } } }
    apolloFinto.risposte['GetServiceCatalogAdmin'] = afterMutation('CreateServiceCatalogItem',
      { serviceCatalogItems: ITEMS }, { serviceCatalogItems: [...ITEMS, { id, name, active: true, category: null }] })
    answerForms({
      'i-laptop': { revision: 3, definition: LAPTOP_FORM },
      'i-access': { revision: 0, definition: emptyCatalogForm() },
      [id]: { revision: 0, definition: emptyCatalogForm() },
    })
  }

  async function designWithAI(user: UserEvent, buttonName: string) {
    await user.click(screen.getByRole('button', { name: buttonName }))
    const modal = screen.getByRole('dialog', { name: 'Describe the service request and I will design it' })
    await user.type(within(modal).getByRole('textbox', { name: 'What must this service request ask?' }), PROPOSAL.prompt)
    await user.click(within(modal).getByRole('button', { name: 'Design' }))
    await within(modal).findByText('You asked')
    return modal
  }

  it('the AI buttons are there only when the form designer is switched on', async () => {
    // Not known yet: no button, rather than a guess.
    apolloFinto.risposte['GetAISettings'] = undefined
    const unknown = await openOn()
    expect(screen.queryByRole('button', { name: /with AI/ })).toBeNull()
    unknown.unmount()
    const switchedOff = await openOn()
    expect(screen.queryByRole('button', { name: /with AI/ })).toBeNull()
    switchedOff.unmount()

    switchOn()
    const { user } = renderWithProviders(<FormBuilderPanel />)
    expect(screen.getByRole('button', { name: 'Design it with AI' })).toBeInTheDocument()
    // Adding fields needs a form to add them to.
    expect(screen.queryByRole('button', { name: 'Add fields with AI' })).toBeNull()
    await chooseItem(user, 'New laptop')
    await user.click(await screen.findByRole('button', { name: 'Add fields with AI' }))
    const modal = screen.getByRole('dialog', { name: 'Describe the service request and I will design it' })
    await user.click(within(modal).getByText('Cancel'))
    expect(screen.queryByRole('dialog', { name: /Describe the service request/ })).toBeNull()
    expect(apolloFinto.chiamate['ProposeServiceRequestDesign']).toBeUndefined()
  })

  it('adding fields to the open item: the fields are created, then the sections land on its canvas as a draft', async () => {
    switchOn()
    const { user } = await openOn()
    const modal = await designWithAI(user, 'Add fields with AI')
    expect(within(modal).getByText(/Write what «New laptop» is missing/)).toBeInTheDocument()
    expect(apolloFinto.chiamata('ProposeServiceRequestDesign')).toEqual({ prompt: PROPOSAL.prompt, itemId: 'i-laptop' })
    // A reused field reads as its library label, not as its technical name.
    expect(within(modal).getByText('Budget')).toBeInTheDocument()
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 fields added to the form: review them and publish when you are happy.'))
    await waitFor(() => expect(sectionOrder()).toEqual(['Details', 'Money', 'Delivery']))
    expect(screen.queryByRole('dialog', { name: /Describe the service request/ })).toBeNull()
    expect(fieldsIn('Delivery')).toEqual(['Budget', 'Delivery date'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()

    // The proposed id was taken on the canvas: renumbered, or the form would not save.
    const def = await publish(user)
    expect(def.sections.map((s) => s.id)).toEqual(['details', 'money', 'section_1'])
    expect(def.sections[2]).toEqual({
      id: 'section_1', title: { it: 'Consegna', en: 'Delivery' }, columns: 1, items: [
        { field: 'budget', required: true, width: 'full', endUser: true, readOnly: false },
        { field: 'delivery_date', required: false, width: 'full', endUser: true, readOnly: false },
      ],
    })
  })

  it('the design keeps the sections the administrator titled, and drops the empty untitled one a new form starts with', async () => {
    switchOn()
    const { user } = await openOn('App access')
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    await user.click(screen.getAllByRole('button', { name: 'Section with no title' })[1]!)
    const props = screen.getByRole('dialog', { name: 'Section properties' })
    await user.type(within(props).getByRole('textbox', { name: 'Section title (EN)' }), 'Extra')
    await user.click(within(props).getByRole('button', { name: 'Close' }))

    const modal = await designWithAI(user, 'Add fields with AI')
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))
    await waitFor(() => expect(sectionOrder()).toEqual(['Extra', 'Delivery']))
    expect(toast.success).toHaveBeenCalledWith('2 fields added to the form: review them and publish when you are happy.')
  })

  it('a NEW request: fields first, then the request is confirmed, and only then the design lands — on its own form', async () => {
    switchOn({ ...PROPOSAL, item: ITEM })
    creatableItem('i-interns', 'Laptop for interns')
    // Another item is open: the design must not land on it.
    const { user } = await openOn('New laptop', withDictionary(<FormBuilderPanel />))
    const modal = await designWithAI(user, 'Design it with AI')
    expect(within(modal).getByText(/Write what the request must ask/)).toBeInTheDocument()
    expect(apolloFinto.chiamata('ProposeServiceRequestDesign')).toEqual({ prompt: PROPOSAL.prompt, itemId: null })
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'One field created in the library. Now confirm the service request: the design lands in the form right after.'))
    // The request is proposed as the AI designed it; the priority it did not choose is left to choose.
    const itemDialog = await screen.findByRole('dialog', { name: 'New service request' })
    expect(within(itemDialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Laptop for interns')
    expect(within(itemDialog).getByRole('textbox', { name: 'Description (optional)' })).toHaveValue('Two weeks loan')
    expect(within(itemDialog).getByRole('combobox', { name: 'Category' })).toHaveValue('hardware')
    expect(within(itemDialog).getByRole('combobox', { name: 'Priority' })).toHaveValue('')
    expect(within(itemDialog).getByRole('checkbox', { name: 'Needs an approval' })).toBeChecked()
    expect(sectionOrder()).toEqual(['Details', 'Money'])

    await user.selectOptions(within(itemDialog).getByRole('combobox', { name: 'Priority' }), 'High')
    await user.click(within(itemDialog).getByRole('button', { name: 'Create and design' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-interns'))
    await waitFor(() => expect(sectionOrder()).toEqual(['Delivery']))
    expect(fieldsIn('Delivery')).toEqual(['Budget', 'Delivery date'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
    expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toEqual({ input: {
      name: 'Laptop for interns', description: 'Two weeks loan', category: 'hardware', priority: 'high', requiresApproval: true,
    } })
  })

  it('abandoning the new request says where the created fields are, and the design never lands on a later request', async () => {
    switchOn({ ...PROPOSAL, item: ITEM })
    creatableItem('i-badge', 'Badge')
    const { user } = await openOn('New laptop', withDictionary(<FormBuilderPanel />))
    const modal = await designWithAI(user, 'Design it with AI')
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'New service request' })).getByText('Cancel'))
    expect(toast.info).toHaveBeenCalledWith(
      'Service request not created: the field already added to the library stays there, in the «Field library» tab.')

    // Later, another request is created from scratch: it opens on its own empty form.
    await user.click(screen.getByRole('button', { name: 'New service request' }))
    const itemDialog = screen.getByRole('dialog', { name: 'New service request' })
    expect(within(itemDialog).getByRole('textbox', { name: 'Name' })).toHaveValue('')
    await user.type(within(itemDialog).getByRole('textbox', { name: 'Name' }), 'Badge')
    await user.selectOptions(within(itemDialog).getByRole('combobox', { name: 'Priority' }), 'Low')
    await user.click(within(itemDialog).getByRole('button', { name: 'Create and design' }))
    await waitFor(() => expect(sectionOrder()).toEqual(['1']))
    expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-badge')
    expect(screen.getByText('No form yet')).toBeInTheDocument()
    expect(screen.queryByText('Changes not published yet')).toBeNull()
    expect(sectionOrder()).toEqual(['1'])
  })

  it('abandoning the new request says so once, even when React runs the state updates twice', async () => {
    switchOn({ ...PROPOSAL, item: ITEM })
    creatableItem('i-badge', 'Badge')
    // StrictMode runs state updaters twice in development: a toast said inside one came out twice.
    const { user } = await openOn('New laptop', <StrictMode>{withDictionary(<FormBuilderPanel />)}</StrictMode>)
    const modal = await designWithAI(user, 'Design it with AI')
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'New service request' })).getByText('Cancel'))
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it('a NEW request gets its design even when the library cannot be read again, and says the new field shows by its name', async () => {
    switchOn({ ...PROPOSAL, item: ITEM })
    creatableItem('i-interns', 'Laptop for interns')
    // The library read before the design lands fails: it still lacks the field the AI created.
    apolloFinto.risposte['GetFormFields'] = { formFields: LIBRARY }
    const { user } = await openOn('New laptop', withDictionary(<FormBuilderPanel />))
    const modal = await designWithAI(user, 'Design it with AI')
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))
    const itemDialog = await screen.findByRole('dialog', { name: 'New service request' })
    await user.selectOptions(within(itemDialog).getByRole('combobox', { name: 'Priority' }), 'High')
    // The list of requests is read again first, and works; then the library, which does not.
    apolloFinto.refetch.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(new Error('offline'))
    await user.click(within(itemDialog).getByRole('button', { name: 'Create and design' }))

    // Nothing is pending any more: had it not landed now, the design would be lost.
    await waitFor(() => expect(sectionOrder()).toEqual(['Delivery']))
    expect(fieldsIn('Delivery')).toEqual(['Budget', 'delivery_date'])
    expect(toast.error).toHaveBeenCalledWith(
      'The field was created and is on the form, but the field library could not be refreshed: until it is, the form shows the field by its name.')
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('a design that created no field says nothing about abandoned fields when the request is dropped', async () => {
    const libraryOnly: Progetto = {
      ...PROPOSAL, newFields: [],
      sections: [{ ...PROPOSAL.sections[0]!, items: [PROPOSAL.sections[0]!.items[0]!] }],
    }
    switchOn(libraryOnly)
    const { user } = await openOn('New laptop', withDictionary(<FormBuilderPanel />))
    const modal = await designWithAI(user, 'Design it with AI')
    await user.click(within(modal).getByRole('button', { name: 'Add to the form' }))
    // No item in the proposal: the request starts blank.
    const itemDialog = await screen.findByRole('dialog', { name: 'New service request' })
    expect(within(itemDialog).getByRole('textbox', { name: 'Name' })).toHaveValue('')
    expect(within(itemDialog).getByRole('checkbox', { name: 'Needs an approval' })).not.toBeChecked()
    await user.click(within(itemDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'New service request' })).toBeNull()
    expect(toast.info).not.toHaveBeenCalled()
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()
  })
})
