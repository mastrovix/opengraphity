/**
 * IL CAMMINO ESISTE DAVVERO NEL WORKFLOW DI FABBRICA (21 set 2026).
 *
 * ## Perché questo test esiste
 * `indagineAutomatica.test.ts` verifica che, DATO un cammino, il Problem lo
 * percorra. Non può dire se quel cammino esista: là la query è finta.
 *
 * E non esisteva. La prima stesura cercava un passo a distanza UNO, e nel
 * workflow di fabbrica da `under_investigation` non si arriva a `resolved` in
 * un passo — le uscite sono `change_requested`, `rejected`, `deferred`,
 * `known_error`. La chiusura automatica non sarebbe scattata mai: un log
 * d'errore ogni quarto d'ora e il Problem aperto per sempre. Tutto verde,
 * perché nessun test guardava il workflow VERO.
 *
 * Questo lo guarda: legge `PROBLEM_WORKFLOW`, quello che i tenant ricevono, e
 * cammina sulle sue transizioni come fa la query in Neo4j. Se qualcuno toglie
 * una transizione e spezza la catena, cade qui — prima che lo scopra un
 * Problem vero restando fermo in silenzio.
 */
import { describe, it, expect } from 'vitest'
import { PROBLEM_WORKFLOW } from '@opengraphity/workflow'
import { SCOPO_INDAGINE, CATEGORIA_RISOLTO, MAX_PASSI } from '../indagineAutomatica.js'

type Meta = { purpose?: unknown; category?: unknown; is_initial?: unknown }
const meta = (nome: string): Meta => (PROBLEM_WORKFLOW.steps.find((s) => s.name === nome)?.metadata ?? {}) as Meta

const archi: Array<[string, string]> = PROBLEM_WORKFLOW.transitions.map((t) => [t.fromStepName, t.toStepName])

/** Il cammino più corto, contando i passi come li conta `shortestPath`. */
function camminoPiuCorto(da: string, arrivato: (nome: string) => boolean): string[] | null {
  const vicini = new Map<string, string[]>()
  for (const [a, b] of archi) vicini.set(a, [...(vicini.get(a) ?? []), b])
  const coda: string[][] = [[da]]
  const visti = new Set([da])
  while (coda.length > 0) {
    const cammino = coda.shift()!
    const ultimo = cammino[cammino.length - 1]!
    if (ultimo !== da && arrivato(ultimo)) return cammino.slice(1)
    if (cammino.length > MAX_PASSI) continue
    for (const v of vicini.get(ultimo) ?? []) {
      if (visti.has(v)) continue
      visti.add(v)
      coda.push([...cammino, v])
    }
  }
  return null
}

const passoIniziale = PROBLEM_WORKFLOW.steps.find((s) => (s.metadata as Meta | undefined)?.is_initial === true)?.name
const inAnalisi = (n: string) => meta(n).purpose === SCOPO_INDAGINE
const risolto   = (n: string) => meta(n).category === CATEGORIA_RISOLTO

describe('il giro dell\'Autoanalisi cammina sul workflow di fabbrica', () => {
  it('il workflow ha un passo iniziale, uno di analisi e uno risolto', () => {
    expect(passoIniziale).toBeDefined()
    expect(PROBLEM_WORKFLOW.steps.filter((s) => inAnalisi(s.name)).length).toBeGreaterThan(0)
    expect(PROBLEM_WORKFLOW.steps.filter((s) => risolto(s.name)).length).toBeGreaterThan(0)
  })

  it('dal passo iniziale si arriva all\'analisi entro MAX_PASSI', () => {
    const cammino = camminoPiuCorto(passoIniziale!, inAnalisi)
    expect(cammino, `nessun cammino da "${passoIniziale}" a un passo di scopo "${SCOPO_INDAGINE}" entro ${MAX_PASSI} passi`).not.toBeNull()
    expect(cammino).toEqual(['under_investigation'])
  })

  it('dall\'analisi si arriva a RISOLTO entro MAX_PASSI — ed è la via che serviva', () => {
    const daAnalisi = PROBLEM_WORKFLOW.steps.find((s) => inAnalisi(s.name))!.name
    const cammino = camminoPiuCorto(daAnalisi, risolto)
    expect(cammino, `nessun cammino da "${daAnalisi}" a un passo di categoria "${CATEGORIA_RISOLTO}" entro ${MAX_PASSI} passi`).not.toBeNull()
    /*
     * DUE passi, e sono questi. In ITIL un Problem di cui si conosce la causa
     * e si è identificato il rimedio È un Known Error: passare di lì non è una
     * scorciatoia, è il posto giusto. Se un giorno il workflow offrisse una
     * via diretta questo test andrà aggiornato — e chi lo aggiorna avrà letto
     * qui perché la via lunga andava bene.
     */
    expect(cammino).toEqual(['known_error', 'resolved'])
    expect(cammino!.length).toBeLessThanOrEqual(MAX_PASSI)
  })

  it('e quindi il giro intero, dalla nascita alla chiusura, sta dentro il tetto', () => {
    const fino = camminoPiuCorto(passoIniziale!, inAnalisi)!
    const poi  = camminoPiuCorto(fino[fino.length - 1]!, risolto)!
    expect(fino.length).toBeLessThanOrEqual(MAX_PASSI)
    expect(poi.length).toBeLessThanOrEqual(MAX_PASSI)
  })
})
