import { describe, it, expect } from 'vitest'
import { voceAttiva } from './menuActive'

const MENU = ['/dashboard', '/incidents', '/reports', '/reports/sla', '/reports/ola-uc', '/custom-reports', '/cmdb', '/ci/server']

describe('voceAttiva: una voce sola, la più specifica', () => {
  it('su /reports/sla si accende SLA Report, non AI Analysis', () => {
    expect(voceAttiva('/reports/sla', MENU)).toBe('/reports/sla')
    expect(voceAttiva('/reports/ola-uc', MENU)).toBe('/reports/ola-uc')
  })
  it('su /reports resta AI Analysis', () => {
    expect(voceAttiva('/reports', MENU)).toBe('/reports')
  })
  it('una pagina interna accende la voce da cui discende', () => {
    expect(voceAttiva('/incidents/abc', MENU)).toBe('/incidents')
    expect(voceAttiva('/ci/server/42', MENU)).toBe('/ci/server')
  })
  it('un prefisso che non è un segmento intero non conta', () => {
    expect(voceAttiva('/reportsX', MENU)).toBeNull()
    expect(voceAttiva('/custom-reports', MENU)).toBe('/custom-reports')
  })
  it('una pagina fuori dal menu non accende niente', () => {
    expect(voceAttiva('/servers', MENU)).toBeNull()
  })
})
