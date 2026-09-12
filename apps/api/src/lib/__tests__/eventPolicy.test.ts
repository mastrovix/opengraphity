/**
 * lib/eventPolicy.ts — ondata 4: nuove chiavi (flap_stable_minutes,
 * storm_threshold_per_minute, storm_cooldown_minutes) nei valori iniziali,
 * nella validazione, nel mapping GraphQL e nell'input; parseEventPolicy
 * indica la migrazione 1040 quando mancano; completeEventPolicy (usata dalla
 * migrazione) aggiunge solo ciò che manca.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  DEFAULT_EVENT_POLICY, DEFAULT_EVENT_POLICY_JSON, EVENT_POLICY_V2_KEYS, EVENT_POLICY_V2_MIGRATION,
  EVENT_POLICY_V3_KEYS, EVENT_POLICY_V3_MIGRATION, EVENT_POLICY_V4_KEYS, EVENT_POLICY_V4_MIGRATION,
  EVENT_POLICY_V5_KEYS, EVENT_POLICY_V5_MIGRATION, EVENT_POLICY_V6_KEYS, EVENT_POLICY_V6_MIGRATION,
  EVENT_POLICY_MAX, assertLifecycleStatuses,
  assertEventPolicy, parseEventPolicy, completeEventPolicy, toEventPolicyGQL, applyEventPolicyInput,
  EVENT_POLICY_CACHE_TTL_MS, getCachedEventPolicy, cacheEventPolicy, invalidateEventPolicyCache,
} from '../eventPolicy.js'
import { CI_LIFECYCLE_STATUSES } from '../eventVocabularies.js'

/**
 * Ondata 7 · C-4/A-14: `applyEventPolicyInput` è ASINCRONA e valida le tre
 * liste del ciclo di vita contro il vocabolario `ci_status` **del cliente**
 * (`assertDomainValue`, lib/domainMatrix.ts). Qui il Dizionario si simula: il
 * vocabolario di questo finto cliente è il seme più `dismesso`, così si vede
 * che un valore rinominato dal cliente viene ACCETTATO (prima era rifiutato,
 * ed era il difetto) e uno inventato no.
 */
const TENANT_CI_STATUS = [...CI_LIFECYCLE_STATUSES, 'dismesso']
vi.mock('../domainMatrix.js', () => ({
  assertDomainValue: (_t: string, vocabulary: string, value: unknown) => {
    if (typeof value !== 'string' || !TENANT_CI_STATUS.includes(value)) {
      return Promise.reject(new GraphQLError(`${vocabulary}: "${String(value)}" non è nel vocabolario di questo cliente. Ammessi: ${TENANT_CI_STATUS.join(', ')}.`, { extensions: { code: 'BAD_USER_INPUT' } }))
    }
    return Promise.resolve(value)
  },
}))

const T = 'acme'

const { flap_stable_minutes: _a, storm_threshold_per_minute: _b, storm_cooldown_minutes: _c, ...V1 } = DEFAULT_EVENT_POLICY

describe('DEFAULT_EVENT_POLICY (ondata 4)', () => {
  it('valori iniziali: sfarfallio stabile dopo 15 min, tempesta da 50 eventi nuovi/min, raffreddamento 5 min, conservazione 90 giorni', () => {
    expect(DEFAULT_EVENT_POLICY).toMatchObject({ flap_threshold: 4, flap_window_minutes: 10, flap_stable_minutes: 15, storm_threshold_per_minute: 50, storm_cooldown_minutes: 5, retention_days: 90 })
    expect(JSON.parse(DEFAULT_EVENT_POLICY_JSON)).toEqual(DEFAULT_EVENT_POLICY)
    expect(EVENT_POLICY_V2_KEYS).toEqual(['flap_stable_minutes', 'storm_threshold_per_minute', 'storm_cooldown_minutes'])
    expect(EVENT_POLICY_V2_MIGRATION).toBe('20260909_1040_event_management_policy_v2')
  })
})

