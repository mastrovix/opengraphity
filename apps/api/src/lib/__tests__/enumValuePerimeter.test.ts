/**
 * IL PERIMETRO DEI VALORI DI VOCABOLARIO (terza revisione · G1 e G3).
 *
 * In `enumValueUsage.ts` c'era scritto, in un commento:
 *
 *   «Il test `lib/__tests__/enumValueUsage.test.ts` pretende che ogni
 *   vocabolario nominato da `DOMAIN_MATRIX_KINDS` compaia qui o sia dichiarato
 *   senza record: una matrice nuova non può entrare senza dire dove vivono i
 *   suoi valori.»
 *
 * Quel test non esisteva, e `DOMAIN_VALUE_BINDINGS` non era importata da
 * nessuno: `grep -rl` la trovava in un solo file, il suo. È lo stesso difetto
 * per cui la revisione precedente aveva bocciato — il TTL dichiarato in un
 * commento e assente dal codice — ripetuto dentro l'ondata che lo correggeva.
 *
 * Questo è quel test. Ed è più severo della promessa, perché la promessa non
 * bastava: la sua clausola d'uscita («oppure dichiarato senza record») avrebbe
 * assolto `risk_band: []` comunque, e `risk_band` era il critico.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOMAIN_VALUE_BINDINGS, CONFIG_VALUE_SITES, CONDITION_FIELD_VOCABULARY, conditionFieldVocabulary,
} from '../enumValueUsage.js'
import { DOMAIN_MATRIX_KINDS } from '../domainMatrix.js'

const SRC = join(process.cwd(), 'src')

/**
 * Vocabolari i cui valori non stanno su NESSUN nodo e in NESSUNA
 * configurazione, con la ragione. Ogni voce qui è un permesso: se la ragione
 * smette di essere vera, il vocabolario torna scoperto in silenzio — che è
 * esattamente come `risk_band` è diventato il critico. Quindi ogni voce porta
 * anche una prova eseguibile sul codice.
 */
const SENZA_SEDI: Record<string, { reason: string; proof: () => boolean }> = {
  import_severity: {
    reason: 'È il vocabolario del FILE di import, non del prodotto: nessun nodo lo porta e '
      + 'nessuna configurazione lo cita. Vive solo nella colonna di un CSV.',
    proof: () => !readFileSync(join(SRC, 'lib/enumValueUsage.ts'), 'utf8').includes('import_severity_'),
  },
}

describe('il perimetro: ogni vocabolario dice dove vivono i suoi valori', () => {
  const vocabolariDelleMatrici = [...new Set(
    Object.values(DOMAIN_MATRIX_KINDS).flatMap((spec) => [...spec.inputs, spec.output]),
  )].sort()

  it('le matrici nominano dei vocabolari (se questo cade, la lettura è vuota e il resto è finto)', () => {
    expect(vocabolariDelleMatrici.length).toBeGreaterThanOrEqual(7)
  })

  it('ogni vocabolario nominato da una matrice è dichiarato in DOMAIN_VALUE_BINDINGS', () => {
    const assenti = vocabolariDelleMatrici.filter((v) => !(v in DOMAIN_VALUE_BINDINGS))
    expect(assenti, 'Una matrice nuova non può entrare senza dire dove vivono i suoi valori: '
      + 'aggiungili a DOMAIN_VALUE_BINDINGS (anche come lista vuota, con la ragione in SENZA_SEDI).',
    ).toEqual([])
  })

  it('un vocabolario dichiarato SENZA record deve avere una sede di configurazione, o un permesso con una prova', () => {
    const conSediDiConfig = new Set(CONFIG_VALUE_SITES.map((s) => s.vocabulary).filter((v): v is string => v != null))
    // Le sedi a forma di condizione coprono tutti i vocabolari della mappa.
    for (const v of Object.values(CONDITION_FIELD_VOCABULARY)) conSediDiConfig.add(v)

    const scoperti: string[] = []
    const provaCaduta: string[] = []
    for (const [vocabolario, bindings] of Object.entries(DOMAIN_VALUE_BINDINGS)) {
      if (bindings.length > 0) continue
      if (conSediDiConfig.has(vocabolario)) continue
      const permesso = SENZA_SEDI[vocabolario]
      if (!permesso) { scoperti.push(vocabolario); continue }
      if (!permesso.proof()) provaCaduta.push(`${vocabolario} — il permesso diceva: ${permesso.reason}`)
    }
    expect(scoperti, 'Questi vocabolari dicono «nessun record» e non hanno nemmeno una sede di '
      + 'configurazione: togliere o rinominare un loro valore passerebbe in silenzio. È così che '
      + '`risk_band` è diventato il critico della terza revisione.',
    ).toEqual([])
    expect(provaCaduta).toEqual([])
  })

  /**
   * Il critico: le soglie vivono su `Tenant.risk_band_thresholds` come
   * `[{band, upTo}]`, e `band` è un valore di `risk_band`. La tabella diceva
   * «nessun record: i suoi valori vivono solo nelle chiavi della matrice
   * change_priority» — falso dal commit che ha introdotto le soglie.
   */
  it('le soglie delle fasce di rischio sono nel perimetro', () => {
    const sede = CONFIG_VALUE_SITES.find((s) => s.property === 'risk_band_thresholds')
    expect(sede, 'Rinominare una fascia di rischio lascerebbe le soglie orfane e NESSUNA change '
      + 'si creerebbe più: `parseThresholds` lancia su una fascia fuori vocabolario.').toBeDefined()
    expect(sede!.vocabulary).toBe('risk_band')
    expect(sede!.label).toBe('Tenant')
  })

  it('e il commento bugiardo non può tornare: il file conosce le soglie', () => {
    // `grep -c "risk_band_thresholds" lib/enumValueUsage.ts` → era 0.
    const src = readFileSync(join(SRC, 'lib/enumValueUsage.ts'), 'utf8')
    expect(src).toContain('risk_band_thresholds')
    expect(src).not.toMatch(/risk_band:\s*\[\],[\s\S]{0,200}vivono solo nelle chiavi/)
  })
})

