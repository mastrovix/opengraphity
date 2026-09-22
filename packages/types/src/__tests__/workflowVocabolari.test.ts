/**
 * THE CLOSED VOCABULARIES OF THE WORKFLOW DESIGNER.
 *
 * Each of these used to be a free-text field with a placeholder, and each one
 * failed the same way: a typo saved without a word and turned into a wall.
 * `all_assessment_complete` instead of `all_assessments_complete` made the
 * engine answer "unknown transition condition" to every attempt and the
 * ticket never moved again. A trigger nobody recognises makes an edge that
 * nobody walks.
 *
 * The worst of them is the step CATEGORY, because it fails halfway: with
 * `category = 'risolto'` the transition SUCCEEDS and `resolved_at` and
 * `root_cause` stay NULL. The ticket is resolved for the person looking at
 * it and never resolved for the reports, the SLAs and the post-incident.
 * An Italian interface inviting somebody to type an English word is the
 * perfect trap, which is why this one is a dropdown now.
 */
import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_STEP_PURPOSES, isWorkflowStepPurpose, CHANGE_WINDOW_PURPOSES, FACTORY_STEP_PURPOSES,
  WORKFLOW_STEP_CATEGORIES, isWorkflowStepCategory,
  WORKFLOW_TRANSITION_TRIGGERS, isWorkflowTransitionTrigger,
  WORKFLOW_TRANSITION_CONDITIONS, isWorkflowTransitionCondition,
} from '../workflowPurpose.js'
import {
  STEP_FIELDS_ENGINE_OWNED, STEP_FIELDS_IDENTITY, STEP_FIELDS_DERIVED,
  stepFieldRejection, isStepFieldWritable,
} from '../workflowFields.js'
import {
  TICKET_CUSTOM_FIELD_ENTITY_TYPES, isTicketCustomFieldEntityType,
  CUSTOM_FIELD_NAME_RE, customFieldNameReserved,
} from '../ticketCustomFields.js'

const NEVER: unknown[] = [undefined, null, 42, true, {}, [], '', ' ']

describe('step purposes', () => {
  it('no duplicates, and each is a lowercase identifier', () => {
    expect(new Set(WORKFLOW_STEP_PURPOSES).size).toBe(WORKFLOW_STEP_PURPOSES.length)
    for (const p of WORKFLOW_STEP_PURPOSES) expect(p).toMatch(/^[a-z][a-z_]*$/)
  })

  it('the guard accepts the vocabulary and refuses a near miss', () => {
    for (const p of WORKFLOW_STEP_PURPOSES) expect(isWorkflowStepPurpose(p)).toBe(true)
    for (const v of [...NEVER, 'deployment', 'Approval', 'known-error']) expect(isWorkflowStepPurpose(v)).toBe(false)
  })

  it('the maintenance window is the two change purposes, and both are in the vocabulary', () => {
    // `scheduled` is the window planned, `implementation` the window open:
    // `changeIsInWindow` treats them differently, so they must stay two.
    expect([...CHANGE_WINDOW_PURPOSES]).toEqual(['scheduled', 'implementation'])
    for (const p of CHANGE_WINDOW_PURPOSES) expect(isWorkflowStepPurpose(p)).toBe(true)
  })

  it('every factory step name maps to a purpose in the vocabulary', () => {
    // This map exists for the migration and the seed only. Production code
    // reading it would be back to recognising steps by name, which is the
    // defect (a customer renaming `known_error` emptied the KEDB — IT-1).
    for (const [name, purpose] of Object.entries(FACTORY_STEP_PURPOSES)) {
      expect(isWorkflowStepPurpose(purpose), `${name} → ${purpose}`).toBe(true)
    }
    expect(FACTORY_STEP_PURPOSES['deployment']).toBe('implementation')   // renamed
  })
})

describe('step categories — how the ticket looks from outside', () => {
  it('the vocabulary is the eight the product actually uses', () => {
    expect([...WORKFLOW_STEP_CATEGORIES])
      .toEqual(['active', 'waiting', 'escalated', 'resolved', 'closed', 'draft', 'published', 'failed'])
  })

  it('a translated word is refused: it is exactly the half-failure this closed', () => {
    // With `category = 'risolto'` the transition succeeded and resolved_at
    // stayed NULL: resolved for the user, never resolved for the data.
    for (const v of ['risolto', 'chiuso', 'attivo', 'Resolved', ...NEVER]) {
      expect(isWorkflowStepCategory(v)).toBe(false)
    }
    for (const c of WORKFLOW_STEP_CATEGORIES) expect(isWorkflowStepCategory(c)).toBe(true)
  })

  it('category and purpose do not overlap: an approval step and a deployment step are both "active"', () => {
    const purposes = new Set<string>(WORKFLOW_STEP_PURPOSES)
    for (const c of WORKFLOW_STEP_CATEGORIES) expect(purposes.has(c), c).toBe(false)
  })
})

