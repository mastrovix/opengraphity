/**
 * The shared pieces of the Services pages: health/status badges, colour
 * families, the impact bar and the plain-language explanation. The house
 * rule they enforce is FAIL-LOUD: a value outside the vocabulary never
 * disappears and never borrows a plausible colour — it is labelled
 * "Unknown (<value>)" and painted in the broken tint with a console error.
 * If that regresses, a service whose backend sends a new health value looks
 * "operational" to the on-call engineer. The explanation sentence is covered
 * further in servicesShared.explain.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import type { ImpactCause } from '@/types/services'
import {
  SERVICE_HEALTH_FAMILY, isServiceHealth, serviceHealthLabel, serviceHealthFamily, ServiceHealthBadge,
  healthIfActiveNote, staleMessage, staleShortLabel, serviceStatusLabel, ServiceStatusPill, ServiceSyncModePill,
  ciHealthLabel, NodeHealthBadge, nodeHealthFamily, roleLabel, excludedReasonLabel, propagationLabel,
  ImpactScore, causeVia, causeSequenceLabel, causeLabel, explanationSentence,
} from './servicesShared'

const t = i18n.t.bind(i18n)
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

const cause = (over: Partial<ImpactCause> = {}): ImpactCause => ({
  ci: { id: 'db', name: 'db-01', type: 'database' }, health: 'down', weight: 5, critical: false, path: [], ...over,
} as ImpactCause)

describe('service health', () => {
  it('recognises only vocabulary values', () => {
    expect(isServiceHealth('down')).toBe(true)
    expect(isServiceHealth('on_fire')).toBe(false)
    expect(isServiceHealth(null)).toBe(false)
    expect(isServiceHealth(undefined)).toBe(false)
  })

  it('labels a known health and says an unknown one in plain words', () => {
    expect(serviceHealthLabel(t, 'degraded')).toBe(t('monitoring.services.health.degraded'))
    expect(serviceHealthLabel(t, 'on_fire')).toBe('Unknown (on_fire)')
  })

  it('an unknown health gets the broken colour family and a console error', () => {
    expect(serviceHealthFamily('down')).toBe(SERVICE_HEALTH_FAMILY.down)
    const broken = serviceHealthFamily('on_fire')
    expect(Object.values(SERVICE_HEALTH_FAMILY)).not.toContain(broken)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('on_fire'))
  })

  it('the badge shows the label; an unknown value is still visible', () => {
    render(<><ServiceHealthBadge health="operational" /><ServiceHealthBadge health={'on_fire' as never} /></>)
    expect(screen.getByText(t('monitoring.services.health.operational'))).toBeInTheDocument()
    expect(screen.getByText('Unknown (on_fire)')).toBeInTheDocument()
  })
})

describe('healthIfActiveNote', () => {
  it('in maintenance, says what the health would be without the change window', () => {
    expect(healthIfActiveNote(t, { health: 'maintenance', healthIfActive: 'down' })).toBe(`in maintenance, would be: ${t('monitoring.services.health.down')}`)
  })
  it('says nothing outside maintenance or when there is nothing to add', () => {
    expect(healthIfActiveNote(t, { health: 'down', healthIfActive: 'down' })).toBeNull()
    expect(healthIfActiveNote(t, { health: 'maintenance', healthIfActive: null })).toBeNull()
  })
})

describe('stale map messages', () => {
  it('each reason has its own message; an unknown reason is named, not hidden', () => {
    expect(staleMessage(t, null)).toBe(t('monitoring.services.stale'))
    expect(staleMessage(t, 'missing_ci')).toBe(t('monitoring.services.staleMissingCi'))
    // over the limit a sync would fail again: the text must not suggest it
    expect(staleMessage(t, 'over_limit')).toBe(t('monitoring.services.staleOverLimit'))
    expect(staleMessage(t, 'moon_phase')).toContain('moon_phase')
  })
  it('the short label follows the same reasons', () => {
    expect(staleShortLabel(t, 'over_limit')).toBe(t('monitoring.services.staleShortOverLimit'))
    expect(staleShortLabel(t, null)).toBe(t('monitoring.services.staleShort'))
    expect(staleShortLabel(t, 'missing_ci')).toBe(t('monitoring.services.staleShort'))
    expect(staleShortLabel(t, 'moon_phase')).toBe('Unknown (moon_phase)')
  })
})

describe('map status and sync mode', () => {
  it('labels known statuses and names unknown ones', () => {
    expect(serviceStatusLabel(t, 'paused')).toBe(t('monitoring.services.status.paused'))
    expect(serviceStatusLabel(t, 'archived')).toBe('Unknown (archived)')
  })
  it('the status pill shows the label, with the broken tint for an unknown status', () => {
    render(<><ServiceStatusPill status="active" /><ServiceStatusPill status={'archived' as never} /></>)
    expect(screen.getByText(t('monitoring.services.status.active'))).toBeInTheDocument()
    expect(screen.getByText('Unknown (archived)')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('archived'))
  })
  it('the sync mode pill says live or frozen in words, with a hint of what it implies', () => {
    render(<><ServiceSyncModePill autoSync /><ServiceSyncModePill autoSync={false} /></>)
    const [live, frozen] = screen.getAllByTestId('sync-mode-badge')
    expect(live).toHaveAttribute('data-mode', 'live')
    expect(live).toHaveTextContent(t('monitoring.services.syncMode.live'))
    expect(frozen).toHaveAttribute('data-mode', 'frozen')
    expect(frozen!.parentElement).toHaveAttribute('title', t('monitoring.services.syncMode.frozenHint'))
  })
})

describe('component (CI) health', () => {
  it('null is "unknown", an out-of-vocabulary value is named', () => {
    expect(ciHealthLabel(t, null)).toBe(t('events.health.unknown'))
    expect(ciHealthLabel(t, 'down')).toBe(t('events.health.down'))
    expect(ciHealthLabel(t, 'smoking')).toBe('Unknown (smoking)')
  })
  it('the node badge shows null as unknown without an error, and an unknown value loudly', () => {
    render(<><NodeHealthBadge health={null} /><NodeHealthBadge health="degraded" /></>)
    expect(screen.getByText(t('events.health.unknown'))).toBeInTheDocument()
    expect(screen.getByText(t('events.health.degraded'))).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
    render(<NodeHealthBadge health={'smoking' as never} />)
    expect(screen.getByText('Unknown (smoking)')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
  })
  it('a node in maintenance is purple whatever its health; null is neutral; unknown is broken', () => {
    expect(nodeHealthFamily('down', true)).toBe(SERVICE_HEALTH_FAMILY.maintenance)
    expect(nodeHealthFamily(null, false)).toBe(SERVICE_HEALTH_FAMILY.unknown)
    expect(nodeHealthFamily('degraded', false)).toBe(SERVICE_HEALTH_FAMILY.degraded)
    expect(Object.values(SERVICE_HEALTH_FAMILY)).not.toContain(nodeHealthFamily('smoking' as never, false))
  })
})

describe('role, excluded reason, propagation', () => {
  it('known values are translated, unknown ones named', () => {
    expect(roleLabel(t, 'entry')).toBe(t('monitoring.services.role.entry'))
    expect(roleLabel(t, 'sidecar')).toBe('Unknown (sidecar)')
    expect(propagationLabel(t, 'weighted')).toBe(t('monitoring.services.propagation.weighted'))
    expect(propagationLabel(t, 'sometimes')).toBe('Unknown (sometimes)')
  })
  it('a component that counted has no excluded reason to show', () => {
    expect(excludedReasonLabel(t, null)).toBeNull()
    expect(excludedReasonLabel(t, 'change_window')).toBe(t('monitoring.services.excludedReason.change_window'))
    expect(excludedReasonLabel(t, 'vacation')).toBe('Unknown (vacation)')
  })
})

describe('ImpactScore', () => {
  it('clamps the score to 0–100 in the number and in the accessible label', () => {
    render(<><ImpactScore score={140} health="down" /><ImpactScore score={-5} health="operational" width={40} /></>)
    expect(screen.getByLabelText('Impact score 100 out of 100')).toHaveTextContent('100')
    expect(screen.getByLabelText('Impact score 0 out of 100')).toHaveTextContent('0')
  })
})

describe('causes', () => {
  const viaApi = cause({ path: [{ id: 'db', name: 'db-01' }, { id: 'api', name: 'api-03' }] })

  it('the "via" node is the next step on the path, skipping the cause itself', () => {
    expect(causeVia(viaApi)).toEqual({ id: 'api', name: 'api-03' })
    expect(causeVia(cause())).toBeNull()
  })
  it('the sequence runs from the cause to the service', () => {
    expect(causeSequenceLabel(viaApi, 'Billing')).toBe('db-01 → api-03 → Billing')
    expect(causeSequenceLabel(cause(), 'Billing')).toBe('db-01 → Billing')
  })
  it('the short cause label mentions the via node only when there is one', () => {
    const down = t('monitoring.services.explain.word.down')
    expect(causeLabel(t, viaApi)).toBe(`db-01 ${down} via api-03`)
    expect(causeLabel(t, cause())).toBe(`db-01 ${down}`)
    expect(causeLabel(t, cause({ health: 'melting' as never }))).toBe('db-01 Unknown (melting)')
  })
})

describe('explanationSentence', () => {
  const base = { explanation: [] as ImpactCause[] }
  it('without causes the sentence depends on the health, and down without causes is said plainly', () => {
    expect(explanationSentence(t, { ...base, health: 'operational' })).toBe(t('monitoring.services.explain.operational'))
    expect(explanationSentence(t, { ...base, health: 'unknown' })).toBe(t('monitoring.services.explain.unknown'))
    expect(explanationSentence(t, { ...base, health: 'maintenance' })).toBe(t('monitoring.services.explain.maintenance'))
    expect(explanationSentence(t, { ...base, health: 'down' })).toBe(`${t('monitoring.services.health.down')}: no cause recorded.`)
  })
  it('lists the causes, with the via node and the critical marker', () => {
    const down = t('monitoring.services.explain.word.down')
    const text = explanationSentence(t, {
      health: 'down',
      explanation: [cause({ critical: true, path: [{ id: 'api', name: 'api-03' }] }), cause({ ci: { id: 'c', name: 'cache-02', type: 'server' }, health: 'degraded' })],
    })
    expect(text).toContain(`db-01 is ${down} (via api-03) — critical component`)
    expect(text).toContain('cache-02 is')
  })
  it('operational with rules but no engine count and a score over the threshold keeps the generic sentence', () => {
    const text = explanationSentence(t, { health: 'operational', explanation: [cause()], impactScore: 50, unhealthyCount: null, rules: { degradedSharePct: 30, minNodes: 1 } })
    expect(text).toBe(t('monitoring.services.explain.sentence', { health: t('monitoring.services.health.operational'), causes: `db-01 is ${t('monitoring.services.explain.word.down')}` }))
  })
})
