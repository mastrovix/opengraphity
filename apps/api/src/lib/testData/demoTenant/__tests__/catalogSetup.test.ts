/**
 * THE CATALOG, BUILT WITH THE APP'S OWN DESIGNER (23 Sep 2026; tour of the
 * same day: D28, D54, D56).
 *
 * The configuration diagnostics read what `buildCatalog` leaves behind, and
 * two of their warnings are about it. This file pins that neither fires on a
 * generated tenant:
 *
 *  - D56, «catalog items without a fulfilment group»: every model of
 *    DEMO_CATALOG is created by `createServiceCatalogItem` with a
 *    `fulfillmentTeamId`, and it is a SUPPORT team of the planned people —
 *    the global team of the model's tower at the owner's size, a team of the
 *    tower or the service desk on a smaller tenant; with no support team at
 *    all the generator stops;
 *  - D54, «value labels missing / partial»: every vocabulary the setup
 *    creates gets, through `updateEnumType`'s `valueLabels`, a label for EVERY
 *    value in EVERY language of the product (LINGUE) — read back the way the
 *    diagnostics read it; and the customized `category` (D28) keeps the
 *    shipped labels and adds both languages for the catalog's categories.
 *
 * The resolvers and Neo4j are fakes that record what the setup asks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../auth/resolveAuth.js'
import { LINGUE, parseValueLabels, vocabularyCarriesLabels } from '../../../enumValueLabels.js'
import { Rng } from '../random.js'
import { DemoClock } from '../clock.js'
import { DEFAULT_DEMO_COUNTS } from '../options.js'
import { planPeople, type PlannedTeam } from '../people.js'
import { CATALOG_CATEGORIES, DEMO_CATALOG, DEMO_VOCABULARIES } from '../catalogContent.js'
import { NOW, smallWorld } from './fixtures.js'

interface LabelInput { value: string; language: string; label: string }

const fake = vi.hoisted(() => ({
  created: [] as Array<{ id: string; input: Record<string, unknown> }>,
  customized: [] as string[],
  updates: [] as Array<{ id: string; input: { values?: string[]; valueLabels?: Array<{ value: string; language: string; label: string }> } }>,
  items: [] as Array<Record<string, unknown>>,
  /** The shipped `category` vocabulary, as the system node holds it. */
  shipped: { id: 'system-category', values: [] as string[], labels: '' as unknown },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  runQuery: async () => [fake.shipped],
}))
vi.mock('../../../../graphql/resolvers/enumType.js', () => ({
  createEnumType: async (_p: unknown, { input }: { input: Record<string, unknown> }) => {
    const id = `enum-${String(input['name'])}`
    fake.created.push({ id, input })
    return { id }
  },
  customizeEnumType: async (_p: unknown, { id }: { id: string }) => { fake.customized.push(id); return { id: `copy-of-${id}` } },
  updateEnumType: async (_p: unknown, a: { id: string; input: Record<string, unknown> }) => { fake.updates.push(a as never); return { id: a.id } },
}))
vi.mock('../../../../graphql/resolvers/catalogForm.js', () => ({
  catalogFormResolvers: {
    Mutation: {
      setCatalogFormLimits: async (_p: unknown, args: unknown) => args,
      createFormField: async (_p: unknown, { input }: { input: { name: string } }) => ({ id: `field-${input.name}` }),
      saveCatalogForm: async () => ({ revision: 1 }),
    },
  },
}))
vi.mock('../../../../graphql/resolvers/service_request.js', () => ({
  serviceRequestResolvers: {
    Mutation: {
      createServiceCatalogItem: async (_p: unknown, { input }: { input: Record<string, unknown> }) => {
        fake.items.push(input)
        return { id: `item-${String(fake.items.length)}` }
      },
    },
  },
}))

const { buildCatalog, fulfilmentTeamFor } = await import('../catalogSetup.js')

const ctx = { tenantId: 'demo', userId: 'admin-1', role: 'admin' } as unknown as GraphQLContext
/** The people at the owner's size: every tower has its team in every region, the global one included. */
const FULL = planPeople(new Rng('catalog/people'), new DemoClock(NOW, 3, 'Europe/Rome'), DEFAULT_DEMO_COUNTS).teams
/** A smaller tenant: forty support teams, so some towers have no global team, or no team at all. */
const SMALL_TEAMS = smallWorld('catalog').people.teams

const SHIPPED_CATEGORIES = ['hardware', 'software', 'network', 'access', 'security', 'other']

beforeEach(() => {
  fake.created = []
  fake.customized = []
  fake.updates = []
  fake.items = []
  fake.shipped = {
    id: 'system-category', values: [...SHIPPED_CATEGORIES],
    labels: JSON.stringify(Object.fromEntries(SHIPPED_CATEGORIES.map((v) => [v, { en: v[0]!.toUpperCase() + v.slice(1), it: `(it) ${v}` }]))),
  }
})

const isSupport = (t: PlannedTeam | undefined) => t !== undefined && t.type === 'support' && !t.isChangeManager

