import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  mapCI:            vi.fn(),
  ciTypeFromLabels: vi.fn(() => 'server'),
}))

vi.mock('../../../services/incidentService.js', () => ({
  createIncident:            vi.fn(),
  resolveIncident:           vi.fn(),
  assignIncidentToTeam:      vi.fn(),
  assignIncidentToUser:      vi.fn(),
  publishIncidentTransition: vi.fn(),
}))

vi.mock('../../../lib/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { incidentResolvers } = await import('../incident.js')

const slaStatus = incidentResolvers.Incident.slaStatus

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator' }

const parent = { id: 'inc-1', tenantId: 'tenant-1' }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Incident.slaStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
  })

  it('nessun nodo SLAStatus → null', async () => {
    mockSession.executeRead.mockResolvedValueOnce({ records: [] })

    const result = await slaStatus(parent, {}, ctx)

    expect(result).toBeNull()
  })

  it('record presente → mapping snake_case → camelCase', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [{
        get: () => ({
          properties: {
            started_at:        '2026-07-01T10:00:00Z',
            response_deadline: '2026-07-01T11:00:00Z',
            resolve_deadline:  '2026-07-01T18:00:00Z',
            response_met:      true,
            resolve_met:       false,
            breached:          false,
          },
        }),
      }],
    })

    const result = await slaStatus(parent, {}, ctx)

    expect(result).toEqual({
      startedAt:        '2026-07-01T10:00:00Z',
      responseDeadline: '2026-07-01T11:00:00Z',
      resolveDeadline:  '2026-07-01T18:00:00Z',
      responseMet:      true,
      resolveMet:       false,
      breached:         false,
    })
  })

  it('flag null/undefined → coercion booleana a false', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [{
        get: () => ({
          properties: {
            started_at:        '2026-07-01T10:00:00Z',
            response_deadline: '2026-07-01T11:00:00Z',
            resolve_deadline:  '2026-07-01T18:00:00Z',
            response_met:      null,
            // resolve_met assente
            breached:          null,
          },
        }),
      }],
    })

    const result = await slaStatus(parent, {}, ctx)

    expect(result).not.toBeNull()
    expect(result!.responseMet).toBe(false)
    expect(result!.resolveMet).toBe(false)
    expect(result!.breached).toBe(false)
  })
})
