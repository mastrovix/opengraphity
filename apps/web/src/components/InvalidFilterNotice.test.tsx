/**
 * «THE FILTER OF THIS LINK CANNOT BE READ» (total review · F-17).
 *
 * A list opened from a truncated or hand-written link used to drop the broken
 * filter in silence and show every row: whoever opened «only open P1s» read
 * the full list as if it were the P1s. This notice is what tells them. It must
 * be announced (an alert, so a screen reader says it too) exactly when the
 * list reports an unreadable filter, and be absent otherwise.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { InvalidFilterNotice } from './InvalidFilterNotice'

const t = i18n.getFixedT('en')

describe('InvalidFilterNotice', () => {
  it('a filter that reads fine: no notice at all', () => {
    renderWithProviders(<InvalidFilterNotice show={false} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an unreadable filter is announced, and says the table now shows every row', () => {
    renderWithProviders(<InvalidFilterNotice show />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(t('events.filters.advancedUrlInvalid'))
    expect(alert).toHaveTextContent(/shows every row/)
  })
})
