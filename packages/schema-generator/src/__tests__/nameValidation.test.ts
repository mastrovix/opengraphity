/**
 * I nomi del metamodello CI (A-12): le regole, l'elenco riservato calcolato, e
 * i messaggi che dicono cosa scrivere invece.
 *
 * Il caso da cui tutto nasce è il campo chiamato `tenantId`: `toSnakeCase` lo
 * porta a `tenant_id`, che è il cliente proprietario del CI, e la scrittura
 * del CI copia i campi del metamodello DOPO aver impostato il cliente. Senza
 * questa validazione il CI nascerebbe nel cliente scelto da chi chiama l'API.
 *
 * E la collisione sul nome del TIPO non ha nessuna rete a valle: due tipi
 * GraphQL omonimi non fanno lanciare `makeExecutableSchema`, vengono FUSI in
 * silenzio (pinnato in `apps/api/src/lib/__tests__/metamodelNames.test.ts`
 * contro lo schema vero). Questo è l'unico posto che li ferma.
 */
import { describe, it, expect } from 'vitest'
import {
  CI_TYPE_NAME_RE, CI_FIELD_NAME_RE,
  RESERVED_CI_PROPERTY_KEYS, RESERVED_CI_PROPERTY_PREFIXES,
  BASE_TYPE_FIELDS, BASE_INPUT_FIELDS,
  MetamodelNameError,
  emptyReservedNames, mergeReservedNames, emittedNamesForCIType, reservedNamesForCITypes,
  suggestCITypeName, suggestCIFieldName,
  assertCITypeName, assertCIFieldName, assertGeneratableNames,
} from '../nameValidation.js'
import { toSnakeCase, toPascalCase } from '../stringUtils.js'

/** I tipi CI spediti col prodotto, come li restituisce il grafo dal vivo. */
const SHIPPED = [
  'application', 'business_application', 'business_capability', 'certificate',
  'database', 'database_instance', 'dynamic_ci_group', 'server', '__base__',
].map((name) => ({ name, origin: 'un tipo CI spedito col prodotto' }))
const ITIL = ['change', 'incident', 'problem', 'service_request']
  .map((name) => ({ name, origin: 'un tipo ITIL spedito col prodotto' }))

const reserved = () => reservedNamesForCITypes([...SHIPPED, ...ITIL])

function refusal(fn: () => unknown): MetamodelNameError {
  try { fn(); throw new Error('non ha rifiutato') }
  catch (e) {
    if (!(e instanceof MetamodelNameError)) throw e
    return e
  }
}

// ── Nome di tipo: la sintassi ─────────────────────────────────────────────────

describe('nome di tipo — sintassi', () => {
  it.each(['server_edge', 'load_balancer', 'k8s', 'a', 'tipo2', 'x_1_y'])('accetta «%s»', (n) => {
    expect(CI_TYPE_NAME_RE.test(n)).toBe(true)
    expect(assertCITypeName(n, emptyReservedNames())).toBe(n)
  })

  it.each([
    ['2fa_token',       'fa2_token'],
    ['my-type',         'my_type'],
    ['Load Balancer',   'load_balancer'],
    ['città',           'citta'],
    ['_leading',        'leading'],
  ])('rifiuta «%s» e suggerisce «%s»', (bad, fix) => {
    const err = refusal(() => assertCITypeName(bad, emptyReservedNames()))
    expect(err.rule).toBe('typeNameSyntax')
    expect(suggestCITypeName(bad)).toBe(fix)
    expect(err.message).toContain(`«${fix}»`)
    // Il rifiuto dice la REGOLA, non «nome non valido».
    expect(err.message).toContain(CI_TYPE_NAME_RE.source)
    // …e dove sta la libertà: la label.
    expect(err.message).toContain('label')
  })

  it('rifiuta un nome che non è nemmeno una stringa', () => {
    expect(refusal(() => assertCITypeName(42, emptyReservedNames())).rule).toBe('typeNameSyntax')
    expect(refusal(() => assertCITypeName(null, emptyReservedNames())).rule).toBe('typeNameSyntax')
  })

  it('senza niente da suggerire il messaggio si limita alla regola', () => {
    expect(suggestCITypeName('///')).toBeNull()
    const err = refusal(() => assertCITypeName('///', emptyReservedNames()))
    expect(err.message).not.toContain('Scrivi per esempio')
    expect(err.message).toContain(CI_TYPE_NAME_RE.source)
  })
})

