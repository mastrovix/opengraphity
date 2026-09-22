/**
 * THE DICTIONARY EDITOR: WHAT EACH CONTROL DOES TO THE TENANT'S VOCABULARY.
 *
 * A vocabulary is not a list of strings on a page: records, domain matrices and
 * the alarm policy read its values, and three domain rules read them by
 * POSITION (the status a CI is born with, the risk bands, the highest impact).
 * So every control here has a consequence far from this page:
 *
 *  - renaming, reordering and choosing the default go to the server at once;
 *  - removing a value still used by records must ask what to rewrite them to,
 *    or the API refuses and the administrator is stuck (G-11);
 *  - labels and colours are written on their own, from the SAVED values, and
 *    are refused while value edits are pending (G-2) — otherwise a label save
 *    would silently drop labels of values removed locally.
 *
 * The companion `EnumDesignerPage.test.tsx` pins ownership (shipped vs own)
 * over the real Apollo mock link; this file pins the editing behaviours with a
 * fake Apollo keyed by operation name, which keeps each test about behaviour.
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

/*
 * The shared fake keeps ONE function per mutation name, bound to the options of
 * the LAST hook that registered it. This page has three `useMutation` hooks on
 * the same `UpdateEnumType` document (values, labels, default) with different
 * `onCompleted`, so here each hook gets its own function: otherwise saving the
 * values would run the «default set» reaction and the test would pin a lie.
 */
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, apolloFinto: fake, nomeOperazione: opName } = await import('@/test/apolloFinto')
  const { vi: v } = await import('vitest')
  type Opts = { onCompleted?: (d: unknown) => void; onError?: (e: Error) => void; variables?: Record<string, unknown> }
  return {
    ...moduloApollo(),
    useMutation: (doc: Parameters<typeof opName>[0], opts: Opts = {}) => {
      const nome = opName(doc)
      const [fn] = useState(() => v.fn())
      fn.mockImplementation(async (o: Opts = {}) => {
        ;(fake.chiamate[nome] ??= []).push(o.variables)
        const esito = fake.esiti[nome] ?? { data: {} }
        if (esito.error) { opts.onError?.(esito.error); return { errors: [esito.error] } }
        opts.onCompleted?.(esito.data)
        return { data: esito.data }
      })
      return [fn, { loading: false, data: undefined, error: undefined }]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('@/lib/clientLogger', () => ({ clientLogger: logger }))

const { EnumDesignerPage } = await import('./EnumDesignerPage')

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>
const enumType = (over: Row): Row => {
  const base: Row = {
    id: 'o1', name: 'site_color', label: 'Site colour', values: ['red', 'green', 'blue'],
    isSystem: false, isShipped: false, scope: 'cmdb', defaultValue: 'red',
    valueLabelsReasonKey: null, valueColors: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
  const values = base.values as string[]
  return {
    ...base,
    valueLabels: base.valueLabels ?? values.map((v) => ({
      value: v, label: v,
      // Only `red` has a written label, and only in Italian.
      labels: v === 'red' ? [{ language: 'it', label: 'Rosso' }] : [],
    })),
  }
}

const OWN = enumType({})
const SYSTEM_OWN = enumType({ id: 's1', name: 'impact', label: 'Impact', values: ['low', 'high'], isSystem: true, scope: 'itil', defaultValue: null })
const ODD_SCOPE = enumType({ id: 'x1', name: 'misc', label: 'Misc', values: ['a'], scope: 'custom_scope', defaultValue: null })

const usage = (total: number, extra: Row = {}) => ({
  data: { enumValueUsage: { total, policyLists: [], matrices: [], configSites: [], records: [], ...extra } },
})

beforeEach(() => {
  apolloFinto.reset()
  Object.values(toast).forEach((f) => f.mockReset())
  logger.error.mockReset()
  apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [OWN, SYSTEM_OWN, ODD_SCOPE] }
  apolloFinto.risposte['GetEnumShippedDrift'] = { enumTypes: [] }
  apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: ['en', 'it'], defaultLanguage: 'it', fallback: 'en' } }
})

async function openOwn() {
  const r = renderWithProviders(<EnumDesignerPage />)
  await r.user.click(await screen.findByRole('button', { name: /Site colour/ }))
  return r
}

const updateCalls = () => apolloFinto.chiamate['UpdateEnumType'] ?? []

// ── The list ──────────────────────────────────────────────────────────────────

