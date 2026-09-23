/**
 * FROM A PRIORITY BACK TO IMPACT AND URGENCY: when there is nothing to go back to.
 *
 * Before the priority matrix has arrived there is no pair to propose, and a
 * cell that does not carry both inputs cannot give one: the form is left for
 * the person to fill in, instead of being prefilled with half a guess.
 */
import { describe, it, expect } from 'vitest'
import { impactUrgencyFromPriority, matrixKey, type PriorityMatrix } from './priority'

describe('impactUrgencyFromPriority', () => {
  it('without the matrix there is nothing to propose', () => {
    expect(impactUrgencyFromPriority(null, 'high')).toBeNull()
  })

  it('a cell with only one input proposes nothing', () => {
    const lopsided: PriorityMatrix = {
      impacts: ['high'], urgencies: ['high'], priorities: ['critical'],
      cells: [{ key: matrixKey('high', 'high'), inputs: ['high'], value: 'critical' }],
    }
    expect(impactUrgencyFromPriority(lopsided, 'critical')).toBeNull()
  })
})