describe('assertEventPolicy / parseEventPolicy', () => {
  it('le nuove chiavi sono obbligatorie, interi ≥ 0', () => {
    expect(assertEventPolicy(DEFAULT_EVENT_POLICY)).toEqual(DEFAULT_EVENT_POLICY)
    for (const key of EVENT_POLICY_V2_KEYS) {
      expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: -1 })).toThrow(new RegExp(`${key} must be an integer >= 0`))
      expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: '5' })).toThrow(new RegExp(`${key} must be an integer >= 0`))
      const err = (() => { try { assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: undefined }); return null } catch (e) { return e as GraphQLError } })()
      expect(err).toBeInstanceOf(GraphQLError)
      expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    }
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, storm_threshold_per_minute: 0 }).storm_threshold_per_minute).toBe(0)
  })

  it('policy di versione precedente (chiavi dell\'ondata 4 assenti) → errore che elenca le chiavi mancanti e la migrazione 1040; altri difetti → nessun riferimento alla migrazione', () => {
    expect(() => parseEventPolicy(JSON.stringify(V1), 'acme')).toThrow(/Tenant acme event_policy is invalid: .*flap_stable_minutes must be an integer >= 0.* — missing flap_stable_minutes, storm_threshold_per_minute, storm_cooldown_minutes: run the 20260909_1040_event_management_policy_v2 migration/)
    expect(() => parseEventPolicy(JSON.stringify({ ...DEFAULT_EVENT_POLICY, storm_cooldown_minutes: undefined }), 'acme')).toThrow(/missing storm_cooldown_minutes: run the/)
    expect(() => parseEventPolicy(JSON.stringify({ ...DEFAULT_EVENT_POLICY, group_by: 'host' }), 'acme')).not.toThrow(/migration/)
    expect(() => parseEventPolicy(JSON.stringify({ ...DEFAULT_EVENT_POLICY, group_by: 'host' }), 'acme')).toThrow(/group_by must be one of/)
    expect(parseEventPolicy(DEFAULT_EVENT_POLICY_JSON, 'acme')).toEqual(DEFAULT_EVENT_POLICY)
  })
})

describe('completeEventPolicy (migrazione 1040)', () => {
  it('policy completa → null (non riscrivere); chiavi mancanti → aggiunte dai valori iniziali, quelle presenti intatte anche se non valide (le segnala parseEventPolicy)', () => {
    expect(completeEventPolicy({ ...DEFAULT_EVENT_POLICY })).toBeNull()
    const custom = { ...V1, open_incident_from: 'warning', retention_days: 30 }
    expect(completeEventPolicy(custom)).toEqual({ ...custom, flap_stable_minutes: 15, storm_threshold_per_minute: 50, storm_cooldown_minutes: 5 })
    expect(completeEventPolicy({ ...V1, storm_cooldown_minutes: 99 })).toEqual({ ...V1, storm_cooldown_minutes: 99, flap_stable_minutes: 15, storm_threshold_per_minute: 50 })
    expect(completeEventPolicy({ ...DEFAULT_EVENT_POLICY, group_by: 'host' })).toBeNull()
    const filled = completeEventPolicy({})!
    expect(filled).toEqual(DEFAULT_EVENT_POLICY)
    // il severity_map è una copia, non un riferimento condiviso al default
    expect(filled['severity_map']).not.toBe(DEFAULT_EVENT_POLICY.severity_map)
  })
})

describe('GraphQL ↔ persistita', () => {
  it('toEventPolicyGQL espone flapStableMinutes / stormThresholdPerMinute / stormCooldownMinutes; applyEventPolicyInput li applica e valida', async () => {
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({ flapStableMinutes: 15, stormThresholdPerMinute: 50, stormCooldownMinutes: 5 })
    // tempesta spenta (soglia 0) con raffreddamento 0: coerente
    const next = await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { flapStableMinutes: 30, stormThresholdPerMinute: 0, stormCooldownMinutes: 0 })
    expect(next).toMatchObject({ flap_stable_minutes: 30, storm_threshold_per_minute: 0, storm_cooldown_minutes: 0, flap_threshold: 4 })
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { stormThresholdPerMinute: -5 })).rejects.toThrow(/storm_threshold_per_minute must be an integer >= 0/)
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { flapStableMinutes: null })).rejects.toThrow(/flapStableMinutes cannot be null/)
  })
})

// ── Revisione: versione esplicita (C-4) e massimi/coerenza (I-7) ─────────────

