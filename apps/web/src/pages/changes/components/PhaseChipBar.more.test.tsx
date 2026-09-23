/**
 * THE PHASE BAR ON TOP OF A CHANGE.
 *
 * It says at a glance where a change is in its workflow: the phases behind it
 * are done, the one it is in is current, the ones ahead are pending. The
 * tooltip of each dot says it in words, and it is what a user reads when the
 * colours are not enough. Pinned here: a change in a terminal step has every
 * phase done (not "closed" pending after itself), a step the workflow does not
 * know makes nothing current instead of lighting a random dot, and a workflow
 * not loaded yet draws nothing rather than an empty bar.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PhaseChipBar } from './PhaseChipBar'

const STEPS = [
  { name: 'draft',      label: 'Draft',      isTerminal: false },
  { name: 'assessment', label: 'Assessment', isTerminal: false },
  { name: 'approval',   label: 'Approval',   isTerminal: false },
  { name: 'closed',     label: 'Closed',     isTerminal: true },
]

const titles = () => STEPS.map((s) => screen.getByText(s.label).parentElement?.getAttribute('title'))

describe('PhaseChipBar', () => {
  it('draws nothing while the workflow has no steps', () => {
    const { container } = render(<PhaseChipBar current="draft" steps={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('in the middle of the workflow: earlier phases completed, this one current, later ones pending', () => {
    render(<PhaseChipBar current="assessment" steps={STEPS} />)
    expect(titles()).toEqual([
      'Draft — completed',
      'Assessment — current',
      'Approval — pending',
      'Closed — pending',
    ])
  })

  it('at a terminal step every phase is completed and none is current', () => {
    render(<PhaseChipBar current="closed" steps={STEPS} />)
    expect(titles()).toEqual([
      'Draft — completed',
      'Assessment — completed',
      'Approval — completed',
      'Closed — completed',
    ])
  })

  it('a step the workflow does not know makes nothing current: everything reads as pending', () => {
    render(<PhaseChipBar current="legacy_step" steps={STEPS} />)
    expect(titles()).toEqual([
      'Draft — pending',
      'Assessment — pending',
      'Approval — pending',
      'Closed — pending',
    ])
  })
})
