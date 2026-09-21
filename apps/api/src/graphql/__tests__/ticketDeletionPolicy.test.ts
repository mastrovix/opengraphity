/**
 * F14 (revisione del 14 set 2026): la cancellazione dei ticket ha una regola
 * sola, dichiarata in lib/operationPermissions.ts (permessi change.delete e problem.delete). Qui la si fissa: una mutation di
 * cancellazione nuova su un ticket, o una cancellazione non riservata agli
 * admin, fa fallire questo test finché la regola non viene rivista.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { allowedRoles } from '../../lib/__tests__/factoryRoles.js'

const DIR = fileURLToPath(new URL('../', import.meta.url))
const sdl = readdirSync(DIR).filter((f) => /^schema.*\.ts$/.test(f)).map((f) => readFileSync(`${DIR}${f}`, 'utf8')).join('\n')

describe('cancellazione dei ticket', () => {
  it('le sole mutation di cancellazione di ticket sono deleteChange e deleteProblem', () => {
    const deletions = [...sdl.matchAll(/\b(delete(?:Incident|Problem|Change|ServiceRequest|Request))\s*\(/g)].map((m) => m[1])
    expect([...new Set(deletions)].sort()).toEqual(['deleteChange', 'deleteProblem'])
  })
  it('sono entrambe riservate agli admin, con un permesso proprio', () => {
    expect(allowedRoles('Mutation', 'deleteChange')).toEqual(['admin'])
    expect(allowedRoles('Mutation', 'deleteProblem')).toEqual(['admin'])
  })
})