describe('version / updated_at (C-4)', () => {
  it('DEFAULT ha version 1 e updated_at null; toEventPolicyGQL li espone come version/updatedAt', () => {
    expect(DEFAULT_EVENT_POLICY).toMatchObject({ version: 1, updated_at: null })
    expect(EVENT_POLICY_V3_KEYS).toEqual(['version', 'updated_at'])
    expect(EVENT_POLICY_V3_MIGRATION).toBe('20260909_1060_event_management_policy_version')
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({ version: 1, updatedAt: null })
    expect(toEventPolicyGQL({ ...DEFAULT_EVENT_POLICY, version: 7, updated_at: '2026-09-09T10:00:00.000Z' })).toMatchObject({ version: 7, updatedAt: '2026-09-09T10:00:00.000Z' })
  })

  it('applyEventPolicyInput incrementa version e scrive updated_at = now; expectedVersion uguale → ok, diverso → ValidationError con le due versioni; assente → nessun controllo', async () => {
    const now = '2026-09-09T12:00:00.000Z'
    const next = await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { retentionDays: 30, expectedVersion: 1 }, now)
    expect(next).toMatchObject({ version: 2, updated_at: now, retention_days: 30 })
    const third = await applyEventPolicyInput(T, next, { flapThreshold: 5 }, '2026-09-09T13:00:00.000Z')
    expect(third).toMatchObject({ version: 3, updated_at: '2026-09-09T13:00:00.000Z', retention_days: 30, flap_threshold: 5 })
    await expect(applyEventPolicyInput(T, next, { flapThreshold: 5, expectedVersion: 1 })).rejects.toThrow(/modified by someone else \(expected version 1, current is 2, updated at 2026-09-09T12:00:00\.000Z\): reload it/)
    // il client non può scrivere version/updated_at direttamente: non sono nell'input
    expect(await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, {} as never, now)).toMatchObject({ version: 2, updated_at: now })
  })

  it('assertEventPolicy: version intero ≥ 1, updated_at ISO o null; senza version → errore che indica la migrazione 1060 (dopo la 1040 se mancano anche le chiavi v2)', () => {
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, version: 0 })).toThrow(/version must be an integer >= 1/)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, version: '2' })).toThrow(/version must be an integer >= 1/)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, updated_at: 'ieri' })).toThrow(/updated_at must be an ISO date or null/)
    const { version: _v, updated_at: _u, ...unversioned } = DEFAULT_EVENT_POLICY
    expect(() => parseEventPolicy(JSON.stringify(unversioned), 'acme')).toThrow(/missing version, updated_at: run the 20260909_1060_event_management_policy_version migration/)
    expect(() => parseEventPolicy(JSON.stringify(V1), 'acme')).toThrow(/run the 20260909_1040_event_management_policy_v2 migration/)
    expect(() => parseEventPolicy(JSON.stringify(V1), 'acme')).not.toThrow(/1060/)
    // completeEventPolicy (usata dalla 1060) aggiunge version/updated_at a una policy senza
    expect(completeEventPolicy({ ...unversioned })).toEqual({ ...unversioned, version: 1, updated_at: null })
  })
})

describe('massimi e coerenza (I-7)', () => {
  it.each([
    ['open_delay_seconds', EVENT_POLICY_MAX.open_delay_seconds],
    ['suppress_upstream_hops', EVENT_POLICY_MAX.suppress_upstream_hops],
    ['flap_threshold', EVENT_POLICY_MAX.flap_threshold],
    ['flap_window_minutes', EVENT_POLICY_MAX.flap_window_minutes],
    ['flap_stable_minutes', EVENT_POLICY_MAX.flap_stable_minutes],
    ['storm_threshold_per_minute', EVENT_POLICY_MAX.storm_threshold_per_minute],
    ['storm_cooldown_minutes', EVENT_POLICY_MAX.storm_cooldown_minutes],
    ['retention_days', EVENT_POLICY_MAX.retention_days],
  ] as const)('%s: al massimo %i passa, oltre → ValidationError che cita il massimo', (key, max) => {
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: max })[key]).toBe(max)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: max + 1 })).toThrow(new RegExp(`${key} must be at most ${max}\\. Got: ${max + 1}`))
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, [key]: 2 ** 31 - 1 })).toThrow(/must be at most/)
  })

  it('EVENT_POLICY_MAX: hops ≤ 10, delay ≤ 86400, finestre ≤ 1440', () => {
    expect(EVENT_POLICY_MAX).toMatchObject({ suppress_upstream_hops: 10, open_delay_seconds: 86_400, flap_window_minutes: 1_440, flap_stable_minutes: 1_440, storm_cooldown_minutes: 1_440 })
  })

  it('flap_threshold > 0 richiede flap_window_minutes > 0; storm_threshold_per_minute > 0 richiede storm_cooldown_minutes > 0; con la soglia a 0 la finestra può essere 0', async () => {
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, flap_threshold: 4, flap_window_minutes: 0 })).toThrow(/flap_window_minutes must be > 0 when flap_threshold is > 0/)
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, flap_threshold: 0, flap_window_minutes: 0 }).flap_threshold).toBe(0)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, storm_threshold_per_minute: 50, storm_cooldown_minutes: 0 })).toThrow(/storm_cooldown_minutes must be > 0 when storm_threshold_per_minute is > 0/)
    expect(assertEventPolicy({ ...DEFAULT_EVENT_POLICY, storm_threshold_per_minute: 0, storm_cooldown_minutes: 0 }).storm_cooldown_minutes).toBe(0)
    // via input GraphQL: stesso messaggio (la UI lo mostra)
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { stormCooldownMinutes: 0 })).rejects.toThrow(/eventPolicy\.storm_cooldown_minutes must be > 0 when storm_threshold_per_minute is > 0/)
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { suppressUpstreamHops: 11 })).rejects.toThrow(/eventPolicy\.suppress_upstream_hops must be at most 10\. Got: 11/)
  })
})

