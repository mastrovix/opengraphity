/**
 * THE PRECEDENCE OF THE TEAM OF A NEW INCIDENT, in one place: chosen by hand,
 * then the CI's support group, then the AI's suggestion.
 */
import { describe, it, expect } from 'vitest'
import { incidentTeam } from './incidentTeam'

const DBA = { id: 'tm-2', name: 'DBA' }
const NET = { id: 'tm-1', name: 'Network Ops' }
const AI = { id: 'tm-9', name: 'Suggested' }

describe('incidentTeam', () => {
  it('nobody chose: the support group of the CI, or else the suggestion, or else nobody', () => {
    expect(incidentTeam(undefined, DBA, AI)).toEqual(DBA)
    expect(incidentTeam(undefined, null, AI)).toEqual(AI)
    expect(incidentTeam(undefined, null, null)).toBeNull()
  })

  it('a choice by hand wins over both — «no team» included', () => {
    expect(incidentTeam(NET, DBA, AI)).toEqual(NET)
    expect(incidentTeam(null, null, AI)).toBeNull()
  })
})
