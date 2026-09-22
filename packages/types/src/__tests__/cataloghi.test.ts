/**
 * THE PRODUCT'S CLOSED CATALOGUES.
 *
 * Each of these lists is a single source of truth that two or more places
 * read: the API validating a write, the web offering a dropdown, a lint
 * checking the routes. They exist because every one of them was once
 * duplicated, and the copies drifted — an administrator picking a value the
 * page offered and the server refused, or the other way round.
 *
 * What a test can hold here is the shape of the catalogue itself: no
 * duplicates (a duplicate silently shadows an entry in every `find`), every
 * entry well-formed, and the type guard accepting exactly the catalogue and
 * nothing else — because that guard is what stands between a typo in a
 * config file and a permission that grants nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  PERMISSION_AREAS, PERMISSION_CATALOG, PERMISSIONS, isPermission,
  FACTORY_ROLE_PERMISSIONS, TICKET_WORKER_PERMISSION, USERS_ADMIN_PERMISSION,
} from '../permissions.js'
import { USER_ROLES, isUserRole } from '../user.js'
import { API_KEY_PERMISSIONS, isApiKeyPermission } from '../apiKeyPermissions.js'
import { VALUE_COLORS, isValueColor } from '../valueColors.js'
import { NOTIFICATION_SEVERITIES, isNotificationSeverity } from '../notificationSeverity.js'
import { ENTITY_NEO4J_LABELS, TICKET_ENTITY_TYPES, entityNeo4jLabel } from '../entityLabels.js'
import {
  RUNNABLE_STEP_TYPES, ADDABLE_STEP_TYPES, UNIMPLEMENTED_STEP_TYPES, isUnimplementedStepType,
} from '../workflowStepTypes.js'
import { IMPACT_LIMITS, IMPACT_WEIGHT_KEYS, IMPACT_WINDOW_KEYS, PASSWORD_RULE_RANGES, MAX_IMPACT_WEIGHT } from '../configLimits.js'

/** Values no guard may ever accept, whatever the catalogue. */
const NEVER: unknown[] = [undefined, null, 42, true, {}, [], '', ' ', 'nope']

describe('the permission catalogue', () => {
  it('has no duplicate key: a duplicate silently shadows an entry in every lookup', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
  })

  it('every entry belongs to a declared area, and every area is actually used', () => {
    // An entry in an area the matrix does not render is a permission an
    // administrator can never grant from the interface.
    for (const p of PERMISSION_CATALOG) {
      expect(PERMISSION_AREAS).toContain(p.area)
    }
    for (const area of PERMISSION_AREAS) {
      expect(PERMISSION_CATALOG.some((p) => p.area === area)).toBe(true)
    }
  })

  it('PERMISSIONS is the catalogue, in the catalogue\'s order: the matrix renders it area by area', () => {
    expect(PERMISSIONS).toEqual(PERMISSION_CATALOG.map((p) => p.key))
  })

  it('every key is "area.action", never a bare word', () => {
    // The API's operation table is keyed on this shape; a bare key would
    // match nothing and grant nothing, without an error.
    for (const key of PERMISSIONS) {
      expect(key).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })

  it('isPermission accepts exactly the catalogue', () => {
    for (const p of PERMISSIONS) expect(isPermission(p)).toBe(true)
    for (const v of NEVER) expect(isPermission(v)).toBe(false)
    // A typo must be refused, not silently stored as a permission nobody has.
    expect(isPermission('incident.reed')).toBe(false)
    expect(isPermission('Incident.read')).toBe(false)
  })

  it('the two named permissions are in the catalogue', () => {
    expect(isPermission(TICKET_WORKER_PERMISSION)).toBe(true)
    expect(isPermission(USERS_ADMIN_PERMISSION)).toBe(true)
  })
})