// ── Revisione 2 · D6.3: ciclo di vita ignorato dagli allarmi ─────────────────

describe('ignore_lifecycle_statuses (D6.3) e la semantica del ciclo di vita (ondata 7 · C-4/A-14)', () => {
  /**
   * CONTRATTO RINEGOZIATO (ondata 7 · C-4/A-14). Prima questo test pretendeva
   * che `assertLifecycleStatuses(['dismesso'])` lanciasse con il messaggio
   * `"dismesso" is not one of active, inactive, maintenance, decommissioned…`,
   * cioè che la validazione avvenisse contro `CI_LIFECYCLE_STATUSES`, la lista
   * del CODICE. Quella era la forma scritta del difetto: i valori di
   * `ci_status` sono rinominabili dal cliente, quindi rifiutare `dismesso` era
   * sbagliato (rumoroso) e accettare `decommissioned` dopo la rinomina era
   * peggio (silenzioso).
   *
   * Adesso: `assertLifecycleStatuses` valida solo la FORMA (lista di stringhe
   * non vuote, senza doppioni) e non nomina più nessun valore;
   * l'appartenenza al vocabolario del cliente la controlla
   * `applyEventPolicyInput`, in scrittura, con `assertDomainValue`.
   */
  it('forma: lista di stringhe distinte, vuota ammessa; NESSUNA lista di valori nel codice', () => {
    expect(DEFAULT_EVENT_POLICY.ignore_lifecycle_statuses).toEqual(['decommissioned'])
    expect(EVENT_POLICY_V5_KEYS).toEqual(['ignore_lifecycle_statuses'])
    expect(EVENT_POLICY_V5_MIGRATION).toBe('20260911_1130_shared_domain_rules')
    expect(assertLifecycleStatuses([])).toEqual([])
    expect(assertLifecycleStatuses(['inactive', 'decommissioned'])).toEqual(['inactive', 'decommissioned'])
    expect(assertLifecycleStatuses(['expired', 'revoked'])).toEqual(['expired', 'revoked'])
    // Un valore che il CLIENTE ha aggiunto o rinominato passa la forma: non
    // c'è più nessuna lista chiusa da superare (era il difetto).
    expect(assertLifecycleStatuses(['dismesso'])).toEqual(['dismesso'])
    // …e il messaggio non elenca più i valori del codice.
    expect(() => assertLifecycleStatuses('decommissioned')).toThrow(/must be a list of CI lifecycle statuses \(values of the ci_status vocabulary\)/)
    expect(() => assertLifecycleStatuses('decommissioned')).not.toThrow(new RegExp(CI_LIFECYCLE_STATUSES.join(', ')))
    expect(() => assertLifecycleStatuses([''])).toThrow(/is not a non-empty string/)
    expect(() => assertLifecycleStatuses([3])).toThrow(/is not a non-empty string/)
    expect(() => assertLifecycleStatuses(['inactive', 'inactive'])).toThrow(/inactive appears twice/)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, ignore_lifecycle_statuses: 'nope' })).toThrow(/event_policy\.ignore_lifecycle_statuses/)
  })

  it('la SEMANTICA è dato del cliente: retired_statuses e maintenance_statuses partono dai valori che il codice usava', () => {
    expect(DEFAULT_EVENT_POLICY.retired_statuses).toEqual(['inactive', 'decommissioned'])
    expect(DEFAULT_EVENT_POLICY.maintenance_statuses).toEqual(['maintenance'])
    expect(EVENT_POLICY_V6_KEYS).toEqual(['retired_statuses', 'maintenance_statuses'])
    expect(EVENT_POLICY_V6_MIGRATION).toBe('20260917_1810_ci_lifecycle_semantics')
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({
      retiredStatuses: ['inactive', 'decommissioned'], maintenanceStatuses: ['maintenance'],
    })
  })

  it('policy senza le chiavi dell\'ondata 7 → errore che indica la migrazione 1810; completeEventPolicy le aggiunge', () => {
    const { retired_statuses: _r, maintenance_statuses: _m, ...withoutV6 } = DEFAULT_EVENT_POLICY
    expect(() => parseEventPolicy(JSON.stringify(withoutV6), 'acme')).toThrow(/ — missing retired_statuses, maintenance_statuses: run the 20260917_1810_ci_lifecycle_semantics migration/)
    expect(completeEventPolicy({ ...withoutV6 })).toEqual({ ...withoutV6, retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'] })
    expect(completeEventPolicy({ ...DEFAULT_EVENT_POLICY })).toBeNull()
  })

  it('GraphQL: le tre liste in lettura e scrittura (lista completa, mai null); l\'appartenenza è al vocabolario DEL CLIENTE', async () => {
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({ ignoreLifecycleStatuses: ['decommissioned'] })
    expect(await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { ignoreLifecycleStatuses: [] })).toMatchObject({ ignore_lifecycle_statuses: [], version: 2 })
    expect((await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { ignoreLifecycleStatuses: ['inactive', 'decommissioned'] })).ignore_lifecycle_statuses).toEqual(['inactive', 'decommissioned'])
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { ignoreLifecycleStatuses: null })).rejects.toThrow(/ignoreLifecycleStatuses cannot be null/)
    // Il valore RINOMINATO dal cliente è ora accettato: è nel suo vocabolario.
    expect((await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { ignoreLifecycleStatuses: ['dismesso'] })).ignore_lifecycle_statuses).toEqual(['dismesso'])
    expect((await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { retiredStatuses: ['dismesso'] })).retired_statuses).toEqual(['dismesso'])
    expect((await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { maintenanceStatuses: [] })).maintenance_statuses).toEqual([])
    // Un valore che NON è nel vocabolario del cliente resta rifiutato, e il
    // messaggio elenca i valori VERI del cliente.
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { ignoreLifecycleStatuses: ['spento'] })).rejects.toThrow(/"spento" non è nel vocabolario di questo cliente/)
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { retiredStatuses: ['spento'] })).rejects.toThrow(/"spento" non è nel vocabolario di questo cliente/)
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { maintenanceStatuses: ['spento'] })).rejects.toThrow(/"spento" non è nel vocabolario di questo cliente/)
    // assente nell'input → invariata
    expect((await applyEventPolicyInput(T, { ...DEFAULT_EVENT_POLICY, ignore_lifecycle_statuses: [] }, { retentionDays: 10 })).ignore_lifecycle_statuses).toEqual([])
  })

  it('policy senza la chiave → errore che indica la migrazione 1130; completeEventPolicy la aggiunge col default', () => {
    const { ignore_lifecycle_statuses: _i, ...withoutV5 } = DEFAULT_EVENT_POLICY
    expect(() => parseEventPolicy(JSON.stringify(withoutV5), 'acme')).toThrow(/ — missing ignore_lifecycle_statuses: run the 20260911_1130_shared_domain_rules migration/)
    expect(completeEventPolicy({ ...withoutV5 })).toEqual({ ...withoutV5, ignore_lifecycle_statuses: ['decommissioned'] })
    // la copia è profonda: modificarla non tocca il default
    const completed = completeEventPolicy({ ...withoutV5 })!
    ;(completed['ignore_lifecycle_statuses'] as string[]).push('inactive')
    expect(DEFAULT_EVENT_POLICY.ignore_lifecycle_statuses).toEqual(['decommissioned'])
  })
})