// ── Nome di tipo: l'elenco riservato, CALCOLATO ───────────────────────────────

describe('nome di tipo — collisioni con i tipi già nello schema', () => {
  it('emittedNamesForCIType elenca tutto ciò che l\'SDL genera', () => {
    expect(emittedNamesForCIType('load_balancer')).toEqual({
      types:          ['LoadBalancer', 'LoadBalancersResult', 'CreateLoadBalancerInput', 'UpdateLoadBalancerInput'],
      queryFields:    ['loadBalancers', 'load_balancer'],
      mutationFields: ['createLoadBalancer', 'updateLoadBalancer', 'deleteLoadBalancer'],
    })
  })

  it.each(['server', 'application', 'database', 'certificate', 'dynamic_ci_group'])(
    'rifiuta «%s»: è un tipo CI spedito col prodotto', (n) => {
      const err = refusal(() => assertCITypeName(n, reserved()))
      expect(err.rule).toBe('typeNameTaken')
      expect(err.message).toContain('spedito col prodotto')
      // Il punto verificato: GraphQL FONDE i tipi omonimi, non lancia.
      expect(err.message).toContain('FONDE in silenzio')
      expect(err.message).toContain(`«${n}_custom»`)
    })

  it.each(['incident', 'change', 'problem', 'service_request'])(
    'rifiuta «%s»: è un tipo ITIL spedito col prodotto', (n) => {
      expect(refusal(() => assertCITypeName(n, reserved())).rule).toBe('typeNameTaken')
    })

  it('il confronto è senza distinzione di maiuscole: `Server` è già `server`', () => {
    // `SERVER` non passa nemmeno la sintassi; il caso vero è un tipo già
    // esistente scritto con le maiuscole in un seme vecchio.
    const r = reservedNamesForCITypes([{ name: 'Server', origin: 'un tipo CI già esistente' }])
    expect(refusal(() => assertCITypeName('server', r)).rule).toBe('typeNameTaken')
  })

  it('rifiuta la collisione sul PLURALE, non solo sul nome', () => {
    // `certificate` esiste; `certificates` come nome di tipo produce la query
    // `certificateses` (nessuna collisione) ma il TIPO `Certificates`…
    const r = reservedNamesForCITypes([{ name: 'certificates', origin: 'un tuo tipo CI' }])
    // …e viceversa: un tipo `certificate` genera la query `certificates`,
    // che è anche il nome del tipo `certificates`. La collisione da prendere è
    // quella di query: la dimostriamo con un elenco riservato che contiene
    // solo la query.
    const onlyQuery = mergeReservedNames(emptyReservedNames(), {
      types: new Map(), mutationFields: new Map(),
      queryFields: new Map([['incidents', 'incidents è una query dello schema di base']]),
    })
    const err = refusal(() => assertCITypeName('incident', onlyQuery))
    expect(err.rule).toBe('typeNameTaken')
    expect(err.message).toContain('la query «incidents»')
    expect(err.message).toContain('non si assemblerebbe')
    expect(r.types.has('certificates')).toBe(true)
  })

  it('rifiuta la collisione sulla MUTATION generata', () => {
    const onlyMutation = { ...emptyReservedNames(), mutationFields: new Map([['createserver', 'createServer è una mutation dello schema di base']]) }
    const err = refusal(() => assertCITypeName('server', onlyMutation))
    expect(err.message).toContain('la mutation «createServer»')
  })

  it('un nome libero passa anche con tutti i tipi spediti in elenco', () => {
    expect(assertCITypeName('load_balancer', reserved())).toBe('load_balancer')
    expect(assertCITypeName('firewall', reserved())).toBe('firewall')
  })
})

// ── Nome di campo ─────────────────────────────────────────────────────────────

