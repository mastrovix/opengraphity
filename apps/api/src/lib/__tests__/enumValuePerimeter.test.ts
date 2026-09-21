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
import { readFileSync, readdirSync } from 'node:fs'
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
  // Un'uscita a SCALA (`environment_risk`: 0..3) non è un vocabolario: i suoi
  // valori sono della formula e non si rinominano, quindi non hanno sedi.
  // Lo stesso per un INGRESSO a scala (`service_urgency`: la salute del servizio).
  const vocabolariDelleMatrici = [...new Set(
    Object.values(DOMAIN_MATRIX_KINDS).flatMap((spec) => {
      const scaled = 'inputScales' in spec ? Object.keys(spec.inputScales) : []
      const inputs = spec.inputs.filter((i: string) => !scaled.includes(i))
      return 'scale' in spec ? [...inputs] : [...inputs, spec.output]
    }),
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
    // Verifica «Cosa resta cablato», ondate 1 e 2: le nuove scelte dell'amministratore.
    ['Tenant', 'portal_severity_options'],
    ['ServiceCatalogItem', 'priority'],
    ['ServiceCatalogItem', 'category'],
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

  it('una sede o ha un vocabolario fisso, o dice da quale campo prenderlo, o lo ricava dalla forma', () => {
    /**
     * CONTRATTO RINEGOZIATO (revisione totale · ondata 4): oltre alle
     * condizioni, ci sono due forme che ricavano il vocabolario dal CAMPO
     * SCRITTO, non da una dichiarazione nella sede — le azioni
     * (`set_field`/`update_field` dentro `actions`) e le scadenze dei passi
     * (`set_fields` dentro `deadline`). Lì il vocabolario lo dice
     * `fieldVocabulary(campo)`, perché una sola sede scrive campi diversi:
     * un'azione può toccare `priority` e la successiva `category`.
     */
    const FROM_SHAPE = new Set(['conditions', 'actions', 'deadline'])
    for (const s of CONFIG_VALUE_SITES) {
      const ok = s.vocabulary != null || s.vocabularyFromField != null || FROM_SHAPE.has(s.shape)
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

/**
 * OGNI VOCABOLARIO CHE IL CODICE VALIDA HA UNA SEDE (revisione del 15 set 2026 · CM-7).
 *
 * Il guardiano qui sopra partiva dalle matrici. Ma un vocabolario entra nel
 * prodotto anche da `assertDomainValue`: le categorie della Knowledge Base, il
 * tipo dei team e i tipi di change pre-approvati erano validati contro il
 * Dizionario e fuori dal perimetro — togliere `network` dalle categorie KB passava
 * contando zero usi con un articolo che lo portava. Qui si parte dal codice: ogni
 * vocabolario che un sorgente valida o legge deve avere una sede, o essere
 * dichiarato legato a un campo del metamodello (dove `USES_ENUM` lo trova da sé).
 */
describe('ogni vocabolario validato dal codice ha una sede', () => {
  /**
   * I vocabolari agganciati con `USES_ENUM` a un campo spedito col prodotto:
   * `enumValueBindings` li trova leggendo il metamodello, senza tabella.
   * Verificati sul grafo vivo il 15 set 2026 (incident.category, change.type,
   * __base__.status, __base__.environment, incident.impact, incident.priority,
   * incident.severity, business_application.criticality, incident.urgency).
   */
  const LEGATI_DAL_METAMODELLO = new Set([
    'category', 'change_type', 'ci_status', 'environment', 'impact', 'priority', 'severity', 'service_criticality', 'urgency',
  ])

  const COSTANTI: Record<string, string> = {
    CI_STATUS_VOCABULARY: 'ci_status', PORTAL_SEVERITY_VOCABULARY: 'severity', TEAM_TYPE_VOCABULARY: 'team_type',
  }

  function sorgenti(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'migrations') out.push(...sorgenti(p)) }
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
    }
    return out
  }

  const validati = new Map<string, string[]>()
  const RE = /\b(?:assertDomainValue|isDomainValue|domainVocabulary|domainVocabularyDefault|loadVocabularyEntries)\(\s*[^,()]+,\s*(?:'([a-z_]+)'|([A-Z_]+))/g
  for (const file of sorgenti(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(RE)) {
      const name = m[1] ?? COSTANTI[m[2] ?? '']
      if (!name) continue
      validati.set(name, [...(validati.get(name) ?? []), file.slice(SRC.length + 1)])
    }
  }

  it('la lettura trova i vocabolari (se questo cade, il guardiano è finto)', () => {
    for (const v of ['kb_category', 'team_type', 'change_type', 'risk_band']) expect(validati.has(v), v).toBe(true)
  })

  it.each([...validati.keys()].sort())('«%s» ha una sede', (vocabolario) => {
    const conRecord  = (DOMAIN_VALUE_BINDINGS[vocabolario]?.length ?? 0) > 0
    const inConfig   = CONFIG_VALUE_SITES.some((s) => s.vocabulary === vocabolario)
    const metamodello = LEGATI_DAL_METAMODELLO.has(vocabolario)
    expect(conRecord || inConfig || metamodello,
      `«${vocabolario}» è validato in ${(validati.get(vocabolario) ?? []).join(', ')} ma non dice dove vivono i suoi valori: `
      + 'aggiungi la proprietà a DOMAIN_VALUE_BINDINGS o la configurazione a CONFIG_VALUE_SITES.').toBe(true)
  })

  it('le tre sedi che mancavano ci sono', () => {
    expect(DOMAIN_VALUE_BINDINGS['kb_category']).toContainEqual({ label: 'KBArticle', property: 'category' })
    expect(DOMAIN_VALUE_BINDINGS['team_type']).toContainEqual({ label: 'Team', property: 'type' })
    expect(CONFIG_VALUE_SITES.find((s) => s.property === 'pre_approved_change_types')).toMatchObject({ label: 'Tenant', shape: 'string_list', vocabulary: 'change_type' })
  })
})
