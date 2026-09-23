/**
 * PROBLEM CANDIDATES: «no cluster» is an answer only when something was
 * examined (D15, tour of 23 Sep 2026). What was left out — not analysed yet,
 * failed, beyond the cap — is always said.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { ProblemCandidatesPanel, type ProblemCandidatesResult } from './ProblemCandidatesPanel'

const NO_CLUSTER = /No cluster of recurring similar incidents found/
const result = (over: Partial<ProblemCandidatesResult> = {}): ProblemCandidatesResult =>
  ({ candidates: [], examined: 120, notAnalysed: 0, analysisFailures: 0, capped: false, ...over })

describe('ProblemCandidatesPanel', () => {
  it('everything examined and no cluster: says so, and nothing else', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result()} />)
    expect(screen.getByText(NO_CLUSTER)).toBeInTheDocument()
    expect(screen.getByTestId('candidates-coverage')).toBeEmptyDOMElement()
  })

  it('some left out: says what was examined and that the rest is queued', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ notAnalysed: 40 })} />)
    expect(screen.getByText('Examined 120 open incidents.')).toBeInTheDocument()
    expect(screen.getByText('40 not analysed yet: their analysis has been queued, try again in a few minutes.')).toBeInTheDocument()
    expect(screen.getByText(NO_CLUSTER)).toBeInTheDocument()
  })

  it('failed computations are an error line, counted apart from the queued ones', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ notAnalysed: 10, analysisFailures: 3 })} />)
    expect(screen.getByText('7 not analysed yet: their analysis has been queued, try again in a few minutes.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('3 could not be analysed: the computation failed (see Job Queue).')
  })

  it('beyond the cap: says that only the most recent ones were examined', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ examined: 300, capped: true })} />)
    expect(screen.getByText('Examined 300 open incidents.')).toBeInTheDocument()
    expect(screen.getByText('Only the 300 most recent open incidents were examined.')).toBeInTheDocument()
  })

  it('nothing analysed yet: NOT «no cluster», but that the analysis has been queued', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ examined: 0, notAnalysed: 25 })} />)
    expect(screen.getByText('No open incident is analysed yet: the analysis has been queued, try again in a few minutes.')).toBeInTheDocument()
    expect(screen.queryByText(NO_CLUSTER)).not.toBeInTheDocument()
    expect(screen.queryByText(/Examined/)).not.toBeInTheDocument()
  })

  it('no open incident at all: says there is nothing to compare', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ examined: 0 })} />)
    expect(screen.getByText('There are no open incidents to compare.')).toBeInTheDocument()
    expect(screen.queryByText(NO_CLUSTER)).not.toBeInTheDocument()
  })

  it('the candidates, with their incidents as links', () => {
    renderWithProviders(<ProblemCandidatesPanel result={result({ candidates: [{
      title: 'Repeated DB timeouts', motivation: 'Same error on the same CI',
      incidents: [{ id: 'i1', number: 'INC00000001', title: 'DB timeout', status: 'new', severity: 'high' }, { id: 'i2', number: null, title: 'Another DB timeout in the night', status: 'new', severity: 'high' }],
    }] })} />)
    expect(screen.getByText('Repeated DB timeouts')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'INC00000001' })).toHaveAttribute('href', '/incidents/i1')
    expect(screen.getByRole('link', { name: 'Another DB timeout i' })).toHaveAttribute('href', '/incidents/i2')
    expect(screen.queryByText(NO_CLUSTER)).not.toBeInTheDocument()
  })
})
