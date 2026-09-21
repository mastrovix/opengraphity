/**
 * UNA CONDIZIONE DI TRANSIZIONE DEVE NOMINARE TUTTO QUELLO CHE VERIFICA.
 *
 * `all_assessments_complete` non verifica gli assessment: per OGNI CI
 * impattato pretende TRE task — l'assessment funzionale, quello tecnico e il
 * PIANO di rilascio (`areAllAssessmentsComplete`). L'etichetta che il cliente
 * scegliesse nel disegnatore diceva «Tutti gli assessment completati», e il
 * rifiuto che leggeva diceva «Le valutazioni non sono ancora complete»:
 * entrambi tacevano il piano, che è la cosa che gli manca davvero.
 *
 * Il difetto era già stato corretto per `all_deployments_complete` — la sua
 * etichetta dice «e le verifiche» perché anche lì le cose verificate sono due —
 * e la stessa cura non era mai arrivata alla condizione che ne verifica tre.
 * Stesso difetto, sistemato a metà: questo test tiene ferme entrambe le metà
 * (17 set 2026).
 *
 * Perché un test sulle PAROLE e non sul comportamento: il comportamento è già
 * pinnato (`change/__tests__/autoTransitions.test.ts` pretende che la query
 * interroghi `HAS_ASSESSMENT` e `HAS_DEPLOY_PLAN`). Quello che nessuno
 * verificava è che le parole lo dicessero — e un'etichetta che mente manda
 * l'operatore a guardare i task sbagliati, dove trova tutto in ordine.
 *
 * Il nome della condizione resta com'è: è una stringa salvata sugli archi dei
 * workflow di ogni tenant, e cambiarla vorrebbe dire una migrazione dove un
 * refuso trasforma l'arco in un muro. Si aggiustano le parole, non la chiave.
 */
import { describe, it, expect } from 'vitest'
import it_ from '@/i18n/locales/it.json'
import en from '@/i18n/locales/en.json'

/**
 * Per ogni condizione che verifica più di quello che il suo nome dice: le
 * parole che etichetta e rifiuto DEVONO contenere, in italiano e in inglese.
 * Una sola di queste parole basta (le lingue hanno sinonimi), ma una ci vuole.
 */
const DEVE_NOMINARE: Record<string, { it: readonly string[]; en: readonly string[]; perche: string }> = {
  // Tre task per CI: funzionale, tecnico e il piano di rilascio.
  all_assessments_complete: {
    it: ['piano'],
    en: ['plan'],
    perche: 'verifica anche il DeployPlanTask, non solo i due assessment',
  },
  // Due task per CI: la validazione e il deployment.
  all_deployments_complete: {
    it: ['verific', 'validazion'],
    en: ['validation'],
    perche: 'verifica anche la ValidationTest, non solo il DeploymentTask',
  },
}

const dizionari = {
  it: it_ as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
}

/** Il valore di una chiave puntata, oppure `undefined` se non c'è. */
function valore(d: Record<string, unknown>, chiave: string): string | undefined {
  let cur: unknown = d
  for (const parte of chiave.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[parte]
  }
  return typeof cur === 'string' ? cur : undefined
}

describe('le condizioni di transizione nominano tutto quello che verificano', () => {
  for (const [condizione, regola] of Object.entries(DEVE_NOMINARE)) {
    for (const lingua of ['it', 'en'] as const) {
      // Le due frasi che il cliente legge: la scelta nel disegnatore, e il
      // motivo del rifiuto quando la transizione non scatta.
      for (const prefisso of ['workflow.conditionOption', 'errors.workflow.condition']) {
        const chiave = `${prefisso}.${condizione}`
        it(`${lingua} · ${chiave} nomina il resto (${regola.perche})`, () => {
          const testo = valore(dizionari[lingua], chiave)
          expect(testo, `${chiave} non esiste in ${lingua}.json`).toBeTypeOf('string')
          const basso = testo!.toLowerCase()
          const trovata = regola[lingua].some((p) => basso.includes(p))
          expect(trovata, `«${testo}» non nomina nessuna di [${regola[lingua].join(', ')}]: `
            + `la condizione ${regola.perche}, e chi legge questa frase andrebbe a guardare i task sbagliati`).toBe(true)
        })
      }
    }
  }

  /* La regola sa vedere il caso che la motiva, altrimenti è muta. */
  it('la regola riconosce l\'etichetta che taceva il piano', () => {
    const vecchia = 'Tutti gli assessment completati'.toLowerCase()
    expect(DEVE_NOMINARE['all_assessments_complete']!.it.some((p) => vecchia.includes(p))).toBe(false)
    const nuova = 'Tutte le valutazioni e il piano completati'.toLowerCase()
    expect(DEVE_NOMINARE['all_assessments_complete']!.it.some((p) => nuova.includes(p))).toBe(true)
  })
})
