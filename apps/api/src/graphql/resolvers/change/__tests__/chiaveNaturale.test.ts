/**
 * LA CHIAVE NATURALE DI UN TASK SI SCRIVE UNA VOLTA SOLA (22 set 2026).
 *
 * ## Il difetto che questo test chiude
 * I task di una change nascono con una MERGE sulla loro chiave naturale, e
 * `chiaviDaCreare` chiede prima quali mancano per non bruciare un codice a
 * ogni ripetizione — la numerazione usciva coi buchi, «dov'è il TASK00000065?».
 *
 * Ma la chiave era scritta DUE volte: in TypeScript per la domanda, e di
 * nuovo in Cypher (`$changeId + '-' + $ciId + '-owner'`) per la MERGE. Due
 * scritture della stessa cosa divergono, e infatti erano divergenti: la
 * chiave del piano di rilascio in TypeScript non aveva il suffisso
 * `-deployplan` che la MERGE usa. `chiaviDaCreare` non trovava MAI quel task
 * e rispondeva sempre «serve un codice nuovo»: il rimedio funzionava per gli
 * assessment e, in silenzio, non funzionava per il piano.
 *
 * Un codice bruciato non lascia tracce: nessun errore, nessun log, solo un
 * numero che manca. Per questo serve un test statico e non uno funzionale.
 *
 * ## La regola
 * Dentro una MERGE, `change_key` deve venire da UN valore solo — un parametro
 * (`$chiave`) o un campo della riga di UNWIND (`cc.valKey`) — mai da una
 * concatenazione dentro il Cypher. Così il valore che si è chiesto e quello
 * che si scrive sono per forza lo stesso.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CARTELLA = join(process.cwd(), 'src/graphql/resolvers/change')

const sorgenti = readdirSync(CARTELLA)
  .filter((n) => n.endsWith('.ts'))
  .map((n) => ({ nome: n, testo: readFileSync(join(CARTELLA, n), 'utf8') }))

/** `change_key: <qualcosa>` dentro una MERGE, con quello che segue fino alla parentesi. */
const CHIAVE_IN_MERGE = /MERGE\s*\([^)]*\{\s*change_key:\s*([^}]+)\}/g

describe('la chiave naturale dei task di una change', () => {
  it('i file ci sono ancora (se la cartella cambia, questo test va riscritto)', () => {
    expect(sorgenti.length).toBeGreaterThan(3)
    const conChiave = sorgenti.filter((f) => f.testo.includes('change_key:'))
    expect(conChiave.length, 'nessuna MERGE su change_key trovata: il test non guarda più niente').toBeGreaterThan(0)
  })

  it('non si compone MAI dentro il Cypher: un valore solo, parametro o campo della riga', () => {
    const composte: string[] = []
    for (const { nome, testo } of sorgenti) {
      for (const m of testo.matchAll(CHIAVE_IN_MERGE)) {
        const valore = m[1]!.trim()
        // Ammessi: `$chiave` e `cc.valKey`. Rifiutato: qualunque cosa con `+`.
        if (/\+/.test(valore)) {
          const riga = testo.slice(0, m.index).split('\n').length
          composte.push(`${nome}:${riga} → change_key: ${valore.slice(0, 60)}`)
        }
      }
    }
    expect(composte,
      'Qui la chiave naturale è composta DENTRO il Cypher. Deve arrivare come un valore solo '
      + '(un parametro o un campo della riga di UNWIND), lo stesso che si passa a `chiaviDaCreare`: '
      + 'due scritture della stessa chiave divergono, e quando divergono si bruciano codici in silenzio.',
    ).toEqual([])
  })

  it('e ogni posto che crea task chiede prima quali chiavi mancano', () => {
    const creaSenzaChiedere: string[] = []
    for (const { nome, testo } of sorgenti) {
      if (!/getNextTaskCodes\(/.test(testo)) continue
      if (/chiaviDaCreare\(/.test(testo)) continue
      creaSenzaChiedere.push(nome)
    }
    expect(creaSenzaChiedere,
      'Questi file prendono codici con `getNextTaskCodes` senza chiedere a `chiaviDaCreare` quali '
      + 'task nascono davvero: ogni ripetizione brucia un numero e la numerazione esce coi buchi.',
    ).toEqual([])
  })
})
