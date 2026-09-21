/**
 * QUALE ITER USA «per categoria».
 *
 * La pagina lo SCRIVE sotto la tendina, quindi se sbaglia dice una bugia su
 * cosa succederà quando qualcuno aprirà una richiesta. La regola è quella del
 * motore (`initialStepSelection` in packages/workflow): prima la definizione
 * con la stessa categoria, se no quella senza categoria, a parità la versione
 * più alta; e le spente non contano. Qui la si pinna, perché due copie della
 * stessa priorità divergono al primo dubbio.
 */
import { describe, it, expect } from 'vitest'
import { iterPerCategoria } from '../ItineraryPanel'

const def = (over: Partial<{ id: string; name: string; category: string | null; active: boolean; version: number }>) => ({
  id: over.id ?? 'x', name: over.name ?? 'X', entityType: 'service_request',
  category: over.category ?? null, active: over.active ?? true, version: over.version ?? 1,
})

describe('iterPerCategoria', () => {
  it('la categoria uguale vince su quella senza categoria', () => {
    const scelto = iterPerCategoria([def({ name: 'Generico' }), def({ name: 'Hardware', category: 'hardware' })], 'hardware')
    expect(scelto?.name).toBe('Hardware')
  })

  it('senza una definizione della categoria si ripiega su quella senza categoria', () => {
    const scelto = iterPerCategoria([def({ name: 'Generico' }), def({ name: 'Sicurezza', category: 'security' })], 'hardware')
    expect(scelto?.name).toBe('Generico')
  })

  it('a parità vince la versione più alta', () => {
    const scelto = iterPerCategoria([def({ name: 'Vecchio', version: 1 }), def({ name: 'Nuovo', version: 3 })], null)
    expect(scelto?.name).toBe('Nuovo')
  })

  it('una definizione spenta non si applica: una richiesta nuova non la userebbe', () => {
    expect(iterPerCategoria([def({ name: 'Spento', active: false })], 'hardware')).toBeNull()
  })

  it('quando non si applica niente lo dice, invece di far finta', () => {
    expect(iterPerCategoria([def({ name: 'Sicurezza', category: 'security' })], 'hardware')).toBeNull()
  })
})
