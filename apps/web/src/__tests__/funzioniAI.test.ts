/**
 * L'ELENCO DELLE FUNZIONI AI È LO STESSO DA TUTTE LE PARTI (19 set 2026).
 *
 * Le copie sono cinque: `AI_FEATURES` nell'API, il tipo e l'input GraphQL,
 * `AI_FEATURE_KEYS` nel web e la selezione della query. Due guardiani già
 * c'erano, e ognuno verificava il SUO lato contro il SUO elenco: api con api,
 * web con web. I due elenchi non si incontravano mai — aggiungendo una
 * funzione solo nell'API, entrambi passavano e l'interruttore non compariva
 * in pagina, cioè la funzione restava accesa e non spegnibile.
 *
 * Qui si incontrano. E si controlla anche la cosa che nessuno guardava: che
 * ogni funzione abbia il suo nome e la sua spiegazione nelle due lingue —
 * `AISection` le compone con un prefisso dinamico, e `check-i18n` su un
 * prefisso verifica solo che UNA chiave esista.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_FEATURE_KEYS } from '@/lib/aiFeatures'
import itLocale from '../i18n/locales/it.json'
import enLocale from '../i18n/locales/en.json'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('le funzioni AI', () => {
  it('sono le stesse che conosce l\'API', () => {
    const sorgente = fs.readFileSync(path.resolve(SRC, '../../api/src/lib/aiSettings.ts'), 'utf8')
    const riga = /export const AI_FEATURES = \[([^\]]*)\]/.exec(sorgente)?.[1] ?? ''
    const dellApi = [...riga.matchAll(/'(\w+)'/g)].map((m) => m[1]!)
    expect([...AI_FEATURE_KEYS].sort()).toEqual(dellApi.sort())
  })

  it('hanno tutte nome e spiegazione, in italiano e in inglese', () => {
    const mancanti: string[] = []
    for (const [lingua, dizionario] of [['it', itLocale], ['en', enLocale]] as const) {
      const org = ((dizionario as Record<string, unknown>)['pages'] as Record<string, Record<string, Record<string, string>>>)['organization']!
      for (const k of AI_FEATURE_KEYS) {
        if (!org['aiFeature']?.[k]) mancanti.push(`${lingua}:aiFeature.${k}`)
        if (!org['aiFeatureHelp']?.[k]) mancanti.push(`${lingua}:aiFeatureHelp.${k}`)
      }
    }
    expect(mancanti).toEqual([])
  })
})
