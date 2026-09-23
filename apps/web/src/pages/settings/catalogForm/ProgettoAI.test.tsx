/**
 * «DESCRIBE THE SERVICE REQUEST AND I WILL DESIGN IT»: the AI designer's modal.
 *
 * Three steps: a description; a review of the proposal, where every field says
 * WHY it is there, whether it is reused or new, and the code it would run;
 * the acceptance, which creates the value lists and the fields in the shared
 * library and only then hands the design to the canvas. What must not regress:
 *  - nothing is created before «Add to the form»: a proposal looked at and
 *    dropped leaves no orphan fields in the library;
 *  - value lists are created before the fields that read them;
 *  - the creation stops at the first refusal and says what WAS created, and
 *    the canvas is not touched — a form citing a missing field cannot be saved;
 *  - the closing message says where the design went (on the canvas, or
 *    waiting for the request to be created): saying «on the canvas» when it is
 *    not sends people looking for fields that are not there;
 *  - a failed proposal keeps the description: nobody retypes three lines.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { Progetto } from './ProgettoAI'

/** Every mutation call, in the order it was made; and outcomes queued call by call. */
const callLog = vi.hoisted(() => ({ order: [] as string[], queued: {} as Record<string, Array<{ data?: unknown; error?: Error }>> }))

/*
 * Apollo Client 4 calls a mutation's `onError` AND rejects its promise
 * (`react/hooks/useMutation.js`); the shared fake resolves instead. The
 * modal's «stop at the first refusal» only exists on the rejecting path, so
 * here a refused mutation rejects, as it does in the app.
 */
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, apolloFinto: fake, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  type Execute = (o?: Record<string, unknown>) => Promise<{ data?: unknown; errors?: Error[] }>
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts?: Parameters<typeof base.useMutation>[1]) => {
      const name = nomeOperazione(doc)
      const [execute, state] = base.useMutation(doc, opts) as unknown as [Execute, unknown]
      const likeApollo4 = async (o?: Record<string, unknown>) => {
        callLog.order.push(name)
        const next = callLog.queued[name]?.shift()
        if (next) fake.esiti[name] = next
        const r = await execute(o)
        if (r.errors?.[0]) throw r.errors[0]
        return r
      }
      return [likeApollo4, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ModaleProgettoAI } = await import('./ProgettoAI')

const PROPOSAL: Progetto = {
  prompt: 'A new laptop: the model, the cost centre, and the total',
  maxFieldsPerForm: 40,
  item: {
    name: 'New laptop', description: 'For new hires', category: 'hardware', priority: 'high', requiresApproval: true,
    workflowDefinitionId: 'wf-1', workflowDefinitionName: 'Hardware road', why: 'from «a new laptop»',
  },
  sections: [
    { id: 'ai_1', titleIt: 'Il portatile', titleEn: 'The laptop', columns: 2, items: [
      { field: 'total', source: 'new', required: false, width: 'half', endUser: true, readOnly: false, visibleWhen: null, why: 'from «the total»' },
      { field: 'cost_centre', source: 'library', required: false, width: 'half', endUser: false, readOnly: true,
        visibleWhen: '{"match":"all","rules":[{"field":"total","op":"filled"}]}', why: '   ' },
    ] },
    { id: 'ai_2', titleIt: '', titleEn: 'Choice', columns: 1, items: [
      { field: 'laptop_model', source: 'new', required: true, width: 'full', endUser: true, readOnly: false, visibleWhen: null, why: 'from «the model»' },
    ] },
  ],
  newFields: [
    { name: 'total', fieldType: 'number', labelIt: '', labelEn: 'Total', helpIt: null, helpEn: null, vocabulary: null, refTypes: [],
      formula: 'return input.price * 2', validationScript: null, why: '' },
    { name: 'laptop_model', fieldType: 'enum', labelIt: 'Modello', labelEn: 'Model', helpIt: 'Scegli il modello', helpEn: null,
      vocabulary: 'laptop_models', refTypes: [], formula: null, validationScript: 'if (!value) throw new Error("Pick one")', why: '' },
  ],
  newVocabularies: [{ name: 'laptop_models', label: 'Laptop models', values: ['basic', 'pro'], why: '' }],
  discarded: [{ what: 'Regions', key: 'proposal.discard.vocabularyUnknown', params: '{"name":"regions"}' }],
  notes: ['I did not design a table'],
}

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  callLog.order.length = 0
  for (const k of Object.keys(callLog.queued)) delete callLog.queued[k]
  apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: PROPOSAL } }
  apolloFinto.esiti['CreateEnumType'] = { data: { createEnumType: { name: 'laptop_models' } } }
  apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-new' } } }
})