// ── Revisione A-2 (3): riconoscimento per nome corto/FQDN ────────────────────

describe('match_short_hostname (A-2)', () => {
  it('DEFAULT è false; booleano obbligatorio; toEventPolicyGQL/applyEventPolicyInput lo espongono come matchShortHostname', async () => {
    expect(DEFAULT_EVENT_POLICY.match_short_hostname).toBe(false)
    expect(EVENT_POLICY_V4_KEYS).toEqual(['match_short_hostname'])
    expect(EVENT_POLICY_V4_MIGRATION).toBe('20260910_1070_event_management_tenants')
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, match_short_hostname: 'yes' })).toThrow(/match_short_hostname must be a boolean/)
    expect(() => assertEventPolicy({ ...DEFAULT_EVENT_POLICY, match_short_hostname: 1 })).toThrow(/match_short_hostname must be a boolean/)
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({ matchShortHostname: false })
    expect(await applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { matchShortHostname: true })).toMatchObject({ match_short_hostname: true, version: 2 })
    await expect(applyEventPolicyInput(T, DEFAULT_EVENT_POLICY, { matchShortHostname: null })).rejects.toThrow(/matchShortHostname cannot be null/)
    // assente nell'input → invariata
    expect((await applyEventPolicyInput(T, { ...DEFAULT_EVENT_POLICY, match_short_hostname: true }, { retentionDays: 10 })).match_short_hostname).toBe(true)
  })

  it('policy senza match_short_hostname → errore che indica la migrazione 1070 (dopo la 1040 e la 1060 se mancano anche quelle); completeEventPolicy la aggiunge a false', () => {
    const { match_short_hostname: _m, ...withoutV4 } = DEFAULT_EVENT_POLICY
    expect(() => parseEventPolicy(JSON.stringify(withoutV4), 'acme')).toThrow(/match_short_hostname must be a boolean.* — missing match_short_hostname: run the 20260910_1070_event_management_tenants migration/)
    const { version: _v, updated_at: _u, ...withoutV3 } = withoutV4
    expect(() => parseEventPolicy(JSON.stringify(withoutV3), 'acme')).toThrow(/run the 20260909_1060_event_management_policy_version migration/)
    expect(() => parseEventPolicy(JSON.stringify(withoutV3), 'acme')).not.toThrow(/1070/)
    expect(completeEventPolicy({ ...withoutV4 })).toEqual({ ...withoutV4, match_short_hostname: false })
    expect(completeEventPolicy({ ...DEFAULT_EVENT_POLICY, match_short_hostname: true })).toBeNull()
  })
})