describe('the dictionary list', () => {
  it('groups by scope label, and a scope with no label is shown by its name rather than dropped', async () => {
    renderWithProviders(<EnumDesignerPage />)
    expect(await screen.findByText('CMDB')).toBeInTheDocument()
    expect(screen.getByText('ITIL')).toBeInTheDocument()
    expect(screen.getByText('custom_scope')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Misc/ })).toBeInTheDocument()
    // Nothing selected yet: the right side says so.
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('the selected row is marked for assistive technology', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />)
    const row = await screen.findByRole('button', { name: /Site colour/ })
    expect(row).not.toHaveAttribute('aria-current')
    await user.click(row)
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('a customer copy of a shipped dictionary says where it comes from', async () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [enumType({ id: 'sh', isShipped: true, isSystem: true }), OWN] }
    const { user } = renderWithProviders(<EnumDesignerPage />)
    // The shipped original is hidden by the copy: one row only.
    expect(await screen.findAllByRole('button', { name: /Site colour/ })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: /Site colour/ }))
    expect(screen.getByTestId('dictionary-customized-note')).toBeInTheDocument()
  })
})

// ── Create ────────────────────────────────────────────────────────────────────

describe('creating a dictionary', () => {
  async function openCreate() {
    const r = renderWithProviders(<EnumDesignerPage />)
    await r.user.click(await screen.findByRole('button', { name: /New Enum Type/ }))
    return r
  }

  it('a name that is not snake_case is refused before reaching the API', async () => {
    const { user } = await openCreate()
    // `required`/`pattern` would stop a real browser; the handler is the guard that counts.
    const name = screen.getByLabelText(/Name \(snake_case\)/)
    name.removeAttribute('pattern')
    await user.type(name, 'Bad-Name')
    await user.type(screen.getByLabelText(/^Label/), 'X')
    await user.type(screen.getByLabelText('Values'), 'a')
    await user.click(screen.getByRole('button', { name: /^Create$/ }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('snake_case'))
    expect(apolloFinto.chiamate['CreateEnumType']).toBeUndefined()
  })

  it('sends the chosen scope, then selects the new dictionary and closes the dialog', async () => {
    const created = enumType({ id: 'n1', name: 'outcome', label: 'Outcome', values: ['ok'], scope: 'itil' })
    apolloFinto.esiti['CreateEnumType'] = { data: { createEnumType: created } }
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [OWN, created] }
    const { user } = await openCreate()
    await user.type(screen.getByLabelText(/Name \(snake_case\)/), 'outcome')
    await user.type(screen.getByLabelText(/^Label/), 'Outcome')
    await user.selectOptions(screen.getByLabelText('Scope'), 'itil')
    await user.type(screen.getByLabelText('Values'), 'ok')
    // The hint counts the distinct values as they are typed.
    expect(screen.getByText(/1 value\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Create$/ }))
    expect(apolloFinto.chiamata('CreateEnumType')).toEqual({ input: { name: 'outcome', label: 'Outcome', values: ['ok'], scope: 'itil' } })
    expect(toast.success).toHaveBeenCalledWith('Enum "Outcome" created')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Technical name')).toHaveValue('outcome')
  })

  it('an API refusal is shown and the dialog stays open', async () => {
    apolloFinto.esiti['CreateEnumType'] = { error: new Error('name taken') }
    const { user } = await openCreate()
    await user.type(screen.getByLabelText(/Name \(snake_case\)/), 'outcome')
    await user.type(screen.getByLabelText(/^Label/), 'Outcome')
    await user.type(screen.getByLabelText('Values'), 'ok')
    await user.click(screen.getByRole('button', { name: /^Create$/ }))
    expect(toast.error).toHaveBeenCalledWith('name taken')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('Cancel closes it without creating anything', async () => {
    const { user } = await openCreate()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['CreateEnumType']).toBeUndefined()
  })
})

// ── Header states ─────────────────────────────────────────────────────────────

describe('a system dictionary of the tenant', () => {
  it('is badged and explained, its scope is locked, and it cannot be deleted', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />)
    await user.click(await screen.findByRole('button', { name: /Impact/ }))
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText(/System enum/)).toBeInTheDocument()
    expect(screen.getByLabelText('Scope')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('saving it does not send a scope (the API would refuse changing a system scope)', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />)
    await user.click(await screen.findByRole('button', { name: /Impact/ }))
    await user.type(screen.getByRole('textbox', { name: 'Add value' }), 'mid{enter}')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 's1', input: { label: 'Impact', values: ['low', 'high', 'mid'], scope: undefined } })
  })
})

