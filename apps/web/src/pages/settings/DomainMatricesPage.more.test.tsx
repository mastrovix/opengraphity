/**
 * Domain matrices: the paths the two existing test files do not walk.
 *
 * These rules decide priorities, incident severities and change risk. What
 * an administrator loses if the page regresses:
 *  - an EMPTY cell must be visible as such, with a warning: a hole is an error
 *    that fires later, in a job, when an incident cannot be opened;
 *  - a cell whose saved value was RENAMED away in the Dictionary must say so
 *    (it looked like "to fill in"), and so must keys left outside the vocabulary;
 *  - saving a matrix never sends the stale keys back (saving IS the cleanup)
 *    nor empty cells;
 *  - risk bands must ascend and end at 100, or a score would have no band;
 *    adding a band proposes one not used yet;
 *  - the environment weight accepts only an integer in range;
 *  - pre-approved change types save exactly the ticked set, and saving is
 *    offered only when something changed.
 *
 * The fake Apollo answers by operation name: these tests are about what the
 * page does with the answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { MAX_ENVIRONMENT_WEIGHT } from '@opengraphity/types'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders } from '@/test/utils'
import { DomainMatricesPage } from './DomainMatricesPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }))

/** The card (SectionCard) whose title is `title`. */
function cardOf(title: string): HTMLElement {
  const el = screen.getByText(title).closest<HTMLElement>('div[style*="border-radius: 10px"]')
  expect(el).not.toBeNull()
  return el!
}
const saveIn = (card: HTMLElement) => within(card).getByRole('button', { name: 'Save' })

/** A one-dimension matrix: alarm severity → incident severity. */
function severityMatrix(over: Record<string, unknown> = {}) {
  return {
    kind: 'event_severity', inputs: ['alarm_severity'], output: 'severity',
    inputValues: [['critical', 'warning', 'info']], outputValues: ['high', 'medium', 'low'],
    cells: [
      { key: 'critical', inputs: ['critical'], value: 'high' },
      { key: 'warning', inputs: ['warning'], value: null },
      { key: 'info', inputs: ['info'], value: 'minor' },
      { key: 'fatal', inputs: ['fatal'], value: 'high' },
    ],
    missing: ['warning'], stale: ['fatal'], invalid: ['info'], isDefault: false, updatedAt: '2026-09-10T10:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('DomainMatricesPage — a matrix', () => {
  it('shows holes, renamed values and stale keys, each with its own explanation', () => {
    apolloFinto.risposte['GetDomainMatrices'] = { domainMatrices: [severityMatrix()] }
    renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Alarm severity → incident severity')
    const warnings = within(card).getAllByRole('status').map((s) => s.textContent)
    expect(warnings).toEqual([
      expect.stringContaining('One combination with no value (warning)'),
      expect.stringContaining('One cell points at a value that is no longer in your vocabulary (info)'),
    ])
    // The renamed value is visible, disabled, in its own dropdown.
    const info = within(card).getByRole('combobox', { name: 'alarm_severity info' })
    expect(info).toHaveValue('minor')
    expect(within(info).getByRole('option', { name: 'minor — no longer in the vocabulary' })).toBeDisabled()
    expect(within(card).getByRole('combobox', { name: 'alarm_severity warning' })).toHaveValue('')
    // The stale key is listed apart, not mixed with the rows.
    expect(within(card).getByText('Cells outside the vocabulary')).toBeInTheDocument()
    expect(within(card).getByRole('listitem')).toHaveTextContent('fatal → high')
    expect(within(card).queryByRole('combobox', { name: 'alarm_severity fatal' })).toBeNull()
    expect(within(card).getByText(/edited on/)).toBeInTheDocument()
  })

  it('filling the hole and replacing the renamed value clears both warnings; save sends neither stale nor empty cells', async () => {
    apolloFinto.risposte['GetDomainMatrices'] = { domainMatrices: [severityMatrix()] }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Alarm severity → incident severity')
    await user.selectOptions(within(card).getByRole('combobox', { name: 'alarm_severity warning' }), 'medium')
    await user.selectOptions(within(card).getByRole('combobox', { name: 'alarm_severity info' }), 'low')
    expect(within(card).queryAllByRole('status')).toHaveLength(0)
    // Emptying a filled cell brings the warning back: an empty cell is never silently accepted.
    await user.selectOptions(within(card).getByRole('combobox', { name: 'alarm_severity critical' }), '')
    expect(within(card).getByRole('status')).toHaveTextContent('One combination with no value (critical)')

    await user.click(saveIn(card))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Matrix saved'))
    expect(apolloFinto.chiamata('UpdateDomainMatrix')).toEqual({
      kind: 'event_severity',
      entries: [{ key: 'warning', value: 'medium' }, { key: 'info', value: 'low' }],
    })
  })

  it('factory content says so; a refused save is reported', async () => {
    apolloFinto.risposte['GetDomainMatrices'] = { domainMatrices: [severityMatrix({ isDefault: true, missing: [], stale: [], invalid: [], cells: [{ key: 'critical', inputs: ['critical'], value: 'high' }] })] }
    apolloFinto.esiti['UpdateDomainMatrix'] = { error: new Error('matrix locked') }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Alarm severity → incident severity')
    expect(within(card).getByText(/factory content \(never edited\)/)).toBeInTheDocument()
    // A row whose cell the server did not send has nothing to edit.
    expect(within(card).queryByRole('combobox', { name: 'alarm_severity warning' })).toBeNull()
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('matrix locked'))
  })

  it('an edited matrix without a date shows a dash rather than an invalid date', () => {
    apolloFinto.risposte['GetDomainMatrices'] = { domainMatrices: [severityMatrix({ updatedAt: null })] }
    renderWithProviders(<DomainMatricesPage />)
    expect(within(cardOf('Alarm severity → incident severity')).getByText(/edited on —/)).toBeInTheDocument()
  })

  it('a load error is shown', () => {
    apolloFinto.erroriQuery['GetDomainMatrices'] = new Error('graph offline')
    renderWithProviders(<DomainMatricesPage />)
    expect(screen.getByText('graph offline')).toBeInTheDocument()
  })
})

