/**
 * LE DISPOSIZIONI DELLA TELA NOMINANO PASSI CHE ESISTONO (22 set 2026).
 *
 * ## Il difetto che ha fatto nascere questo test
 * `WorkflowCanvas.tsx` porta, per ogni workflow seminato, dove sta ogni passo e
 * da quale lato esce ogni freccia. Tre di quelle tabelle — `STANDARD_*`,
 * `NORMAL_*`, `EMERGENCY_*` — nominavano i passi di quando si pensava a UNA
 * DEFINIZIONE PER TIPO DI CHANGE (`draft → cab_approval → validation → …`).
 * Quella forma è sparita, le tabelle no: ZERO chiavi in comune con la
 * definizione «Change RFC Process» spedita davvero. Risultato, la tela delle
 * change — e quella di richieste, problem e KB — cadeva sempre sulla fila
 * automatica, e nessuno se ne accorgeva perché il risultato è comunque
 * disegnabile.
 *
 * Peggio: il commento accanto sosteneva il contrario, «sono le disposizioni
 * scritte per i passi che quella definizione ha davvero». Prosa che il codice
 * smentiva. È esattamente il motivo per cui qui si mette una PROVA.
 *
 * ## Che cosa pretende
 * Per ogni workflow seminato, nei DUE versi:
 * - ogni chiave delle tabelle nomina un passo / una transizione che esiste;
 * - ogni passo ha la sua posizione e ogni transizione i suoi lati.
 * Rinominare un passo in un seed fa cadere questo test, che è il solo modo per
 * cui la tela non torna a mentire.
 *
 * ## Perché legge il file come testo
 * `WorkflowCanvas.tsx` importa `@xyflow/react`: importarlo da un test dell'API
 * vorrebbe dire tirarsi dentro il disegnatore intero. Le tabelle sono letterali
 * piatti, e leggerli è preciso quanto importarli. Stesso mestiere di
 * `tenantScoping`, che legge il Cypher senza eseguirlo.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW,
  PROBLEM_WORKFLOW, KB_ARTICLE_WORKFLOW_BASE,
} from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../../scripts/lib/workflowDefinitions.js'

const CANVAS = join(__dirname, '../../../../web/src/pages/workflow/WorkflowCanvas.tsx')
const testo = readFileSync(CANVAS, 'utf-8')

/** Il blocco `export const NOME … = { … }` (o `= new Set([ … ])`), graffe bilanciate. */
function blocco(nome: string, apre: '{' | '[', chiude: '}' | ']'): string {
  const i = testo.indexOf(`export const ${nome}`)
  if (i < 0) throw new Error(`tabella ${nome} assente da WorkflowCanvas.tsx`)
  // Dopo l'`=`, non dopo il nome: l'annotazione di tipo porta le sue graffe
  // (`Record<string, { x: number }>`) e sono le prime che si incontrano.
  const uguale = testo.indexOf('=', i)
  const da = testo.indexOf(apre, uguale)
  let livello = 0
  for (let k = da; k < testo.length; k++) {
    if (testo[k] === apre) livello++
    else if (testo[k] === chiude && --livello === 0) return testo.slice(da, k + 1)
  }
  throw new Error(`blocco di ${nome} mai chiuso`)
}

/**
 * Le chiavi del PRIMO livello. Gli oggetti annidati si schiacciano a `0`
 * finché non ne resta nessuno: quel che resta è `chiave: 0`, e le chiavi
 * interne (`x`, `sourceHandle`) sono sparite con loro.
 */
function chiavi(nome: string): string[] {
  let corpo = blocco(nome, '{', '}').slice(1, -1)
  let prima: string
  do { prima = corpo; corpo = corpo.replace(/\{[^{}]*\}/g, '0') } while (corpo !== prima)
  return [...corpo.matchAll(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*0/g)].map((m) => m[1] ?? m[2]!)
}

/** Le coppie `nome: { x, y }` del primo livello. */
function posizioni(nome: string): Array<{ passo: string; x: number; y: number }> {
  const corpo = blocco(nome, '{', '}')
  return [...corpo.matchAll(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*\{\s*x:\s*(-?\d+),\s*y:\s*(-?\d+)\s*\}/g)]
    .map((m) => ({ passo: m[1] ?? m[2]!, x: Number(m[3]), y: Number(m[4]) }))
}

/**
 * L'ingombro di un passo sulla tela più l'aria che gli si vuole intorno.
 *
 * Il nodo misura 160×88 — `width: 160` e `minHeight: 80` di `WorkflowStepNode`,
 * col `padding: 12` e il `borderWidth: 2` già dentro (box-sizing: border-box);
 * misurato nel browser, non dedotto. `ARIA` è la distanza minima che si vuole
 * fra due passi: senza, due nodi che si sfiorano passerebbero il test e
 * sarebbero comunque illeggibili.
 */
const NODO_LARGO = 160
const NODO_ALTO  = 88
const ARIA       = 40
const LARGO = NODO_LARGO + ARIA
const ALTO  = NODO_ALTO + ARIA

