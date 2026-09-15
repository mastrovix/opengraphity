/** Giro UI del 15 set 2026 · U-10: la ricerca dei CI dice quali tipi non propone. */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { CIExclusionHint } from './CIExclusionHint'

describe('CIExclusionHint', () => {
  it('con tipi esclusi li nomina; senza (o finché non si sa) non dice nulla', () => {
    const { rerender } = renderWithProviders(<CIExclusionHint excluded={['application']} />)
    expect(screen.getByTestId('ci-exclusion-hint')).toHaveTextContent('CIs of type application are not offered: that type is excluded for this kind of ticket.')
    rerender(<CIExclusionHint excluded={[]} />)
    expect(screen.queryByTestId('ci-exclusion-hint')).toBeNull()
    rerender(<CIExclusionHint excluded={undefined} />)
    expect(screen.queryByTestId('ci-exclusion-hint')).toBeNull()
  })
})