describe('le sedi di configurazione trovate dal vivo restano coperte', () => {
  /**
   * Le sei sedi verificate sul grafo di `c-one` durante la revisione. Sono
   * elencate una per una di proposito: se qualcuno ne toglie una dalla
   * tabella, questo test dice quale, invece di contarle.
   */
  const ATTESE: readonly [string, string][] = [
    ['BusinessRule', 'conditions'],
    ['AutoTrigger', 'conditions'],
    ['SLAPolicyNode', 'category'],
    ['DynamicCIGroup', 'criteria_environment'],
    ['StandardChangeCatalogEntry', 'default_priority'],
    ['FieldVisibilityRule', 'trigger_value'],
    ['Tenant', 'risk_band_thresholds'],
  ]

  it.each(ATTESE)('%s.%s è nel perimetro', (label, property) => {
    expect(CONFIG_VALUE_SITES.some((s) => s.label === label && s.property === property)).toBe(true)
  })

  it('ogni sede dichiara come si chiama per l\'amministratore', () => {
    for (const s of CONFIG_VALUE_SITES) {
      expect(s.where, `${s.label}.${s.property} non ha un «where» leggibile`).toBeTruthy()
      expect(s.where).not.toMatch(/^[a-z_]+$/)   // non il nome tecnico
    }
  })

  it('una sede o ha un vocabolario fisso, o dice da quale campo prenderlo, o è una condizione', () => {
    for (const s of CONFIG_VALUE_SITES) {
      const ok = s.vocabulary != null || s.vocabularyFromField != null || s.shape === 'conditions'
      expect(ok, `${s.label}.${s.property} non dice quale vocabolario governa i suoi valori`).toBe(true)
    }
  })
})

describe('conditionFieldVocabulary', () => {
  it('`status` dipende dall\'entità della regola, perché il vocabolario è per entità', () => {
    expect(conditionFieldVocabulary('status', 'incident')).toBe('status_incident')
    expect(conditionFieldVocabulary('status', 'change')).toBe('status_change')
    // Senza entità non si indovina: meglio non coprire che coprire il vocabolario sbagliato.
    expect(conditionFieldVocabulary('status', null)).toBeNull()
  })

  it('i campi verificati dal vivo sono mappati', () => {
    expect(conditionFieldVocabulary('severity', 'incident')).toBe('severity')
    expect(conditionFieldVocabulary('category', 'incident')).toBe('category')
    expect(conditionFieldVocabulary('type', 'change')).toBe('change_type')
  })

  it('un campo che non è di vocabolario non viene mappato per sbaglio', () => {
    // `BusinessRule.priority` dal vivo vale 1.0/2.0/3.0: è l'ordine della
    // regola, non una priorità ITSM. Il campo DENTRO le condizioni invece sì.
    expect(conditionFieldVocabulary('name', 'incident')).toBeNull()
    expect(conditionFieldVocabulary('assigned_to', 'incident')).toBeNull()
  })
})