describe('DomainMatricesPage — risk bands', () => {
  const bands = (thresholds: Array<[string, number]>, isDefault = false) => ({
    riskBandThresholds: { thresholds: thresholds.map(([band, upTo]) => ({ band, upTo })), vocabulary: ['low', 'medium', 'high'], isDefault },
  })

  it('factory thresholds are announced; thresholds must ascend and end at 100', async () => {
    apolloFinto.risposte['GetRiskBandThresholds'] = bands([['low', 30], ['medium', 60], ['high', 100]], true)
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Change risk bands')
    expect(within(card).getByText(/You are using the factory thresholds/)).toBeInTheDocument()
    const save = saveIn(card)
    // Nothing changed yet: nothing to save.
    expect(save).toBeDisabled()

    const medium = within(card).getByRole('spinbutton', { name: 'Up to — medium band' })
    await user.clear(medium)
    await user.type(medium, '20')
    expect(within(card).getByText('Thresholds must ascend, from the lowest band to the highest.')).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.clear(medium)
    await user.type(medium, '60')

    const high = within(card).getByRole('spinbutton', { name: 'Up to — high band' })
    await user.clear(high)
    await user.type(high, '90')
    expect(within(card).getByText('The last band must reach 100: a higher score would have no band.')).toBeInTheDocument()
    expect(save).toBeDisabled()
  })

  it('adding proposes the unused band; removing and re-picking bands is saved as shown', async () => {
    apolloFinto.risposte['GetRiskBandThresholds'] = bands([['low', 50], ['high', 100]])
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Change risk bands')
    await user.click(within(card).getByRole('button', { name: 'Add a band' }))
    // The new row takes the one band not used yet, at 100.
    expect(within(card).getByRole('combobox', { name: 'Band 3' })).toHaveValue('medium')
    await user.click(within(card).getByRole('button', { name: 'Remove the "high" band' }))
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Band 2' }), 'high')
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Risk bands saved.'))
    expect(apolloFinto.chiamata('UpdateRiskBandThresholds')).toEqual({ entries: [{ band: 'low', upTo: 50 }, { band: 'high', upTo: 100 }] })
  })

  it('with every band used, a new row has no band: it is named by position and blocks the save', async () => {
    apolloFinto.risposte['GetRiskBandThresholds'] = bands([['low', 30], ['medium', 60], ['high', 100]])
    apolloFinto.esiti['UpdateRiskBandThresholds'] = { error: new Error('bands refused') }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Change risk bands')
    await user.click(within(card).getByRole('button', { name: 'Add a band' }))
    expect(within(card).getByRole('combobox', { name: 'Band 4' })).toHaveValue('')
    expect(within(card).getByRole('spinbutton', { name: 'Up to — band 4' })).toBeInTheDocument()
    expect(saveIn(card)).toBeDisabled()
    // Removing the blank row, then a real edit, re-enables the save; the refusal is reported.
    await user.click(within(card).getByRole('button', { name: 'Remove the "4" band' }))
    const low = within(card).getByRole('spinbutton', { name: 'Up to — low band' })
    await user.clear(low)
    await user.type(low, '25')
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('bands refused'))
  })

  it('no bands at all cannot be saved (every score would be without a band)', async () => {
    apolloFinto.risposte['GetRiskBandThresholds'] = bands([['high', 100]])
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Change risk bands')
    await user.click(within(card).getByRole('button', { name: 'Remove the "high" band' }))
    expect(within(card).getByText(/The last band must reach 100/)).toBeInTheDocument()
    expect(saveIn(card)).toBeDisabled()
  })

  it('a load error is shown in the card', () => {
    apolloFinto.erroriQuery['GetRiskBandThresholds'] = new Error('bands unavailable')
    renderWithProviders(<DomainMatricesPage />)
    expect(within(cardOf('Change risk bands')).getByText('bands unavailable')).toBeInTheDocument()
  })
})