/** Le stringhe dentro `new Set([ … ])`. */
function insieme(nome: string): string[] {
  return [...blocco(nome, '[', ']').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

interface Forma { passi: Set<string>; archi: Set<string>; archiConTrigger: Set<string> }

function formaDi(definizioni: Array<{ steps: Array<{ name: string }>; transitions: Array<{ fromStepName: string; toStepName: string; trigger: string }> }>): Forma {
  const passi = new Set<string>()
  const archi = new Set<string>()
  const archiConTrigger = new Set<string>()
  for (const d of definizioni) {
    for (const s of d.steps) passi.add(s.name)
    for (const t of d.transitions) {
      archi.add(`${t.fromStepName}→${t.toStepName}`)
      archiConTrigger.add(`${t.fromStepName}→${t.toStepName}→${t.trigger}`)
    }
  }
  return { passi, archi, archiConTrigger }
}

const CASI: Array<{ chiave: string; posizioni: string; lati: string; indietro: string; forma: Forma }> = [
  // L'incident ha DUE definizioni: quella base e quella di sicurezza, che
  // infila `security_review`. Una tabella sola serve entrambe.
  { chiave: 'incident',        posizioni: 'INCIDENT_POSITIONS',        lati: 'INCIDENT_HANDLES',        indietro: 'INCIDENT_BACK',        forma: formaDi([INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW]) },
  { chiave: 'change',          posizioni: 'CHANGE_POSITIONS',          lati: 'CHANGE_HANDLES',          indietro: 'CHANGE_BACK',          forma: formaDi([CHANGE_RFC_WORKFLOW]) },
  { chiave: 'service_request', posizioni: 'SERVICE_REQUEST_POSITIONS', lati: 'SERVICE_REQUEST_HANDLES', indietro: 'SERVICE_REQUEST_BACK', forma: formaDi([SERVICE_REQUEST_WORKFLOW]) },
  { chiave: 'problem',         posizioni: 'PROBLEM_POSITIONS',         lati: 'PROBLEM_HANDLES',         indietro: 'PROBLEM_BACK',         forma: formaDi([PROBLEM_WORKFLOW]) },
  { chiave: 'kb_article',      posizioni: 'KB_POSITIONS',              lati: 'KB_HANDLES',              indietro: 'KB_BACK',              forma: formaDi([KB_ARTICLE_WORKFLOW_BASE]) },
]

describe('le disposizioni della tela e i workflow seminati', () => {
  for (const caso of CASI) {
    describe(caso.chiave, () => {
      it('non colloca passi che non esistono', () => {
        expect(chiavi(caso.posizioni).filter((p) => !caso.forma.passi.has(p))).toEqual([])
      })

      it('colloca ogni passo che esiste', () => {
        const collocati = new Set(chiavi(caso.posizioni))
        expect([...caso.forma.passi].filter((p) => !collocati.has(p))).toEqual([])
      })

      it('non disegna archi che non esistono', () => {
        const inesistenti = chiavi(caso.lati).filter((k) => {
          // La chiave lunga `da→a→trigger` vince sulla corta: serve a dare lati
          // diversi a due archi fra gli stessi passi (l'escalation a mano e
          // quella per SLA sforato).
          const conTrigger = k.split('→').length === 3
          return conTrigger ? !caso.forma.archiConTrigger.has(k) : !caso.forma.archi.has(k)
        })
        expect(inesistenti).toEqual([])
      })

      it('dà i lati a ogni arco che esiste', () => {
        const disegnati = new Set(chiavi(caso.lati))
        const conTrigger = new Set([...disegnati].filter((k) => k.split('→').length === 3))
        const scoperti = [...caso.forma.archiConTrigger].filter((k) => {
          const corta = k.split('→').slice(0, 2).join('→')
          return !conTrigger.has(k) && !disegnati.has(corta)
        })
        expect(scoperti).toEqual([])
      })

      it('non sovrappone due passi', () => {
        const p = posizioni(caso.posizioni)
        expect(p.length).toBe(chiavi(caso.posizioni).length)
        const scontri: string[] = []
        for (let i = 0; i < p.length; i++) {
          for (let k = i + 1; k < p.length; k++) {
            const a = p[i]!, b = p[k]!
            if (Math.abs(a.x - b.x) < LARGO && Math.abs(a.y - b.y) < ALTO) scontri.push(`${a.passo} ~ ${b.passo}`)
          }
        }
        expect(scontri).toEqual([])
      })

      it('non chiama «ritorno» un arco che non esiste', () => {
        expect(insieme(caso.indietro).filter((k) => !caso.forma.archi.has(k))).toEqual([])
      })
    })
  }

  it('la tabella unica copre tutte le chiavi, `none` compresa', () => {
    const dichiarate = chiavi('DISPOSIZIONI')
    expect(dichiarate.sort()).toEqual([...CASI.map((c) => c.chiave), 'none'].sort())
  })
})
