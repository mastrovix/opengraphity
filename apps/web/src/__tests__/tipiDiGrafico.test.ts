/**
 * UN TIPO DI GRAFICO NON ARRIVA A META STRADA (19 set 2026).
 *
 * `top_n` è stato aggiunto all'API e ai suoi test a marzo, e nel web non
 * esisteva: non si poteva scegliere, e chi apriva un report che lo usava
 * leggeva «top_n» come nome del grafico. Il 19 set l'ho offerto nel menu — e
 * ho scoperto pubblicando che il renderer non aveva il suo `case` e l'elenco
 * delle icone non aveva la sua voce: il prodotto offriva una scelta che
 * finiva in «grafico non disponibile».
 *
 * Lato API i due `switch` esaustivi su `ChartType` fanno fallire la
 * compilazione quando manca un ramo, ed è per questo che `top_n` è arrivato
 * in fondo SANO. Lato web non c'è nessun vincolo di tipo: questo test è quel
 * vincolo, e dice in un colpo solo dove va aggiunta la prossima voce.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHART_TYPES } from '../components/ReportChartConfig'
import { CHART_ICON_MAP } from '../pages/reports/reportIcons'
// `itLocale` e non `it`: `it` è la funzione di vitest, e l'import la copriva.
import itLocale from '../i18n/locales/it.json'
import enLocale from '../i18n/locales/en.json'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tipi = CHART_TYPES.map((c) => c.value)

describe('i tipi di grafico', () => {
  it('sono gli stessi che conosce l\'API', () => {
    // La lista dell'API è la verità: il web non deve offrirne di più (una
    // scelta che il server rifiuta) né di meno (una scelta invisibile).
    const sorgente = fs.readFileSync(path.resolve(SRC, '../../api/src/lib/reportQueryBuilder.ts'), 'utf8')
    const riga = /export const CHART_TYPES = \[([^\]]*)\]/.exec(sorgente)?.[1] ?? ''
    const dellApi = [...riga.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    expect(tipi.sort()).toEqual(dellApi.sort())
  })

  it('hanno tutti un\'icona', () => {
    expect(tipi.filter((t) => !(t in CHART_ICON_MAP))).toEqual([])
  })

  it('hanno tutti un ramo nel renderer', () => {
    const renderer = fs.readFileSync(path.resolve(SRC, 'components/ReportChartRenderer.tsx'), 'utf8')
    const resi = [...renderer.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!)
    expect(tipi.filter((t) => !resi.includes(t))).toEqual([])
  })

  it('hanno nome e descrizione in tutte e due le lingue', () => {
    const mancanti: string[] = []
    for (const c of CHART_TYPES) {
      for (const [lingua, dizionario] of [['it', itLocale], ['en', enLocale]] as const) {
        const nodo = (dizionario as Record<string, unknown>)['reportChart'] as Record<string, Record<string, string>>
        const nome = c.labelKey.split('.').pop()!
        const desc = c.descKey.split('.').pop()!
        if (!nodo['type']?.[nome]) mancanti.push(`${lingua}:${c.labelKey}`)
        if (!nodo['desc']?.[desc]) mancanti.push(`${lingua}:${c.descKey}`)
      }
    }
    expect(mancanti).toEqual([])
  })
})

/**
 * LE ETICHETTE DEL VALORE ARRIVANO A TUTTI (20 set 2026, dal giro nel
 * browser: «nella linea dove ci sono i puntini dovrebbe esserci anche il
 * valore»).
 *
 * `REPORT_STYLE = { showValueLabels: true }` è la scelta della PAGINA: in un
 * report il numero si legge. Linea e area erano gli unici due rami del
 * renderer a non riceverlo — una dimenticanza che nessun tipo vede, perché il
 * grafico si disegna lo stesso, solo muto. Il test guarda i rami, non il
 * pixel: chi aggiunge un tipo nuovo se ne accorge qui.
 */
describe('lo stile dei report raggiunge ogni grafico', () => {
  it('ogni chiamata a un costruttore di opzioni riceve REPORT_STYLE', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/ReportChartRenderer.tsx'),
      'utf8',
    )
    // Una riga per chiamata: le opzioni stanno tutte sulla stessa riga.
    const chiamate = src.split('\n').filter((riga) => /build[A-Za-z]*Option\(/.test(riga))
    expect(chiamate.length).toBeGreaterThan(4)
    const senzaStile = chiamate.filter((c) => !c.includes('REPORT_STYLE')).map((c) => c.trim())
    expect(senzaStile).toEqual([])
  })
})