// ── Values: add, remove, save, cancel ─────────────────────────────────────────

describe('editing the value list', () => {
  it('an empty or duplicate value is not added', async () => {
    const { user } = await openOwn()
    const add = screen.getByRole('textbox', { name: 'Add value' })
    await user.click(screen.getByRole('button', { name: 'Add value' }))
    await user.type(add, 'red')
    await user.click(screen.getByRole('button', { name: 'Add value' }))
    expect(screen.getAllByText('red')).toHaveLength(1)
    // Nothing changed, so there is nothing to save.
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
  })

  it('adding, relabelling and re-scoping are saved together; saving hides the buttons', async () => {
    const { user } = await openOwn()
    await user.type(screen.getByRole('textbox', { name: 'Add value' }), ' pink {enter}')
    await user.clear(screen.getByLabelText('Label'))
    await user.type(screen.getByLabelText('Label'), 'Colours')
    await user.selectOptions(screen.getByLabelText('Scope'), 'shared')
    expect(screen.getByRole('textbox', { name: 'Add value' })).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    // No removed value, so no usage query and no replacements.
    expect(apolloFinto.query).not.toHaveBeenCalled()
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { label: 'Colours', values: ['red', 'green', 'blue', 'pink'], scope: 'shared' } })
    expect(toast.success).toHaveBeenCalledWith('Enum updated')
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument())
  })

  it('Cancel brings back the saved list, label and scope', async () => {
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value green' }))
    await user.type(screen.getByLabelText('Label'), '!')
    await user.selectOptions(screen.getByLabelText('Scope'), 'itil')
    expect(screen.queryByText('green')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('green')).toBeInTheDocument()
    expect(screen.getByLabelText('Label')).toHaveValue('Site colour')
    expect(screen.getByLabelText('Scope')).toHaveValue('cmdb')
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
  })

  it('removing every value says so', async () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [enumType({ values: ['red'] })] }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value red' }))
    expect(screen.getByText('No values')).toBeInTheDocument()
  })

  it('a save refused by the API is shown and the edits stay pending', async () => {
    apolloFinto.esiti['UpdateEnumType'] = { error: new Error('refused') }
    const { user } = await openOwn()
    await user.type(screen.getByRole('textbox', { name: 'Add value' }), 'pink{enter}')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(toast.error).toHaveBeenCalledWith('refused')
    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument()
  })
})

describe('removing a value still used by records (G-11)', () => {
  it('a removed value nobody uses is saved straight away, without replacements', async () => {
    apolloFinto.query.mockResolvedValue(usage(0))
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value green' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(updateCalls()).toHaveLength(1))
    expect(apolloFinto.query).toHaveBeenCalledWith(expect.objectContaining({ variables: { id: 'o1', value: 'green' }, fetchPolicy: 'network-only' }))
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { label: 'Site colour', values: ['red', 'blue'], scope: 'cmdb' } })
  })

  it('a removed value in use asks what the records become, then sends the replacement', async () => {
    apolloFinto.query.mockResolvedValue(usage(4))
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value green' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    // Nothing is written yet: rewriting four records is a change to DATA, so it is asked.
    const pick = await screen.findByRole('combobox', { name: 'Value that replaces green' })
    expect(updateCalls()).toHaveLength(0)
    expect(screen.getByText('4 records')).toBeInTheDocument()
    // Defaults to the first remaining value; options read the first language's label, else the value.
    expect(pick).toHaveValue('red')
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['red', 'blue'])
    await user.selectOptions(pick, 'blue')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({
      id: 'o1', input: { label: 'Site colour', values: ['red', 'blue'], scope: 'cmdb', replacements: [{ from: 'green', to: 'blue' }] },
    })
    // The question is gone once answered.
    expect(screen.queryByRole('combobox', { name: 'Value that replaces green' })).not.toBeInTheDocument()
  })

  it('if the usage cannot be counted nothing is saved, and the reason is shown', async () => {
    apolloFinto.query.mockRejectedValue(new Error('network down'))
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value green' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('network down')))
    expect(updateCalls()).toHaveLength(0)
  })

  it('with no value left to replace with, the save goes without a replacement (the API then decides)', async () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [enumType({ values: ['red'] })] }
    apolloFinto.query.mockResolvedValue(usage(2))
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value red' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await screen.findByRole('combobox', { name: 'Value that replaces red' })
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { label: 'Site colour', values: [], scope: 'cmdb' } })
  })

  it('Cancel also drops the pending replacement question', async () => {
    apolloFinto.query.mockResolvedValue(usage(1))
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value green' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await screen.findByRole('combobox', { name: 'Value that replaces green' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('combobox', { name: 'Value that replaces green' })).not.toBeInTheDocument()
  })
})

