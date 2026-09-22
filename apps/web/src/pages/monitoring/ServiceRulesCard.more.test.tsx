/**
 * ServiceRulesCard when the saved rules change underneath (the detail page
 * polls every 15 s).
 *
 * Why it matters: when another admin saves the rules while you are typing,
 * the form is reset to the saved values. Doing it silently made a field
 * "jump back" with no explanation (revisione totale · G-MON-4): the card must
 * say that your change was discarded. And when nothing was being edited, a
 * poll that brings new values must just show them — no false alarm.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { ServiceRulesCard } from './ServiceRulesCard'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, preview, RULES } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import i18n from '@/i18n/i18n'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const T = (k: string) => i18n.t(k) as string
const detail = (rules: Record<string, unknown> = RULES) => mapDetail({ rules }) as unknown as ServiceMapDetail

const previewMock: GqlMock = {
  request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
  result: { data: { serviceImpactPreview: preview() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

/** The page owns the map; the button stands in for a poll that brings rules saved by someone else. */
function Harness() {
  const [map, setMap] = useState(detail())
  return (
    <>
      <button type="button" onClick={() => setMap(detail({ ...RULES, version: 2, downSharePct: 70 }))}>poll</button>
      <ServiceRulesCard map={map} canEdit onReload={() => {}} />
    </>
  )
}

function renderCard() {
  const r = renderWithProviders(<Harness />, { mocks: [previewMock] })
  fireEvent.click(screen.getByRole('button', { name: 'How it is computed' }))
  return r
}

describe('ServiceRulesCard — rules saved by someone else', () => {
  it('while editing: the form takes the saved values and says the change was discarded', async () => {
    const { user } = renderCard()
    const down = await screen.findByLabelText('Down threshold (%)')
    await user.clear(down)
    await user.type(down, '60')
    await user.click(screen.getByRole('button', { name: 'poll' }))
    expect(await screen.findByTestId('rules-overwritten')).toHaveTextContent(T('monitoring.services.rulesEdit.overwritten'))
    expect(screen.getByLabelText('Down threshold (%)')).toHaveValue(70)
    // Typing again closes the notice: it is closed by who edits, not by the next poll.
    await user.clear(screen.getByLabelText('Down threshold (%)'))
    await waitFor(() => expect(screen.queryByTestId('rules-overwritten')).toBeNull())
  })

  it('without edits: the new values are shown, with no notice', async () => {
    const { user } = renderCard()
    expect(await screen.findByLabelText('Down threshold (%)')).toHaveValue(50)
    await user.click(screen.getByRole('button', { name: 'poll' }))
    await waitFor(() => expect(screen.getByLabelText('Down threshold (%)')).toHaveValue(70))
    expect(screen.queryByTestId('rules-overwritten')).toBeNull()
  })
})