function openModal(props: Partial<Parameters<typeof ModaleProgettoAI>[0]> = {}) {
  const onClose = vi.fn()
  const onApplied = props.onApplicato ?? vi.fn(async (_p: Progetto) => 'done' as const)
  const r = renderWithProviders(
    <ModaleProgettoAI itemId="i-laptop" nomeVoce="New laptop" etichettaDi={(n) => (n === 'cost_centre' ? 'Cost centre' : n)}
      onChiudi={onClose} {...props} onApplicato={onApplied} />,
  )
  return { ...r, onClose, onApplied }
}

const modal = () => screen.getByRole('dialog', { name: 'Describe the service request and I will design it' })

async function submitDescription(user: UserEvent, text = PROPOSAL.prompt) {
  await user.type(within(modal()).getByRole('textbox', { name: 'What must this service request ask?' }), text)
  await user.click(within(modal()).getByRole('button', { name: 'Design' }))
}

describe('ModaleProgettoAI: the description', () => {
  it('says whether it designs a new request or adds to an existing one', () => {
    const { unmount } = openModal({ itemId: null, nomeVoce: null })
    expect(screen.getByText(/Write what the request must ask/)).toBeInTheDocument()
    unmount()
    openModal()
    expect(screen.getByText(/Write what «New laptop» is missing/)).toBeInTheDocument()
  })

  it('needs at least ten characters that are not blanks; Cancel closes without asking anything', async () => {
    const { user, onClose } = openModal()
    const designButton = within(modal()).getByRole('button', { name: 'Design' })
    expect(designButton).toBeDisabled()
    const box = within(modal()).getByRole('textbox', { name: 'What must this service request ask?' })
    await user.type(box, '    laptop    ')
    expect(designButton).toBeDisabled()
    await user.type(box, 'for Ada')
    expect(designButton).toBeEnabled()
    await user.click(within(modal()).getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(callLog.order).toEqual([])
  })

  it('sends the trimmed description with the item, and creates nothing yet', async () => {
    const { user } = openModal()
    await submitDescription(user, `  ${PROPOSAL.prompt}  `)
    expect(await within(modal()).findByText('You asked')).toBeInTheDocument()
    expect(apolloFinto.chiamata('ProposeServiceRequestDesign')).toEqual({ prompt: PROPOSAL.prompt, itemId: 'i-laptop' })
    expect(callLog.order).toEqual(['ProposeServiceRequestDesign'])
  })

  /*
   * There is no «empty proposal» to test: the schema makes it non-null, so the
   * real client rejects instead of resolving with nothing (the null check that
   * handled it only ever ran against the fake; removed on 23 Sep 2026).
   */
  it('a refused proposal keeps the description, to try again', async () => {
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { error: new Error('The AI is not configured') }
    const { user } = openModal()
    await submitDescription(user)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The AI is not configured'))
    expect(within(modal()).getByRole('textbox', { name: 'What must this service request ask?' })).toHaveValue(PROPOSAL.prompt)
    // Still on the description, and it can be sent again.
    expect(within(modal()).queryByText('You asked')).toBeNull()
    expect(within(modal()).getByRole('button', { name: 'Design' })).toBeEnabled()
  })
})

describe('ModaleProgettoAI: the review', () => {
  it('shows the request as proposed, with why', async () => {
    const { user } = openModal({ itemId: null, nomeVoce: null })
    await submitDescription(user)
    const m = modal()
    expect(await within(m).findByText('You asked')).toBeInTheDocument()
    expect(within(m).getByText(PROPOSAL.prompt)).toBeInTheDocument()
    expect(within(m).getByText('The service request')).toBeInTheDocument()
    expect(within(m).getByText('For new hires')).toBeInTheDocument()
    expect(within(m).getByText('Category: hardware')).toBeInTheDocument()
    expect(within(m).getByText('Priority: high')).toBeInTheDocument()
    expect(within(m).getByText('Goes through an approval')).toBeInTheDocument()
    expect(within(m).getByText('Workflow: Hardware road')).toBeInTheDocument()
    expect(within(m).getByText('from «a new laptop»')).toBeInTheDocument()
  })

  it('what the AI did not choose is left to choose, and the workflow follows the category', async () => {
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: {
      ...PROPOSAL, item: { ...PROPOSAL.item!, description: null, category: null, priority: null, requiresApproval: false, workflowDefinitionName: null },
    } } }
    const { user } = openModal({ itemId: null, nomeVoce: null })
    await submitDescription(user)
    const m = modal()
    expect(await within(m).findByText('Category: to be chosen')).toBeInTheDocument()
    expect(within(m).getByText('Priority: to be chosen')).toBeInTheDocument()
    expect(within(m).getByText('No approval')).toBeInTheDocument()
    expect(within(m).getByText('Workflow: the one for the category')).toBeInTheDocument()
    expect(within(m).queryByText('For new hires')).toBeNull()
  })

  it('shows each section and each field: reused or new, its type, what makes it special, why, and its code', async () => {
    const { user } = openModal()
    await submitDescription(user)
    const m = modal()
    expect(await within(m).findByText('The form: 2 sections, 3 fields')).toBeInTheDocument()
    // A section is titled in Italian when it can be, in English otherwise.
    expect(within(m).getByText('Il portatile')).toBeInTheDocument()
    expect(within(m).getByText(/2 columns/)).toBeInTheDocument()
    expect(within(m).getByText('Choice')).toBeInTheDocument()
    expect(within(m).getByText(/one column/)).toBeInTheDocument()

    const itemOf = (label: string) => within(m).getByText(label).closest('li') as HTMLElement
    // A new field without an Italian label is read in English; it is computed, and its code is shown.
    const totalItem = itemOf('Total')
    expect(within(totalItem).getByText('new')).toBeInTheDocument()
    expect(within(totalItem).getByText('Number')).toBeInTheDocument()
    expect(within(totalItem).getByText('computed')).toBeInTheDocument()
    expect(within(totalItem).getByText('Formula')).toBeInTheDocument()
    expect(within(totalItem).getByText('return input.price * 2')).toBeInTheDocument()
    expect(within(totalItem).getByText('from «the total»')).toBeInTheDocument()
    expect(within(totalItem).queryByText('required')).toBeNull()

    // A reused field reads as its library label, not as its technical name.
    const costItem = itemOf('Cost centre')
    expect(within(costItem).getByText('reused')).toBeInTheDocument()
    expect(within(costItem).getByText('read-only')).toBeInTheDocument()
    expect(within(costItem).getByText('internal')).toBeInTheDocument()
    expect(within(costItem).getByText('conditional')).toBeInTheDocument()
    expect(within(costItem).queryByText('One choice')).toBeNull()
    expect(within(m).queryByText('cost_centre')).toBeNull()

    const modelItem = itemOf('Modello')
    expect(within(modelItem).getByText('required')).toBeInTheDocument()
    expect(within(modelItem).getByText('Validation')).toBeInTheDocument()
    expect(within(modelItem).getByText('if (!value) throw new Error("Pick one")')).toBeInTheDocument()
    expect(within(modelItem).queryByText('computed')).toBeNull()
  })

  it('lists the value lists to create, what was discarded (in the reader\'s language) and what could not be done', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: {
      ...PROPOSAL, discarded: [...PROPOSAL.discarded, { what: 'Mystery', key: 'proposal.discard.noLabel', params: 'not json' }],
    } } }
    const { user } = openModal()
    await submitDescription(user)
    const m = modal()
    expect(await within(m).findByText('Value lists to create')).toBeInTheDocument()
    expect(within(m).getByText('Laptop models').closest('li')).toHaveTextContent('Laptop models — basic, pro')
    expect(within(m).getByText('What I discarded')).toBeInTheDocument()
    expect(within(m).getByText('Regions').closest('li')).toHaveTextContent('Regions — The value list «regions» does not exist in the Dictionary.')
    // Unreadable parameters do not hide the item: it is still said, and the fault is logged.
    expect(within(m).getByText('Mystery').closest('li')).toHaveTextContent('Field with no label: discarded')
    expect(consoleError).toHaveBeenCalledWith('Unreadable params on a discarded proposal item', expect.anything())
    expect(within(m).getByText('What I could not do')).toBeInTheDocument()
    expect(within(m).getByText('I did not design a table')).toBeInTheDocument()
  })

  it('a proposal with nothing to add has no empty blocks, and cannot be added', async () => {
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: {
      ...PROPOSAL, item: null, sections: [], newFields: [], newVocabularies: [], discarded: [], notes: [],
    } } }
    const { user } = openModal()
    await submitDescription(user)
    const m = modal()
    expect(await within(m).findByText('The form: 0 sections, 0 fields')).toBeInTheDocument()
    for (const heading of ['Value lists to create', 'What I discarded', 'What I could not do']) {
      expect(within(m).queryByText(heading)).toBeNull()
    }
    expect(within(m).getByRole('button', { name: 'Add to the form' })).toBeDisabled()
  })

  it('«Rewrite the description» goes back with the text kept', async () => {
    const { user } = openModal()
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Rewrite the description' }))
    expect(within(modal()).getByRole('textbox', { name: 'What must this service request ask?' })).toHaveValue(PROPOSAL.prompt)
    expect(callLog.order).toEqual(['ProposeServiceRequestDesign'])
  })
})