// ── Order and default ─────────────────────────────────────────────────────────

describe('order and default value (position matters: C·N-2)', () => {
  it('moving a value sends the whole new order at once, and shows the server order', async () => {
    apolloFinto.esiti['ReorderEnumValues'] = { data: { reorderEnumValues: { values: ['green', 'red', 'blue'] } } }
    const { user } = await openOwn()
    expect(screen.getByRole('button', { name: 'Move "red" up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move "blue" down' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move "green" up' }))
    expect(apolloFinto.chiamata('ReorderEnumValues')).toEqual({ id: 'o1', values: ['green', 'red', 'blue'] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move "green" up' })).toBeDisabled())
  })

  it('moving down works the same way', async () => {
    apolloFinto.esiti['ReorderEnumValues'] = { data: { reorderEnumValues: { values: ['green', 'red', 'blue'] } } }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Move "red" down' }))
    expect(apolloFinto.chiamata('ReorderEnumValues')).toEqual({ id: 'o1', values: ['green', 'red', 'blue'] })
  })

  it('with unsaved value edits the order is refused (the API wants the SAVED list, G-2)', async () => {
    const { user } = await openOwn()
    await user.type(screen.getByRole('textbox', { name: 'Add value' }), 'pink{enter}')
    await user.click(screen.getByRole('button', { name: 'Move "green" up' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Save or cancel'))
    expect(apolloFinto.chiamate['ReorderEnumValues']).toBeUndefined()
  })

  it('a refused reorder is shown', async () => {
    apolloFinto.esiti['ReorderEnumValues'] = { error: new Error('stale list') }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Move "green" up' }))
    expect(toast.error).toHaveBeenCalledWith('stale list')
  })

  it('the default is marked, and another value can be made the default', async () => {
    const { user } = await openOwn()
    expect(screen.getByText('default')).toBeInTheDocument()
    // The current default has no «make default» button.
    expect(screen.queryByRole('button', { name: 'Use "red" as the default value' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use "blue" as the default value' }))
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { defaultValue: 'blue' } })
    expect(toast.success).toHaveBeenCalledWith('Default value updated.')
  })

  it('a refused default is shown', async () => {
    apolloFinto.esiti['UpdateEnumType'] = { error: new Error('nope') }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Use "blue" as the default value' }))
    expect(toast.error).toHaveBeenCalledWith('nope')
  })
})

// ── Rename ────────────────────────────────────────────────────────────────────

describe('renaming a value', () => {
  async function startRename(value = 'green') {
    const r = await openOwn()
    await r.user.click(screen.getByRole('button', { name: `Rename "${value}"` }))
    return r
  }

  it('the field opens with the value selected, so typing replaces it', async () => {
    const { user } = await startRename()
    const input = screen.getByRole('textbox', { name: 'Rename "green"' })
    expect(input).toHaveFocus()
    await user.keyboard('lime')
    expect(input).toHaveValue('lime')
  })

  it('Escape and the × close the field without asking the server anything', async () => {
    const { user } = await startRename()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Rename "green"' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rename "green"' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Rename "green"' })).not.toBeInTheDocument()
    expect(apolloFinto.query).not.toHaveBeenCalled()
  })

  it('an unchanged or empty name just closes the field', async () => {
    const { user } = await startRename()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox', { name: 'Rename "green"' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rename "green"' }))
    await user.clear(screen.getByRole('textbox', { name: 'Rename "green"' }))
    await user.click(screen.getByRole('button', { name: 'Confirm the rename' }))
    expect(screen.queryByRole('textbox', { name: 'Rename "green"' })).not.toBeInTheDocument()
    expect(apolloFinto.query).not.toHaveBeenCalled()
  })

  it('an unused value is confirmed with «only the dictionary changes», then renamed in place', async () => {
    apolloFinto.query.mockResolvedValue(usage(0))
    apolloFinto.esiti['RenameEnumValue'] = { data: { renameEnumValue: { values: ['red', 'lime', 'blue'] } } }
    const { user } = await startRename()
    await user.keyboard('lime{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Rename «green» to «lime»?' })
    expect(dialog).toHaveTextContent('only the dictionary changes')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(apolloFinto.chiamata('RenameEnumValue')).toEqual({ id: 'o1', from: 'green', to: 'lime' }))
    // The renamed value keeps its POSITION (second), which is the point of renaming.
    expect(await screen.findByText('lime')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Value renamed'))
  })

  it('the confirmation names the policy lists and other config sites, and each matrix once', async () => {
    apolloFinto.query.mockResolvedValue(usage(3, {
      policyLists: ['ignore'], configSites: ['a notification rule'],
      matrices: ['priority (key "high|low")', 'priority (key "low|low")'],
    }))
    const { user } = await startRename()
    await user.keyboard('lime{Enter}')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('the priority matrix; the alarm policy (ignore); a notification rule')
    expect(dialog.textContent!.match(/priority matrix/g)).toHaveLength(1)
    // Saying no renames nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['RenameEnumValue']).toBeUndefined()
  })

  it('if the usage cannot be counted, nothing is renamed and the reason is shown', async () => {
    apolloFinto.query.mockRejectedValue(new Error('timeout'))
    const { user } = await startRename()
    await user.keyboard('lime')
    await user.click(screen.getByRole('button', { name: 'Confirm the rename' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('timeout')))
    expect(apolloFinto.chiamate['RenameEnumValue']).toBeUndefined()
  })

  it('a rename refused by the server is shown', async () => {
    apolloFinto.query.mockResolvedValue(usage(0))
    apolloFinto.esiti['RenameEnumValue'] = { error: new Error('clash') }
    const { user } = await startRename()
    await user.keyboard('lime{Enter}')
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('clash'))
  })
})

// ── Labels and colours ────────────────────────────────────────────────────────

describe('labels per value and language (written at once, from the saved values)', () => {
  it('leaving the field writes the WHOLE label list (the mutation replaces it in block)', async () => {
    const { user } = await openOwn()
    const en = screen.getByRole('textbox', { name: 'Label for value green in English' })
    await user.type(en, 'Green')
    await user.tab()
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { valueLabels: [
      // The Italian label of `red` is sent again: omitting it would delete it.
      { value: 'red', language: 'it', label: 'Rosso' },
      { value: 'green', language: 'en', label: 'Green' },
    ] } })
    expect(toast.success).toHaveBeenCalledWith('Enum updated')
  })

  it('Enter writes too; clearing a label removes it from the list', async () => {
    const { user } = await openOwn()
    const italian = screen.getByRole('textbox', { name: 'Label for value red in Italiano' })
    expect(italian).toHaveValue('Rosso')
    await user.clear(italian)
    await user.keyboard('{Enter}')
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { valueLabels: [] } })
  })

  /*
   * DEFECT FOUND HERE: with no draft the field was read as an EMPTY label, so
   * merely tabbing through a field that shows a saved label (or pressing
   * Escape and then leaving it) deleted that label on the server.
   */
  it('tabbing through a label field without editing it does not erase the saved label', async () => {
    const { user } = await openOwn()
    const italian = screen.getByRole('textbox', { name: 'Label for value red in Italiano' })
    await user.click(italian)
    await user.tab()
    expect(updateCalls()).toHaveLength(0)
  })

  it('Escape throws the draft away, and leaving afterwards writes nothing', async () => {
    const { user } = await openOwn()
    const italian = screen.getByRole('textbox', { name: 'Label for value red in Italiano' })
    await user.type(italian, 'x')
    expect(italian).toHaveValue('Rossox')
    await user.keyboard('{Escape}')
    expect(italian).toHaveValue('Rosso')
    await user.tab()
    expect(updateCalls()).toHaveLength(0)
  })

  it('a draft typed back to the saved label writes nothing either', async () => {
    const { user } = await openOwn()
    const italian = screen.getByRole('textbox', { name: 'Label for value red in Italiano' })
    await user.type(italian, 'x{Backspace}')
    await user.tab()
    expect(updateCalls()).toHaveLength(0)
    expect(italian).toHaveValue('Rosso')
  })

  it('with unsaved value edits a label is refused (it would drop labels of removed values, G-2)', async () => {
    const { user } = await openOwn()
    await user.type(screen.getByRole('textbox', { name: 'Add value' }), 'pink{enter}')
    await user.type(screen.getByRole('textbox', { name: 'Label for value green in English' }), 'G{enter}')
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Save or cancel'))
    expect(updateCalls()).toHaveLength(0)
  })

  it('a refused label write is shown', async () => {
    apolloFinto.esiti['UpdateEnumType'] = { error: new Error('bad label') }
    const { user } = await openOwn()
    await user.type(screen.getByRole('textbox', { name: 'Label for value green in English' }), 'G{enter}')
    expect(toast.error).toHaveBeenCalledWith('bad label')
  })
})

describe('colours per value (F9)', () => {
  it('«No color» removes the value from the colour list, keeping the others', async () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [enumType({ valueColors: [{ value: 'red', color: 'danger' }, { value: 'blue', color: 'info' }] })] }
    const { user } = await openOwn()
    await user.selectOptions(screen.getByLabelText('Color of value red'), '')
    expect(apolloFinto.chiamata('UpdateEnumType')).toEqual({ id: 'o1', input: { valueColors: [{ value: 'blue', color: 'info' }] } })
  })

  it('with unsaved value edits a colour is refused', async () => {
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Remove value blue' }))
    await user.selectOptions(screen.getByLabelText('Color of value red'), 'danger')
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Save or cancel'))
    expect(updateCalls()).toHaveLength(0)
  })
})

