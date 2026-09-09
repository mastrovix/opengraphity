/**
 * lib/eventPolicy.ts — ondata 4: nuove chiavi (flap_stable_minutes,
 * storm_threshold_per_minute, storm_cooldown_minutes) nei valori iniziali,
 * nella validazione, nel mapping GraphQL e nell'input; parseEventPolicy
 * indica la migrazione 1040 quando mancano; completeEventPolicy (usata dalla
 * migrazione) aggiunge solo ciò che manca.
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  DEFAULT_EVENT_POLICY, DEFAULT_EVENT_POLICY_JSON, EVENT_POLICY_V2_KEYS, EVENT_POLICY_V2_MIGRATION,
  assertEventPolicy, parseEventPolicy, completeEventPolicy, toEventPolicyGQL, applyEventPolicyInput,
} from '../eventPolicy.js'

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
  it('toEventPolicyGQL espone flapStableMinutes / stormThresholdPerMinute / stormCooldownMinutes; applyEventPolicyInput li applica e valida', () => {
    expect(toEventPolicyGQL(DEFAULT_EVENT_POLICY)).toMatchObject({ flapStableMinutes: 15, stormThresholdPerMinute: 50, stormCooldownMinutes: 5 })
    const next = applyEventPolicyInput(DEFAULT_EVENT_POLICY, { flapStableMinutes: 30, stormThresholdPerMinute: 200, stormCooldownMinutes: 0 })
    expect(next).toMatchObject({ flap_stable_minutes: 30, storm_threshold_per_minute: 200, storm_cooldown_minutes: 0, flap_threshold: 4 })
    expect(() => applyEventPolicyInput(DEFAULT_EVENT_POLICY, { stormThresholdPerMinute: -5 })).toThrow(/storm_threshold_per_minute must be an integer >= 0/)
    expect(() => applyEventPolicyInput(DEFAULT_EVENT_POLICY, { flapStableMinutes: null })).toThrow(/flapStableMinutes cannot be null/)
  })
})
