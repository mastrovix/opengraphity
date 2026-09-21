/**
 * GLI INTERRUTTORI DELL'AI STANNO IN QUATTRO POSTI: che siano gli stessi.
 *
 * L'elenco delle funzioni AI è scritto in `lib/aiSettings.ts` (`AI_FEATURES`,
 * la verità), nel tipo GraphQL `AIFeatureSwitches`, nell'input
 * `AIFeatureSwitchesInput` e — fuori dalla portata di questo test — nel web
 * (`AI_FEATURE_KEYS` e la selezione della query).
 *
 * ## Il difetto che questo test avrebbe visto
 * Aggiungendo `formDesigner` (19 set 2026) l'ho messo in `AI_FEATURES` e non
 * nello schema. Conseguenze, in ordine di gravità:
 *  1. il salvataggio delle impostazioni AI si sarebbe ROTTO per tutti — la
 *     validazione in scrittura pretende un booleano per ogni funzione, e
 *     l'input GraphQL non poteva più portarli tutti;
 *  2. l'interruttore non compariva in pagina, quindi la funzione era accesa e
 *     non spegnibile: il contrario di quello che l'interruttore promette.
 *
 * Nessuno dei due si vedeva compilando. Da qui in avanti si vedono qui.
 */
import { describe, it, expect } from 'vitest'
import { AI_FEATURES } from '../../lib/aiSettings.js'
import { organizationSDL } from '../schema-organization.js'

/** I nomi dei campi dentro un blocco `type X {…}` o `input X {…}` dell'SDL. */
function campiDi(sdl: string, blocco: string): string[] {
  const inizio = sdl.indexOf(`${blocco} {`)
  if (inizio < 0) throw new Error(`SDL: block "${blocco}" not found`)
  const fine = sdl.indexOf('\n  }', inizio)
  const corpo = sdl.slice(inizio, fine)
  // Le righe `nome: Tipo`, saltando le descrizioni fra tripli apici.
  return [...corpo.matchAll(/^\s{4}(\w+):\s/gm)].map((m) => m[1]!)
}

describe('gli interruttori dell\'AI', () => {
  const sdl = organizationSDL()

  it('il tipo AIFeatureSwitches elenca esattamente le funzioni di AI_FEATURES', () => {
    expect(campiDi(sdl, 'type AIFeatureSwitches').sort()).toEqual([...AI_FEATURES].sort())
  })

  it('l\'input AIFeatureSwitchesInput elenca esattamente le stesse', () => {
    // Se qui manca una funzione, SALVARE le impostazioni AI fallisce: la
    // validazione in scrittura pretende un booleano per ognuna.
    expect(campiDi(sdl, 'input AIFeatureSwitchesInput').sort()).toEqual([...AI_FEATURES].sort())
  })
})