// ── Delete ────────────────────────────────────────────────────────────────────

describe('deleting a dictionary', () => {
  it('asks first; «No» keeps it', async () => {
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Confirm deletion?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(apolloFinto.chiamate['DeleteEnumType']).toBeUndefined()
  })

  it('«Yes, delete» deletes it and closes the editor', async () => {
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(apolloFinto.chiamata('DeleteEnumType')).toEqual({ id: 'o1' })
    expect(toast.success).toHaveBeenCalledWith('Enum deleted')
    expect(await screen.findByText('No results')).toBeInTheDocument()
  })

  it('a refused delete is shown and the editor stays', async () => {
    apolloFinto.esiti['DeleteEnumType'] = { error: new Error('in use') }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(toast.error).toHaveBeenCalledWith('in use')
    expect(screen.getByLabelText('Technical name')).toHaveValue('site_color')
  })
})

// ── Shipped values after the copy, customize errors ──────────────────────────

describe('shipped values added after the copy (F20)', () => {
  beforeEach(() => {
    apolloFinto.risposte['GetEnumShippedDrift'] = { enumTypes: [{ id: 'o1', newShippedValues: ['purple', 'teal'] }] }
  })

  it('«Add them» shows the list returned by the server', async () => {
    apolloFinto.esiti['AdoptShippedValues'] = { data: { adoptShippedValues: { values: ['red', 'green', 'blue', 'purple', 'teal'] } } }
    const { user } = await openOwn()
    expect(screen.getByRole('status')).toHaveTextContent('purple, teal')
    await user.click(screen.getByRole('button', { name: 'Add them' }))
    expect(await screen.findByText('teal', { selector: 'span' })).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Shipped values added to your copy')
  })

  it('«Keep my list» confirms it; errors on either are shown', async () => {
    apolloFinto.esiti['AcknowledgeShippedValues'] = { error: new Error('ack failed') }
    apolloFinto.esiti['AdoptShippedValues'] = { error: new Error('adopt failed') }
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Keep my list' }))
    await user.click(screen.getByRole('button', { name: 'Add them' }))
    expect(toast.error).toHaveBeenCalledWith('ack failed')
    expect(toast.error).toHaveBeenCalledWith('adopt failed')
  })

  it('«Keep my list» says the list stays', async () => {
    const { user } = await openOwn()
    await user.click(screen.getByRole('button', { name: 'Keep my list' }))
    expect(toast.success).toHaveBeenCalledWith('Your list stays as it is')
  })

  it('if the drift cannot be loaded it is logged, not hidden, and the editor still works', async () => {
    apolloFinto.erroriQuery['GetEnumShippedDrift'] = new Error('drift down')
    await openOwn()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('drift'), { error: 'drift down' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('customizing a shipped dictionary', () => {
  it('a refused customization is shown and the shipped one stays selected', async () => {
    apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [enumType({ id: 'sh', name: 'sev', label: 'Severity', isShipped: true, isSystem: true })] }
    apolloFinto.esiti['CustomizeEnumType'] = { error: new Error('no licence') }
    const { user } = renderWithProviders(<EnumDesignerPage />)
    await user.click(await screen.findByRole('button', { name: /Severity/ }))
    await user.click(screen.getByRole('button', { name: /Customize/ }))
    expect(toast.error).toHaveBeenCalledWith('no licence')
    expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument()
  })
})

