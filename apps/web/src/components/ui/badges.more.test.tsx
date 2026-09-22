/**
 * The parts of the shared badges not covered by badges.test.tsx: the risk
 * style hook (used where there is no pill, like the What-if score circle) and
 * the anomaly severity badge. If they regress, the What-if circle shows a
 * guessed band before the tenant thresholds are known, or an anomaly with an
 * out-of-scale severity looks like a normal one.
 */
import { describe, it, expect } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRiskScoreStyle, AnomalySeverityBadge, RISK_BAND_VOCABULARY } from './badges'
import { RiskBandContext, bandForScore, type RiskBandThreshold } from '@/contexts/RiskBandContext'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { palette } from '@/lib/tokens'

const BANDS: RiskBandThreshold[] = [{ band: 'low', upTo: 30 }, { band: 'high', upTo: 100 }]

function wrapper(known: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <DomainVocabularyContext.Provider value={{
        valuesOf: (n) => (n === RISK_BAND_VOCABULARY ? ['low', 'high'] : null),
        labelOf: () => null,
        colorOf: (_n, v) => (v === 'high' ? 'danger' : 'success') as never,
        vocabularyLabelOf: () => null, entriesOf: () => null, loading: false, error: null,
      }}>
        <RiskBandContext.Provider value={{ bandOf: (s) => (known ? bandForScore(BANDS, s) : null), loading: false, error: null }}>
          {children}
        </RiskBandContext.Provider>
      </DomainVocabularyContext.Provider>
    )
  }
}

describe('useRiskScoreStyle', () => {
  it('returns the dictionary colour of the band the score falls in', () => {
    const { result } = renderHook(() => useRiskScoreStyle(), { wrapper: wrapper(true) })
    expect(result.current(80)?.color).toBe(palette.danger.text)
    expect(result.current(10)?.color).toBe(palette.success.text)
  })

  it('returns null while the thresholds are unknown instead of guessing a band', () => {
    const { result } = renderHook(() => useRiskScoreStyle(), { wrapper: wrapper(false) })
    expect(result.current(80)).toBeNull()
  })
})

describe('AnomalySeverityBadge', () => {
  it('shows a dash when there is no severity', () => {
    render(<AnomalySeverityBadge value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows the product label of a known severity, raw value in the title', () => {
    render(<AnomalySeverityBadge value="high" />)
    const pill = screen.getByTitle('high')
    expect(pill).toHaveTextContent(/high/i)
    expect(pill).toHaveStyle({ color: 'var(--color-warning-text)' })
  })

  it('shows an out-of-scale value raw and in red: it is a data defect, not a customer choice', () => {
    render(<AnomalySeverityBadge value="apocalyptic" />)
    const pill = screen.getByTitle('apocalyptic')
    expect(pill).toHaveTextContent('apocalyptic')
    expect(pill).toHaveStyle({ color: 'var(--color-danger-text)' })
  })
})
