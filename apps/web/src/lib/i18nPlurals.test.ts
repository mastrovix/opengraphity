/**
 * Guardia sui plurali (D·6.1): ogni chiave passata a `t('…', { count })` nel
 * sorgente deve avere `_one` e `_other` sia in it.json sia in en.json,
 * altrimenti "1 eventi". Le chiavi fuori dall'ambito dell'ondata 5 (namespace
 * di altre pagine) sono elencate in KNOWN_MISSING con il testo attuale: la
 * lista è da svuotare, non da allungare — una chiave nuova senza plurali fa
 * fallire il test.
 */
import { describe, it, expect } from 'vitest'
import it_ from '@/i18n/locales/it.json'
import en from '@/i18n/locales/en.json'

/** Sorgenti dell'app (non i test né gli helper di test), letti come testo da Vite. */
const SOURCES = import.meta.glob<string>('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out)
    else out[key] = String(v)
  }
  return out
}

const isAppSource = (file: string) => !/\.test\.tsx?$/.test(file) && !/\.d\.ts$/.test(file) && !file.startsWith('/src/test/')

/** t('chiave', { count … }) — chiave letterale, con `count` come prima opzione. */
const RE_T_COUNT = /(?:^|[^A-Za-z0-9_$.])t\(\s*(['"])([^'"`\n]+?)\1\s*,\s*\{\s*count\b/g

/** Chiavi già usate con { count } fuori dall'ambito dell'ondata 5 (altri namespace), senza plurali: da correggere nelle rispettive pagine. */
const KNOWN_MISSING = new Set([
  'bulk.assignTeamTitle', 'bulk.resolveTitle',
  'itilDesigner.customFields', 'itilDesigner.systemFields',
  'pages.anomalies.acceptedRisks', 'pages.anomalies.count', 'pages.anomalies.falsePositives', 'pages.anomalies.minChars',
  'pages.changes.count', 'pages.ci.criteriaNTypes', 'pages.ci.criteriaPreview', 'pages.ci.graphAllNodes',
  'pages.cmdb.count', 'pages.import.confirmErrors', 'pages.import.dryRunErrors', 'pages.incidents.count',
  'pages.logs.count', 'pages.problems.count', 'pages.requests.count', 'pages.teams.count', 'pages.users.count',
  'topbar.notificationsUnread', 'watchers.listLabel',
])

describe('i18n — plurali delle chiavi usate con { count }', () => {
  const I = flatten(it_ as Record<string, unknown>)
  const E = flatten(en as Record<string, unknown>)
  const used = new Map<string, string>()
  for (const [file, src] of Object.entries(SOURCES)) {
    if (!isAppSource(file)) continue
    for (const m of src.matchAll(RE_T_COUNT)) used.set(m[2]!, file)
  }

  it('trova le chiavi con { count } nel sorgente', () => {
    expect(used.size).toBeGreaterThan(10)
    expect(used.has('events.count')).toBe(true)
  })

  const hasPlural = (dict: Record<string, string>, key: string) => `${key}_one` in dict && `${key}_other` in dict

  it('ogni chiave in ambito ha _one e _other in it.json ed en.json', () => {
    const missing: string[] = []
    for (const [key, file] of used) {
      if (KNOWN_MISSING.has(key)) continue
      if (!hasPlural(I, key) || !hasPlural(E, key)) missing.push(`${key} (${file})`)
    }
    expect(missing).toEqual([])
  })

  it('la lista delle eccezioni non contiene chiavi già corrette o non più usate', () => {
    const stale = [...KNOWN_MISSING].filter((key) => !used.has(key) || (hasPlural(I, key) && hasPlural(E, key)))
    expect(stale).toEqual([])
  })

  // Nei namespace dell'ondata 5 una chiave plurale non convive con la forma
  // base (i18next userebbe comunque il plurale: la base sarebbe testo morto).
  const WAVE_NAMESPACES = /^(events\.|sidebar\.|pages\.dashboard\.|pages\.incidents\.monitoringAlarms\.|pages\.changes\.suppressedAlarms\.|errors\.)/
  it('nei namespace dell\'ondata una chiave plurale non convive con la forma base', () => {
    const both = Object.keys(I).filter((k) => WAVE_NAMESPACES.test(k) && /_one$/.test(k) && k.replace(/_one$/, '') in I)
    expect(both).toEqual([])
  })
})