describe('transition triggers and conditions', () => {
  it('the four triggers are the ones something actually walks', () => {
    expect([...WORKFLOW_TRANSITION_TRIGGERS]).toEqual(['manual', 'automatic', 'timer', 'sla_breach'])
    for (const t of WORKFLOW_TRANSITION_TRIGGERS) expect(isWorkflowTransitionTrigger(t)).toBe(true)
    for (const v of [...NEVER, 'auto', 'Manual', 'cron']) expect(isWorkflowTransitionTrigger(v)).toBe(false)
  })

  it('the condition registry is closed, and a plural typo is refused', () => {
    // `all_assessment_complete` used to save silently and turn that edge
    // into a wall: "unknown transition condition" on every attempt (B·M-4).
    expect(isWorkflowTransitionCondition('all_assessments_complete')).toBe(true)
    expect(isWorkflowTransitionCondition('all_assessment_complete')).toBe(false)
    for (const c of WORKFLOW_TRANSITION_CONDITIONS) expect(isWorkflowTransitionCondition(c)).toBe(true)
    for (const v of NEVER) expect(isWorkflowTransitionCondition(v)).toBe(false)
  })

  it('the engine\'s own built-in condition is in the list too', () => {
    // It is registered by the engine rather than by conditions.ts; leaving
    // it out would make the designer refuse a condition that works.
    expect(WORKFLOW_TRANSITION_CONDITIONS).toContain('rootCause != null')
  })
})

describe('which ticket fields a step may write', () => {
  it('status and the engine\'s own fields are refused, and the message says to use a transition', () => {
    // `update_field(status = closed)` used to bypass the engine: the ticket
    // status and the process step drifted apart in silence (B-9).
    for (const f of STEP_FIELDS_ENGINE_OWNED) {
      const r = stepFieldRejection(f, 'incident')
      expect(r?.reason, f).toBe('engine_owned')
      expect(r?.message).toContain('use a transition')
      expect(isStepFieldWritable(f, 'incident')).toBe(false)
    }
  })

  it('identity and audit fields are refused on every entity type', () => {
    for (const f of STEP_FIELDS_IDENTITY) {
      for (const t of ['incident', 'problem', 'change', 'service_request']) {
        expect(stepFieldRejection(f, t)?.reason, `${t}.${f}`).toBe('identity')
      }
    }
  })

  it('a change\'s derived fields are refused only on a change', () => {
    // The priority of a change comes from its type and risk, and the type
    // itself decides the approval route: setting it from a step would bypass
    // the gate. On an incident, `priority` is an ordinary field.
    for (const f of STEP_FIELDS_DERIVED['change']!) {
      expect(stepFieldRejection(f, 'change')?.reason, f).toBe('derived')
    }
    expect(stepFieldRejection('priority', 'incident')).toBeNull()
    expect(isStepFieldWritable('impact', 'incident')).toBe(true)
  })

  it('anything else is writable: the customer\'s own metamodel decides', () => {
    // The allow-list was reversed on purpose — a field a customer added must
    // be settable from a step. The API checks it exists for that type.
    for (const f of ['severity', 'description', 'category', 'campo_del_cliente', 'cost_centre']) {
      expect(stepFieldRejection(f, 'incident')).toBeNull()
    }
    expect(stepFieldRejection('anything', 'a_type_with_no_derived_fields')).toBeNull()
  })
})

describe('custom field names', () => {
  it('the four ticket types have custom fields, and nothing else does', () => {
    expect([...TICKET_CUSTOM_FIELD_ENTITY_TYPES]).toEqual(['incident', 'problem', 'change', 'service_request'])
    for (const t of TICKET_CUSTOM_FIELD_ENTITY_TYPES) expect(isTicketCustomFieldEntityType(t)).toBe(true)
    for (const v of [...NEVER, 'kb_article', 'ci']) expect(isTicketCustomFieldEntityType(v)).toBe(false)
  })

  it('a name is lowercase, starts with a letter, and is 2 to 40 characters', () => {
    // It becomes the node property, the import column header and the REST
    // key: all three have to stay the same string.
    for (const ok of ['ab', 'cost_centre', 'sede2', 'a'.repeat(40)]) {
      expect(CUSTOM_FIELD_NAME_RE.test(ok), ok).toBe(true)
    }
    for (const bad of ['a', 'A_field', '2fields', 'con-trattino', 'con spazio', 'a'.repeat(41), 'accénti', '']) {
      expect(CUSTOM_FIELD_NAME_RE.test(bad), bad).toBe(false)
    }
  })

  it('a name the product writes itself is reserved, and on a change also its derived fields', () => {
    expect(customFieldNameReserved('status', 'incident')).toBe(true)
    expect(customFieldNameReserved('tenant_id', 'incident')).toBe(true)
    expect(customFieldNameReserved('approval_route', 'change')).toBe(true)
    expect(customFieldNameReserved('approval_route', 'incident')).toBe(false)
    expect(customFieldNameReserved('cost_centre', 'incident')).toBe(false)
  })
})