describe('nome di campo — sintassi camelCase', () => {
  it.each(['costCenter', 'os', 'ipAddress', 'x2'])('accetta «%s»', (n) => {
    expect(CI_FIELD_NAME_RE.test(n)).toBe(true)
    expect(assertCIFieldName(n)).toBe(n)
  })

  it.each([
    ['Centro di costo', 'centroDiCosto'],
    ['città',           'citta'],
    ['cost_center',     'costCenter'],
    ['2fa_token',       'fa2Token'],
  ])('rifiuta «%s» e suggerisce «%s»', (bad, fix) => {
    const err = refusal(() => assertCIFieldName(bad))
    expect(err.rule).toBe('fieldNameSyntax')
    expect(suggestCIFieldName(bad)).toBe(fix)
    expect(err.message).toContain(`«${fix}»`)
    expect(err.message).toContain(CI_FIELD_NAME_RE.source)
  })

  it('il rifiuto del trattino basso spiega PERCHÉ (la stessa proprietà Neo4j)', () => {
    const err = refusal(() => assertCIFieldName('cost_center'))
    expect(toSnakeCase('costCenter')).toBe('cost_center')
    expect(err.message).toContain('stessa proprietà')
  })
})

describe('nome di campo — proprietà gestite dal prodotto', () => {
  // IL caso: `tenantId` → `tenant_id`.
  it('tenantId: rifiutato, e il messaggio dice che il CI nascerebbe in un altro cliente', () => {
    expect(toSnakeCase('tenantId')).toBe('tenant_id')
    const err = refusal(() => assertCIFieldName('tenantId', { typeLabel: 'Load Balancer' }))
    expect(err.rule).toBe('fieldNameReservedProperty')
    expect(err.message).toContain('tenant_id')
    expect(err.message).toContain('il CI nascerebbe nel cliente scelto dal chiamante')
    expect(err.message).toContain('Load Balancer')
  })

  it.each([
    ['nameKey',     'name_key'],
    ['healthSource', 'health_source'],
    ['lastEventAt', 'last_event_at'],
    ['createdAt',   'created_at'],
    ['updatedAt',   'updated_at'],
  ])('rifiuta «%s» → proprietà «%s»', (field, property) => {
    expect(toSnakeCase(field)).toBe(property)
    const err = refusal(() => assertCIFieldName(field))
    // `createdAt`/`updatedAt`/`health…` sono anche campi base: qualunque delle
    // due regole li prenda, il rifiuto c'è e nomina il campo.
    expect(['fieldNameReservedProperty', 'fieldNameBase']).toContain(err.rule)
    expect(err.message).toContain(field)
  })

  it('rifiuta il prefisso della sincronizzazione: discoverySourceId → discovery_source_id', () => {
    expect(toSnakeCase('discoverySourceId')).toBe('discovery_source_id')
    const err = refusal(() => assertCIFieldName('discoverySourceId'))
    expect(err.rule).toBe('fieldNameReservedProperty')
    expect(err.message).toContain('discovery_')
  })

  it('l\'elenco delle proprietà riservate copre le chiavi di sistema', () => {
    for (const k of ['tenant_id', 'id', 'created_at', 'updated_at', 'labels', 'name_key', 'health', 'health_source', 'last_event_at', 'chain', 'type']) {
      expect(RESERVED_CI_PROPERTY_KEYS.has(k)).toBe(true)
    }
    expect(RESERVED_CI_PROPERTY_PREFIXES).toContain('discovery_')
  })
})

