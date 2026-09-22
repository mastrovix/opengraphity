/**
 * Ticket numbering in the Organization page: prefix and digits per ticket
 * type, for NEW tickets only. What must not regress:
 * - the preview shows the number the next ticket will really get;
 * - a prefix the API would reject (or two prefixes that overlap, so INC-1
 *   and INC1 could not be told apart) is said on screen and blocks Save,
 *   instead of failing on the server with a generic error;
 * - Save is offered only when something changed, and sends digits as numbers;
 * - a failed save is SAID (G-16: before, the rejection was swallowed and the
 *   save looked successful).
 * `numberingProblem` itself is pinned in organizationSections.test.tsx; here
 * it is the section around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { TicketNumberingSection } from './TicketNumberingSection'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const SAVED = {
  isDefault: false,
  incident: { prefix: 'INC', digits: 8 },
  problem: { prefix: 'PRB', digits: 8 },
  change: { prefix: 'CHG', digits: 6 },
  serviceRequest: { prefix: 'REQ-', digits: 5 },
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetTicketNumbering'] = { ticketNumbering: SAVED }
  // The customer renamed a type: the row must use the customer's name.
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption' }] }
})

const prefix = (type: string) => screen.getByRole('textbox', { name: `Prefix of ${type}` })
const digits = (type: string) => screen.getByRole('spinbutton', { name: `Digits of ${type}` })
const save = () => screen.getByRole('button', { name: 'Save' })
const rowOf = (type: string) => prefix(type).closest('tr')!

describe('TicketNumberingSection', () => {
  it('shows the saved format per type with the next number as example, and nothing to save yet', () => {
    renderWithProviders(<TicketNumberingSection />)
    expect(screen.getByText('Ticket numbering')).toBeInTheDocument()
    expect(prefix('Disruption')).toHaveValue('INC')
    expect(within(rowOf('Disruption')).getByText('INC00000001')).toBeInTheDocument()
    expect(within(rowOf('service_request')).getByText('REQ-00001')).toBeInTheDocument()
    expect(save()).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a prefix is upper-cased as typed; the example follows; Save sends digits as numbers and confirms', async () => {
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.clear(prefix('change'))
    await user.type(prefix('change'), 'rfc')
    expect(prefix('change')).toHaveValue('RFC')
    await user.clear(digits('change'))
    await user.type(digits('change'), '4')
    expect(within(rowOf('change')).getByText('RFC0001')).toBeInTheDocument()
    expect(save()).toBeEnabled()

    await user.click(save())
    expect(apolloFinto.chiamata('SetTicketNumbering')).toEqual({ input: {
      incident: { prefix: 'INC', digits: 8 },
      problem: { prefix: 'PRB', digits: 8 },
      change: { prefix: 'RFC', digits: 4 },
      serviceRequest: { prefix: 'REQ-', digits: 5 },
    } })
    expect(toast.success).toHaveBeenCalledWith('Numbering saved: it applies to new tickets')
  })

  it('an invalid prefix is said and blocks Save', async () => {
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.clear(prefix('problem'))
    await user.type(prefix('problem'), '1PB')
    expect(screen.getByRole('alert')).toHaveTextContent('A prefix has 1 to 8 capital letters')
    expect(save()).toBeDisabled()
  })

  it('digits out of range are said, and the example does not explode on them', async () => {
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.clear(digits('problem'))
    await user.type(digits('problem'), '40')
    expect(screen.getByRole('alert')).toHaveTextContent('Digits must be a whole number between 3 and 12.')
    // The example is capped at 12 digits instead of padding to 40.
    expect(within(rowOf('problem')).getByText('PRB000000000001')).toBeInTheDocument()
    await user.clear(digits('problem'))
    // An empty field reads as zero digits: just the prefix and «1».
    expect(within(rowOf('problem')).getByText('PRB1')).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('two prefixes that overlap are refused: their numbers could not be told apart', async () => {
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.clear(prefix('problem'))
    await user.type(prefix('problem'), 'INCX')
    expect(screen.getByRole('alert')).toHaveTextContent('Two prefixes overlap')
    expect(save()).toBeDisabled()
  })

  it('going back to the saved values makes Save unavailable again', async () => {
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.type(prefix('change'), 'X')
    expect(save()).toBeEnabled()
    await user.type(prefix('change'), '{Backspace}')
    expect(save()).toBeDisabled()
  })

  it('a failed save is shown, not swallowed (G-16)', async () => {
    apolloFinto.esiti['SetTicketNumbering'] = { error: new Error('numbering locked') }
    const { user } = renderWithProviders(<TicketNumberingSection />)
    await user.type(prefix('change'), 'X')
    await user.click(save())
    expect(toast.error).toHaveBeenCalledWith('numbering locked')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a load error is shown with a retry that reloads', async () => {
    apolloFinto.risposte['GetTicketNumbering'] = undefined
    apolloFinto.erroriQuery['GetTicketNumbering'] = new Error('numbering unavailable')
    const { user } = renderWithProviders(<TicketNumberingSection />)
    expect(screen.getByText('numbering unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