describe('ModaleProgettoAI: accepting', () => {
  it('creates the value lists, then the fields, then hands the design over, and closes', async () => {
    const { user, onApplied, onClose } = openModal()
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('3 fields added to the form: review them and publish when you are happy.'))
    expect(callLog.order).toEqual(['ProposeServiceRequestDesign', 'CreateEnumType', 'CreateFormField', 'CreateFormField'])
    expect(apolloFinto.chiamata('CreateEnumType')).toEqual({ input: { name: 'laptop_models', label: 'Laptop models', values: ['basic', 'pro'], scope: 'shared' } })
    const [totalCall, modelCall] = apolloFinto.chiamate['CreateFormField']!
    // Only the languages that have text; no help at all when there is none.
    expect(totalCall).toEqual({ input: {
      name: 'total', fieldType: 'number', label: 'Total', labels: [{ language: 'en', text: 'Total' }],
      required: false, vocabulary: null, refTypes: [], formula: 'return input.price * 2', validationScript: null, shared: false,
    } })
    // The form decides «required», not the library; and a field born in a form is private to it.
    expect(modelCall).toEqual({ input: {
      name: 'laptop_model', fieldType: 'enum', label: 'Modello',
      labels: [{ language: 'it', text: 'Modello' }, { language: 'en', text: 'Model' }],
      helps: [{ language: 'it', text: 'Scegli il modello' }],
      required: false, vocabulary: 'laptop_models', refTypes: [], formula: null,
      validationScript: 'if (!value) throw new Error("Pick one")', shared: false,
    } })
    expect(onApplied).toHaveBeenCalledWith(PROPOSAL)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a label or a help written in one language only is sent in that language only', async () => {
    apolloFinto.esiti['ProposeServiceRequestDesign'] = { data: { proposeServiceRequestDesign: {
      ...PROPOSAL, newVocabularies: [],
      newFields: [{ ...PROPOSAL.newFields[0]!, labelIt: 'Totale', labelEn: '', helpEn: 'The total, doubled' }],
    } } }
    const { user } = openModal()
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(apolloFinto.chiamata('CreateFormField')).toMatchObject({ input: {
      label: 'Totale', labels: [{ language: 'it', text: 'Totale' }], helps: [{ language: 'en', text: 'The total, doubled' }],
    } })
  })

  it('while it works the button says so and cannot be pressed twice', async () => {
    let land: (outcome: 'done') => void = () => {}
    const onApplied = vi.fn(() => new Promise<'done'>((resolve) => { land = resolve }))
    const { user } = openModal({ onApplicato: onApplied })
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    const savingButton = await within(modal()).findByRole('button', { name: 'Saving...' })
    expect(savingButton).toBeDisabled()
    land('done')
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('when the design waits for the request to be created, it says the fields are in the library', async () => {
    const { user, onClose } = openModal({ itemId: null, nomeVoce: null, onApplicato: vi.fn(() => 'pending' as const) })
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      '2 fields created in the library. Now confirm the service request: the design lands in the form right after.'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops at the first refusal, says what was created, and leaves the canvas alone', async () => {
    callLog.queued['CreateFormField'] = [{ data: { createFormField: { id: 'f-total' } } }, { error: new Error('The library is full') }]
    const { user, onApplied, onClose } = openModal()
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    // A field without an Italian label is named by its name.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('I stopped: only Laptop models, total were created. The form was not touched.'))
    expect(toast.error).toHaveBeenCalledWith('The library is full')
    expect(onApplied).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Still on the review, and it can be tried again.
    expect(await within(modal()).findByRole('button', { name: 'Add to the form' })).toBeEnabled()
  })

  it('a refusal before anything was created says nothing about created things', async () => {
    apolloFinto.esiti['CreateEnumType'] = { error: new Error('Only an administrator can create value lists') }
    const { user, onApplied } = openModal()
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only an administrator can create value lists'))
    // Once the attempt is over (the button is back), still only the refusal has been said.
    expect(await within(modal()).findByRole('button', { name: 'Add to the form' })).toBeEnabled()
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('if everything was created but the design did not land, it says the fields exist and will not be created twice', async () => {
    const onApplied = vi.fn(async () => { throw new Error('canvas gone') })
    const { user, onClose } = openModal({ onApplicato: onApplied })
    await submitDescription(user)
    await user.click(await within(modal()).findByRole('button', { name: 'Add to the form' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'All the fields were created, but the design did not reach the form. Try adding it again: the fields already exist and will not be created twice.'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