describe('the factory roles', () => {
  it('there is one for every role, and each grants only catalogue permissions', () => {
    expect(Object.keys(FACTORY_ROLE_PERMISSIONS).sort()).toEqual([...USER_ROLES].sort())
    for (const [role, perms] of Object.entries(FACTORY_ROLE_PERMISSIONS)) {
      for (const p of perms) expect(isPermission(p), `${role} → ${p}`).toBe(true)
      expect(new Set(perms).size, `${role} has duplicates`).toBe(perms.length)
    }
  })

  it('admin has everything: it is the role that cannot be locked out of its own tenant', () => {
    expect([...FACTORY_ROLE_PERMISSIONS.admin].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('the roles nest: end_user ⊂ nothing, viewer ⊂ operator ⊂ admin', () => {
    const operator = new Set(FACTORY_ROLE_PERMISSIONS.operator)
    for (const p of FACTORY_ROLE_PERMISSIONS.viewer) expect(operator.has(p), `operator missing ${p}`).toBe(true)
    expect(FACTORY_ROLE_PERMISSIONS.operator.length).toBeGreaterThan(FACTORY_ROLE_PERMISSIONS.viewer.length)
  })

  it('only admin may ACCEPT an improvement proposal', () => {
    // Accepting runs any entry of the closed action catalogue without also
    // requiring the underlying action's own permission — a decision taken
    // knowing the consequence. A custom role can grant it, but then it is
    // somebody's written choice.
    for (const role of ['operator', 'viewer', 'end_user'] as const) {
      expect(FACTORY_ROLE_PERMISSIONS[role]).not.toContain('proposal.accept')
    }
    expect(FACTORY_ROLE_PERMISSIONS.admin).toContain('proposal.accept')
  })

  it('no factory role but admin can configure or administer anything', () => {
    // Configuration and administration change the product for everybody in
    // the tenant: they are not "a bit more than an operator".
    const privileged = new Set(PERMISSION_CATALOG
      .filter((p) => p.area === 'configuration' || p.area === 'administration')
      .map((p) => p.key as string))
    for (const role of ['operator', 'viewer', 'end_user'] as const) {
      for (const p of FACTORY_ROLE_PERMISSIONS[role]) expect(privileged.has(p), `${role} has ${p}`).toBe(false)
    }
  })

  it('end_user only touches the portal: it is the role of somebody who is not in IT', () => {
    expect([...FACTORY_ROLE_PERMISSIONS.end_user].sort()).toEqual(['kb.rate', 'portal.read', 'portal.submit'])
  })

  it('viewer reads but never writes, and only the operator is assignable', () => {
    for (const p of FACTORY_ROLE_PERMISSIONS.viewer) expect(p).not.toMatch(/\.write$|\.delete$/)
    expect(FACTORY_ROLE_PERMISSIONS.viewer).not.toContain(TICKET_WORKER_PERMISSION)
    expect(FACTORY_ROLE_PERMISSIONS.operator).toContain(TICKET_WORKER_PERMISSION)
  })
})

describe('user roles', () => {
  it('the guard accepts exactly the four roles', () => {
    for (const r of USER_ROLES) expect(isUserRole(r)).toBe(true)
    for (const v of [...NEVER, 'TENANT_ADMIN', 'OPERATOR', 'Admin']) expect(isUserRole(v)).toBe(false)
  })

  it('the names are the ones stored in the graph, lowercase', () => {
    // The old `TENANT_ADMIN | OPERATOR | APPROVER | VIEWER` never matched a
    // single node (D-21): every role check silently failed closed.
    expect([...USER_ROLES]).toEqual(['admin', 'operator', 'viewer', 'end_user'])
  })
})

describe('API key permissions', () => {
  it('no duplicates, and every one is "resource:action"', () => {
    expect(new Set(API_KEY_PERMISSIONS).size).toBe(API_KEY_PERMISSIONS.length)
    for (const p of API_KEY_PERMISSIONS) expect(p).toMatch(/^[a-z]+:(read|write)$/)
  })

  it('the guard refuses a near miss: a typo used to become a key that could do nothing', () => {
    // `createApiKey` stored permissions unvalidated, so `incident:read`
    // (singular) produced a key that got 403 everywhere, with no warning.
    expect(isApiKeyPermission('incidents:read')).toBe(true)
    expect(isApiKeyPermission('incident:read')).toBe(false)
    expect(isApiKeyPermission('ci:write')).toBe(false)     // no route writes CIs
    for (const v of NEVER) expect(isApiKeyPermission(v)).toBe(false)
  })
})

describe('the small closed vocabularies', () => {
  it('value colours are token family NAMES, never hex: the theme stays one and accessible', () => {
    for (const c of VALUE_COLORS) expect(c).toMatch(/^[a-z]+$/)
    expect(VALUE_COLORS).toContain('neutral')     // an explicit "no accent"
    for (const c of VALUE_COLORS) expect(isValueColor(c)).toBe(true)
    for (const v of [...NEVER, '#ff0000', 'rgb(1,2,3)']) expect(isValueColor(v)).toBe(false)
  })

  it('notification severities are the four the panel renders, not a ticket priority', () => {
    // The page offered these four while the mutation accepted
    // low/medium/high/critical: changing a rule's severity always failed (NT-1).
    expect([...NOTIFICATION_SEVERITIES]).toEqual(['info', 'success', 'warning', 'error'])
    for (const s of NOTIFICATION_SEVERITIES) expect(isNotificationSeverity(s)).toBe(true)
    for (const v of [...NEVER, 'low', 'medium', 'high', 'critical']) expect(isNotificationSeverity(v)).toBe(false)
  })
})

describe('entity labels — the map that ends up inside the Cypher', () => {
  it('every entity type maps to a PascalCase label, and no two types share one', () => {
    const labels = Object.values(ENTITY_NEO4J_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
    for (const l of labels) expect(l).toMatch(/^[A-Z][A-Za-z]+$/)
  })

  it('every ticket type has a label, and the KB article is not a ticket', () => {
    for (const t of TICKET_ENTITY_TYPES) expect(entityNeo4jLabel(t)).toBeTruthy()
    expect(entityNeo4jLabel('kb_article')).toBe('KBArticle')
    expect(TICKET_ENTITY_TYPES).not.toContain('kb_article' as never)
  })

  it('a type the product does not know is undefined, never guessed', () => {
    // The label is interpolated into Cypher: a guessed one would MATCH
    // whatever node carries that id, in any tenant.
    for (const unknown of ['alien', 'Incident', 'incidents', '']) {
      expect(entityNeo4jLabel(unknown)).toBeUndefined()
    }
  })
})

describe('workflow step types', () => {
  it('what the designer can ADD is a subset of what the engine can RUN', () => {
    // Offering a type the engine cannot execute would let an administrator
    // build a process that stops for good at that step.
    for (const t of ADDABLE_STEP_TYPES) expect(RUNNABLE_STEP_TYPES).toContain(t as never)
  })

  it('start and end are the product\'s, not the palette\'s', () => {
    expect(ADDABLE_STEP_TYPES).not.toContain('start' as never)
    expect(ADDABLE_STEP_TYPES).not.toContain('end' as never)
  })

  it('the unimplemented types are none of the runnable ones, and are recognised as such', () => {
    // They stay in the type because an installation may have saved one, and
    // the name says what is missing — better than deleting them and having
    // somebody re-add them believing it an oversight.
    for (const t of UNIMPLEMENTED_STEP_TYPES) {
      expect(RUNNABLE_STEP_TYPES).not.toContain(t as never)
      expect(isUnimplementedStepType(t)).toBe(true)
    }
    for (const t of RUNNABLE_STEP_TYPES) expect(isUnimplementedStepType(t)).toBe(false)
    expect(isUnimplementedStepType('whatever')).toBe(false)
  })
})

describe('configuration ranges — the same numbers for API and interface', () => {
  it('every impact key has a range, and none is inverted', () => {
    // They used to be copied by hand on both sides (G-25): if the API raised
    // a cap, the page kept refusing a value the server accepted.
    for (const k of [...IMPACT_WEIGHT_KEYS, ...IMPACT_WINDOW_KEYS]) {
      const r = IMPACT_LIMITS[k]
      expect(r, k).toBeDefined()
      expect(r.min).toBeLessThan(r.max)
    }
  })

  it('weights are percentages and windows are at least one day', () => {
    for (const k of IMPACT_WEIGHT_KEYS) expect(IMPACT_LIMITS[k]).toEqual({ min: 0, max: MAX_IMPACT_WEIGHT })
    for (const k of IMPACT_WINDOW_KEYS) expect(IMPACT_LIMITS[k].min).toBe(1)
  })

  it('every password rule is a [min, max] pair, in order', () => {
    for (const [name, [min, max]] of Object.entries(PASSWORD_RULE_RANGES)) {
      expect(Number.isInteger(min), name).toBe(true)
      expect(min, name).toBeLessThan(max)
    }
    expect(PASSWORD_RULE_RANGES.minLength[0]).toBeGreaterThanOrEqual(6)
  })
})