describe('nome di campo — campi base e doppioni', () => {
  it.each(['name', 'status', 'environment', 'description', 'notes', 'ownerGroup', 'dependencies'])(
    'rifiuta «%s»: esiste già su ogni CI', (n) => {
      expect(BASE_TYPE_FIELDS.has(n) || BASE_INPUT_FIELDS.has(n)).toBe(true)
      const err = refusal(() => assertCIFieldName(n))
      expect(err.rule).toBe('fieldNameBase')
      expect(err.message).toContain('esiste già su ogni CI')
    })

  it('rifiuta un campo già presente sul tipo, anche con maiuscole diverse', () => {
    const err = refusal(() => assertCIFieldName('costCenter', { existingFieldNames: ['os', 'CostCenter'], typeLabel: 'Server EDGE' }))
    expect(err.rule).toBe('fieldNameDuplicate')
    expect(err.message).toContain('CostCenter')
    expect(err.message).toContain('Server EDGE')
  })

  it('ogni suggerimento è a sua volta un nome accettabile', () => {
    for (const bad of ['tenantId', 'nameKey', 'name', 'status']) {
      const err = refusal(() => assertCIFieldName(bad))
      const m = /«([^»]+)»\./.exec(err.message.slice(err.message.indexOf('Scrivi per esempio')))
      if (!m) continue
      expect(assertCIFieldName(m[1]!)).toBe(m[1])
    }
  })
})

// ── La rete davanti al generatore ─────────────────────────────────────────────

describe('assertGeneratableNames — la rete sotto generateSDL', () => {
  const type = (name: string, fields: string[] = [], label?: string) => ({
    name, label, fields: fields.map((n) => ({ name: n })),
  })

  it('passa sui tipi spediti col prodotto, come li carica il metamodello', () => {
    expect(() => assertGeneratableNames([
      type('server', ['os', 'ipAddress', 'serialNumber']),
      type('application', ['businessOwner', 'criticality']),
    ])).not.toThrow()
  })

  it('un tipo del cliente omonimo di uno base: rifiutato, e il messaggio nomina il tipo', () => {
    const err = refusal(() => assertGeneratableNames([type('server', ['os']), type('server', ['reparto'], 'Server del reparto')]))
    expect(err.rule).toBe('typeNameTaken')
    expect(err.message).toContain('non si può generare')
    expect(err.message).toContain('Server del reparto')
    expect(err.message).toContain('eliminalo o rinominalo')
  })

  it('un nome non identificatore: rifiutato prima di arrivare all\'SDL', () => {
    const err = refusal(() => assertGeneratableNames([type('2fa', [])]))
    expect(err.rule).toBe('typeNameSyntax')
    expect(err.message).toContain('2fa')
  })

  it('un campo `tenantId` su un tipo del cliente: rifiutato', () => {
    const err = refusal(() => assertGeneratableNames([type('load_balancer', ['tenantId'], 'Load Balancer')]))
    expect(err.rule).toBe('fieldNameReservedProperty')
    expect(err.message).toContain('Load Balancer')
  })

  it('i campi base non contano come doppioni (l\'SDL li filtra)', () => {
    expect(() => assertGeneratableNames([type('load_balancer', ['name', 'status', 'health', 'ownerGroupId'])])).not.toThrow()
  })

  it('i campi `isSystem` non si validano: sono spediti col prodotto', () => {
    expect(() => assertGeneratableNames([
      { name: 'load_balancer', fields: [{ name: 'created_at', isSystem: true }] },
    ])).not.toThrow()
  })

  it('due tipi con PLURALE identico: rifiutati (la query generata è la stessa)', () => {
    // `bus` → `Buses`, `buse` → `Buses`: i nomi dei tipi sono diversi, la
    // query generata è la stessa. È la collisione che non si vede guardando i
    // nomi, e quella che fa fallire il merge di `Query`.
    const err = refusal(() => assertGeneratableNames([type('bus'), type('buse')]))
    expect(err.rule).toBe('typeNameTaken')
    expect(err.message).toContain('la query «buses»')
  })
})

// ── toPascalCase è sicuro SOLO grazie alla regola ─────────────────────────────

describe('toPascalCase ↔ CI_TYPE_NAME_RE', () => {
  it('divide solo su `_`: senza la regola uno spazio passerebbe intatto nell\'SDL', () => {
    expect(toPascalCase('load balancer')).toBe('Load balancer')   // NON un identificatore
    expect(CI_TYPE_NAME_RE.test('load balancer')).toBe(false)     // ma non arriva mai qui
    expect(toPascalCase('load_balancer')).toBe('LoadBalancer')
  })
})
