/**
 * Revisione del 14 set 2026 · F9: il colore di un valore di vocabolario sta nel
 * Dizionario del cliente (`colorOf` + `vocabularyValueStyle`), non in tabelle
 * scritte nelle pagine. `PRIORITY_COLOR` esisteva in cinque copie, e un valore
 * aggiunto o rinominato dal cliente appariva grigio. Questo guardiano impedisce
 * che una tabella per valore torni.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return ['__tests__', 'i18n', 'test'].includes(name) ? [] : sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/**
 * Tabelle che NON sono di un vocabolario del Dizionario, con la ragione. Ogni
 * voce è un permesso: se la ragione smette di essere vera, va tolta.
 *
 * Il permesso è sulla COSTANTE, non sul file (revisione totale · G-ANO-6): in
 * `ui/badges.tsx` convivono il badge che legge i colori del Dizionario e la
 * scala del prodotto delle anomalie; un permesso per tutto il file avrebbe
 * spento il guardiano proprio dove serve di più.
 */
const PERMESSI: Record<string, string> = {
  'pages/settings/NotificationRuleList.tsx:SEVERITY_COLOR': 'la severità di una notifica è la scala del prodotto NOTIFICATION_SEVERITIES (info/success/warning/error), non un vocabolario del cliente',
  'components/ui/badges.tsx:ANOMALY_SEVERITY_STYLE': 'la severità di un\'anomalia è la scala del prodotto ANOMALY_SEVERITIES (low/medium/high/critical), che il Dizionario non governa: la tendina della pagina usa le stesse etichette',
}

describe('colori per valore di vocabolario', () => {
  it('nessuna tabella di colori per priorità, severità, stato del CI o categoria KB nel web', () => {
    const pattern = /\bconst\s+(\w*(?:PRIORITY|SEVERITY|CI_STATUS|KB_CATEGORY)\w*_(?:COLOR|COLORS|STYLE|STYLES|DOT|BG|TINT))\b/
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = pattern.exec(line)
        if (m && !PERMESSI[`${relative(SRC, file)}:${m[1]!}`]) offenders.push(`${relative(SRC, file)}:${i + 1}  ${m[1]!}`)
      })
    }
    expect(offenders, 'Il colore di un valore si sceglie nel Dizionario: usa colorOf + vocabularyValueStyle.').toEqual([])
  })
})
