/**
 * THE HEALTH AS AN ICON BESIDE THE NAME (26 Sep 2026, the owner: «meglio
 * mettere un'icona» instead of a coloured stripe along the row).
 *
 * What a user loses if this regresses: a list whose health is told by a stripe
 * that the hover stripe covers, or by nothing at all; an unknown health drawn
 * in a plausible colour.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CIHealthIcon } from '@/pages/events/eventShared'
import { ServiceHealthIcon } from './servicesShared'

describe('health icons', () => {
  it('one icon per health, decorative, its colour kept in the tables (data-tone)', () => {
    for (const h of ['down', 'degraded', 'operational'] as const) {
      const { container, unmount } = render(<CIHealthIcon health={h} />)
      const span = container.querySelector('span')!
      expect(span).toHaveAttribute('aria-hidden', 'true')
      expect(span).toHaveAttribute('data-tone', h)
      expect(span.querySelector('svg')).not.toBeNull()
      unmount()
    }
    for (const h of ['down', 'degraded', 'operational', 'maintenance', 'unknown']) {
      const { container, unmount } = render(<ServiceHealthIcon health={h} />)
      expect(container.querySelector('span[data-tone] svg')).not.toBeNull()
      unmount()
    }
  })

  it('a health out of the vocabulary is said in the console, not drawn as a plausible one', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ServiceHealthIcon health="exploded" />)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