describe('DomainMatricesPage — environment weight', () => {
  it('only an integer between 0 and the maximum can be saved', async () => {
    apolloFinto.risposte['GetChangeEnvironmentWeight'] = { changeEnvironmentWeight: { weight: 5, isDefault: true } }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Environment weight in the change risk')
    expect(within(card).getByText(/the factory weight \(5\) applies/)).toBeInTheDocument()
    const input = within(card).getByRole('spinbutton', { name: 'Environment weight in the change risk' })
    expect(input).toHaveValue(5)
    expect(saveIn(card)).toBeDisabled()

    await user.clear(input)
    await user.type(input, String(MAX_ENVIRONMENT_WEIGHT + 1))
    expect(within(card).getByText(`An integer between 0 and ${MAX_ENVIRONMENT_WEIGHT}.`)).toBeInTheDocument()
    expect(saveIn(card)).toBeDisabled()

    await user.clear(input)
    expect(saveIn(card)).toBeDisabled()
    await user.type(input, '2')
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Environment weight saved'))
    expect(apolloFinto.chiamata('UpdateChangeEnvironmentWeight')).toEqual({ weight: 2 })
  })

  it('a refused save and a load error are both reported', async () => {
    apolloFinto.risposte['GetChangeEnvironmentWeight'] = { changeEnvironmentWeight: { weight: 1, isDefault: false } }
    apolloFinto.esiti['UpdateChangeEnvironmentWeight'] = { error: new Error('weight refused') }
    const { user, unmount } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Environment weight in the change risk')
    expect(within(card).queryByText(/factory weight/)).toBeNull()
    const input = within(card).getByRole('spinbutton', { name: 'Environment weight in the change risk' })
    await user.clear(input)
    await user.type(input, '0')
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('weight refused'))
    unmount()

    apolloFinto.erroriQuery['GetChangeEnvironmentWeight'] = new Error('weight unavailable')
    renderWithProviders(<DomainMatricesPage />)
    expect(screen.getByText('weight unavailable')).toBeInTheDocument()
  })
})

describe('DomainMatricesPage — pre-approved change types', () => {
  it('saves exactly the ticked types, only once something changed', async () => {
    apolloFinto.risposte['GetPreApprovedChangeTypes'] = { preApprovedChangeTypes: { types: ['standard'], vocabulary: ['standard', 'normal', 'emergency'] } }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Pre-approved changes')
    expect(within(card).getByRole('checkbox', { name: 'standard' })).toBeChecked()
    expect(saveIn(card)).toBeDisabled()

    await user.click(within(card).getByRole('checkbox', { name: 'standard' }))
    // Nothing pre-approved: the page says what that means.
    expect(within(card).getByText('No pre-approved types: every change will go through approvals.')).toBeInTheDocument()
    await user.click(within(card).getByRole('checkbox', { name: 'standard' }))
    // Back to the saved set: not dirty.
    expect(saveIn(card)).toBeDisabled()

    await user.click(within(card).getByRole('checkbox', { name: 'normal' }))
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pre-approved types saved'))
    expect(apolloFinto.chiamata('UpdatePreApprovedChangeTypes')).toEqual({ types: ['standard', 'normal'] })
  })

  it('a swap of one type for another counts as a change even at the same count', async () => {
    apolloFinto.risposte['GetPreApprovedChangeTypes'] = { preApprovedChangeTypes: { types: ['standard'], vocabulary: ['standard', 'normal'] } }
    apolloFinto.esiti['UpdatePreApprovedChangeTypes'] = { error: new Error('types refused') }
    const { user } = renderWithProviders(<DomainMatricesPage />)
    const card = cardOf('Pre-approved changes')
    await user.click(within(card).getByRole('checkbox', { name: 'standard' }))
    await user.click(within(card).getByRole('checkbox', { name: 'normal' }))
    expect(saveIn(card)).toBeEnabled()
    await user.click(saveIn(card))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('types refused'))
  })

  it('a load error is shown in the card', () => {
    apolloFinto.erroriQuery['GetPreApprovedChangeTypes'] = new Error('types unavailable')
    renderWithProviders(<DomainMatricesPage />)
    expect(within(cardOf('Pre-approved changes')).getByText('types unavailable')).toBeInTheDocument()
  })
})