/** The labels a `valueLabels` list stores, read back as the diagnostics read them (checkValueLabels). */
function labelProblems(values: readonly string[], list: readonly LabelInput[]): { missing: string[]; partial: string[] } {
  const stored: Record<string, Record<string, string>> = {}
  for (const l of list) stored[l.value] = { ...stored[l.value], [l.language]: l.label }
  const { labels, error } = parseValueLabels(JSON.stringify(stored))
  expect(error).toBeNull()
  return {
    missing: values.filter((v) => labels[v] === undefined),
    partial: values.filter((v) => labels[v] !== undefined && LINGUE.some((l) => labels[v]![l] === undefined)),
  }
}

describe('D56: every model of the catalog has its fulfilment group', () => {
  it('at the owner\'s size: every createServiceCatalogItem carries the global support team of the model\'s tower', async () => {
    const built = await buildCatalog(ctx, 'wd-sr', FULL)
    expect(fake.items.map((i) => i['name'])).toEqual(DEMO_CATALOG.map((s) => s.name))
    DEMO_CATALOG.forEach((spec, i) => {
      const input = fake.items[i]!
      const team = FULL.find((t) => t.id === input['fulfillmentTeamId'])
      expect(isSupport(team), spec.key).toBe(true)
      expect(team!.id).toBe(fulfilmentTeamFor(FULL, spec.fulfilTower).id)
      expect([team!.area, team!.region], spec.key).toEqual([spec.fulfilTower, 'Global'])
      expect(input['workflowDefinitionId']).toBe('wd-sr')
      // The requests of the model go to the same team (serviceRequests.ts reads it from here).
      expect(built.items[i]!.fulfilmentTeamId).toBe(team!.id)
    })
  })

  it('on a smaller tenant: a team of the tower, or the service desk — always a support team of the planned people', async () => {
    await buildCatalog(ctx, null, SMALL_TEAMS)
    expect(fake.items).toHaveLength(DEMO_CATALOG.length)
    const support = SMALL_TEAMS.filter((t) => isSupport(t))
    let withoutTheirTower = 0
    DEMO_CATALOG.forEach((spec, i) => {
      const team = SMALL_TEAMS.find((t) => t.id === fake.items[i]!['fulfillmentTeamId'])
      expect(isSupport(team), spec.key).toBe(true)
      expect(team!.id).toBe(fulfilmentTeamFor(SMALL_TEAMS, spec.fulfilTower).id)
      const ofTower = support.filter((t) => t.area === spec.fulfilTower)
      if (ofTower.length) {
        expect(team!.area, spec.key).toBe(spec.fulfilTower)
        if (ofTower.some((t) => t.region === 'Global')) expect(team!.region, spec.key).toBe('Global')
      } else {
        withoutTheirTower++
        expect(team!.area, spec.key).toBe('Service Desk')
      }
    })
    // The small world lacks some towers: the fallback is really exercised.
    expect(withoutTheirTower).toBeGreaterThan(0)
  })

  it('with no support team at all the generator stops before creating a model without one', async () => {
    const owners = FULL.filter((t) => t.type === 'owner')
    await expect(buildCatalog(ctx, null, owners)).rejects.toThrow('demo catalog: there is no support team to fulfil the requests')
    expect(fake.items).toEqual([])
  })
})

describe('D54: every vocabulary the setup creates is labelled in every language of the product', () => {
  it('each created vocabulary gets, in one updateEnumType, a label in en and it for every value — nothing for the diagnostics to flag', async () => {
    await buildCatalog(ctx, null, FULL)
    expect(fake.created.map((c) => c.input['name'])).toEqual(DEMO_VOCABULARIES.map((v) => v.name))
    expect([...LINGUE].sort()).toEqual(['en', 'it'])
    for (const { id, input } of fake.created) {
      const name = String(input['name'])
      // A vocabulary the diagnostics do check.
      expect(vocabularyCarriesLabels(name), name).toBe(true)
      const values = input['values'] as string[]
      expect(values.length, name).toBeGreaterThan(0)
      const updates = fake.updates.filter((u) => u.id === id)
      expect(updates, name).toHaveLength(1)
      const list = updates[0]!.input.valueLabels!
      expect(labelProblems(values, list), name).toEqual({ missing: [], partial: [] })
      // Every label says something, and none is for a value the vocabulary does not have.
      for (const l of list) {
        expect(l.label.trim(), `${name}.${l.value}.${l.language}`).not.toBe('')
        expect(values, name).toContain(l.value)
      }
      // The list replaces the labels: one per value and language, no more.
      expect(list).toHaveLength(values.length * LINGUE.length)
    }
  })

  it('D28: the customized «category» keeps the shipped labels and adds both languages for the catalog\'s categories', async () => {
    const built = await buildCatalog(ctx, null, FULL)
    expect(fake.customized).toEqual(['system-category'])
    expect(built.vocabularyIds).toContain('copy-of-system-category')
    const [update] = fake.updates.filter((u) => u.id === 'copy-of-system-category')
    const values = update!.input.values!
    expect(values).toEqual([...SHIPPED_CATEGORIES, ...CATALOG_CATEGORIES.map(([v]) => v)])
    expect(labelProblems(values, update!.input.valueLabels!)).toEqual({ missing: [], partial: [] })
    // The shipped labels are the system's own, carried over as they were.
    const shipped = JSON.parse(fake.shipped.labels as string) as Record<string, Record<string, string>>
    for (const v of SHIPPED_CATEGORIES) {
      for (const language of LINGUE) {
        expect(update!.input.valueLabels).toContainEqual({ value: v, language, label: shipped[v]![language] })
      }
    }
  })
})