// ── Cache in memoria (M11) ───────────────────────────────────────────────────

describe('cache della policy per tenant', () => {
  beforeEach(() => invalidateEventPolicyCache())

  it('vuota → null; dopo cacheEventPolicy la restituisce fino al TTL (30 s), poi null', () => {
    expect(EVENT_POLICY_CACHE_TTL_MS).toBe(30_000)
    expect(getCachedEventPolicy('t1', 1_000)).toBeNull()
    cacheEventPolicy('t1', DEFAULT_EVENT_POLICY, 1_000)
    expect(getCachedEventPolicy('t1', 1_000)).toBe(DEFAULT_EVENT_POLICY)
    expect(getCachedEventPolicy('t1', 1_000 + EVENT_POLICY_CACHE_TTL_MS - 1)).toBe(DEFAULT_EVENT_POLICY)
    expect(getCachedEventPolicy('t1', 1_000 + EVENT_POLICY_CACHE_TTL_MS)).toBeNull()
    // scaduta → rimossa: una lettura successiva "nel passato" non la ritrova
    expect(getCachedEventPolicy('t1', 1_000)).toBeNull()
  })

  it('per tenant: invalidateEventPolicyCache(tenant) toglie solo quello; senza argomento tutto', () => {
    cacheEventPolicy('t1', DEFAULT_EVENT_POLICY, 0)
    cacheEventPolicy('t2', { ...DEFAULT_EVENT_POLICY, retention_days: 7 }, 0)
    expect(getCachedEventPolicy('t2', 0)).toMatchObject({ retention_days: 7 })
    invalidateEventPolicyCache('t1')
    expect(getCachedEventPolicy('t1', 0)).toBeNull()
    expect(getCachedEventPolicy('t2', 0)).not.toBeNull()
    invalidateEventPolicyCache()
    expect(getCachedEventPolicy('t2', 0)).toBeNull()
  })
})
