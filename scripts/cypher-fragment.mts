/**
 * CHIAMA UN COMPOSITORE DI CYPHER E RESTITUISCE QUELLO CHE PRODUCE.
 *
 * L'aiutante di `check-cypher.mjs` per le query COMPOSTE. Il guardiano non
 * può indovinare che cosa ci sia dentro un `${assignTeamCypher('e', 't')}`:
 * o lo chiama per davvero, o quella query resta fuori perimetro. Finora
 * restava fuori — 368 query, e da lì è passato il difetto del `WITH` che
 * tagliava una variabile letta prima.
 *
 * Gira sotto `tsx`, quindi importa i SORGENTI e non `dist`: un `dist` vecchio
 * farebbe verificare al guardiano il codice di ieri dicendo «tutto valido».
 *
 * Protocollo: sullo standard input un JSON `[{ file, fn, args }]`, sullo
 * standard output un JSON `[{ ok: true, cypher } | { ok: false, errore }]`,
 * nello stesso ordine. Un solo processo per tutte le chiamate: avviarne uno
 * per frammento costerebbe più dell'intera verifica.
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** Where the answer starts and ends on stdout: the only part check-cypher.mjs reads. */
export const FRAGMENTS_BEGIN = '<<<cypher-fragments>>>'
export const FRAGMENTS_END = '<<</cypher-fragments>>>'

interface Richiesta { file: string; fn: string; args: unknown[] }
type Risposta = { ok: true; cypher: string } | { ok: false; errore: string }

async function leggiStdin(): Promise<string> {
  const pezzi: Buffer[] = []
  for await (const p of process.stdin) pezzi.push(p as Buffer)
  return Buffer.concat(pezzi).toString('utf8')
}

const richieste = JSON.parse(await leggiStdin()) as Richiesta[]
const moduli = new Map<string, Record<string, unknown>>()
const risposte: Risposta[] = []

for (const r of richieste) {
  try {
    let mod = moduli.get(r.file)
    if (!mod) {
      mod = await import(pathToFileURL(resolve(r.file)).href) as Record<string, unknown>
      moduli.set(r.file, mod)
    }
    const f = mod[r.fn]
    if (typeof f !== 'function') {
      risposte.push({ ok: false, errore: `${r.fn} non è una funzione esportata da ${r.file}` })
      continue
    }
    const out: unknown = (f as (...a: unknown[]) => unknown)(...r.args)
    if (typeof out !== 'string') {
      // Un compositore che non torna una stringa non compone Cypher: meglio
      // dirlo che infilare «[object Object]» dentro una query e verificarla.
      risposte.push({ ok: false, errore: `${r.fn} non restituisce una stringa` })
      continue
    }
    risposte.push({ ok: true, cypher: out })
  } catch (e) {
    risposte.push({ ok: false, errore: e instanceof Error ? e.message : String(e) })
  }
}

/*
 * SI ESCE A MANO, e non è un dettaglio: importare un resolver dell'API tira
 * dentro BullMQ e il driver Neo4j, che aprono connessioni e tengono vivo
 * l'event loop per sempre. Senza questa riga il processo non finisce e il
 * guardiano resta appeso — visto succedere alla prima prova.
 */
/*
 * Between two markers (23 Sep 2026): the modules imported above write their own
 * logs on stdout too — the driver's «[neo4j] Connected …» arrives whenever the
 * connection is verified, before or after the answer — and JSON.parse of the
 * whole output failed at random. check-cypher.mjs reads what is between them.
 */
process.stdout.write(`\n${FRAGMENTS_BEGIN}${JSON.stringify(risposte)}${FRAGMENTS_END}\n`, () => { process.exit(0) })
