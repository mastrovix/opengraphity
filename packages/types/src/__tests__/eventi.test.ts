/**
 * EVENT IDENTITY, AND THE RELATIONS THAT TIE A TICKET TO A CI.
 *
 * A workflow step event used to be typed after the step's NAME
 * (`incident.resolved`), so renaming a step in the designer silently killed
 * every notification rule and every outgoing webhook subscribed to it. The
 * identity is now the stable type; the name lives in the payload, and the
 * composed type is still published as an ALIAS — dropping that alias would
 * switch off the 35 factory rules and every rule a customer has written,
 * which is exactly the defect.
 */
import { describe, it, expect } from 'vitest'
import {
  STEP_ENTERED_SUFFIX, WORKFLOW_STEP_ENTERED_EVENT,
  stepEnteredEventType, isStepEnteredEventType, stepEnteredEntityType, legacyStepEventType,
  TICKET_CI_RELATIONSHIP, TICKET_CI_TYPES, TICKET_CI_RELATIONSHIPS_PATTERN, isTicketCIType,
  SLA_ENTITY_TYPES, SLA_CATEGORY_ENTITY_TYPES, DEFAULT_SLA_WARNING_MINUTES, TICKET_TEAM_ASSIGNED_EVENT,
} from '../events.js'
import {
  AUTOMATION_ORIGINS, DEFAULT_AUTOMATION_ORIGIN, isAutomationOrigin, AZIONI_AMMESSE_DA_PROPOSTA,
  AUTOMATION_ENTITY_TYPES, AUTOMATION_EVENT_ENTITIES, automationEventSupported,
  AUTOMATION_ACTOR, AUTOMATION_NOTIFICATION_CHANNELS,
} from '../automation.js'

describe('the stable step-entered event type', () => {
  it('is built from the entity, and round-trips back to it', () => {
    for (const t of ['incident', 'problem', 'change', 'service_request', 'kb_article']) {
      const type = stepEnteredEventType(t)
      expect(type).toBe(`${t}.${STEP_ENTERED_SUFFIX}`)
      expect(isStepEnteredEventType(type)).toBe(true)
      expect(stepEnteredEntityType(type)).toBe(t)
    }
  })

  it('the engine\'s own workflow.step_entered is NOT one of an entity', () => {
    // The notification dispatcher treated it as entity "workflow", looked
    // for rules on `workflow.<step>`, found none and logged a warning on
    // EVERY transition of every ticket (C-3): log noise, and a message that
    // said something untrue.
    expect(isStepEnteredEventType(WORKFLOW_STEP_ENTERED_EVENT)).toBe(false)
    expect(stepEnteredEntityType(WORKFLOW_STEP_ENTERED_EVENT)).toBeNull()
  })

  it('anything that does not end in the suffix is not one either', () => {
    for (const t of ['incident.created', 'step_entered', 'incident.step_enteredX', '', 'incident.']) {
      expect(isStepEnteredEventType(t), t).toBe(false)
      expect(stepEnteredEntityType(t), t).toBeNull()
    }
  })

  it('a type that is nothing but the suffix has no entity', () => {
    expect(stepEnteredEntityType(`.${STEP_ENTERED_SUFFIX}`)).toBeNull()
  })

  it('the legacy alias composes entity and STEP NAME — and is not an identity', () => {
    // It is kept for subscriptions already written. Deciding anything on it
    // is what broke when a step got renamed.
    expect(legacyStepEventType('incident', 'resolved')).toBe('incident.resolved')
    expect(legacyStepEventType('change', 'in attesa del CAB')).toBe('change.in attesa del CAB')
  })
})

describe('ticket → CI relations', () => {
  it('every ticket type that links to a CI has its own relation name, all distinct', () => {
    // Three of the names are historical and stay: renaming them means
    // rewriting data and every alarm, service and report query.
    const names = Object.values(TICKET_CI_RELATIONSHIP)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[A-Z_]+$/)
  })

  it('all four are here: the CI detail used to show incidents and changes but not problems', () => {
    expect([...TICKET_CI_TYPES].sort()).toEqual(['change', 'incident', 'problem', 'service_request'])
    for (const t of TICKET_CI_TYPES) expect(isTicketCIType(t)).toBe(true)
    for (const v of [undefined, null, 42, '', 'ci', 'kb_article']) expect(isTicketCIType(v)).toBe(false)
  })

  it('the Cypher pattern lists every relation, pipe-separated', () => {
    const parts = TICKET_CI_RELATIONSHIPS_PATTERN.split('|')
    expect(parts.sort()).toEqual(Object.values(TICKET_CI_RELATIONSHIP).sort())
  })
})

describe('which tickets have an SLA', () => {
  it('a change has none: the page offered it and no policy ever applied', () => {
    // The SLA Policies page let an administrator create a policy for
    // changes, but no change event reaches the engine.
    expect([...SLA_ENTITY_TYPES]).toEqual(['incident', 'problem', 'service_request'])
    expect(SLA_ENTITY_TYPES).not.toContain('change' as never)
  })

  it('all three can have a category-scoped policy', () => {
    expect([...SLA_CATEGORY_ENTITY_TYPES].sort()).toEqual([...SLA_ENTITY_TYPES].sort())
  })

  it('the factory warning lead is a whole number of minutes, and only a default now', () => {
    // It used to be a constant in the scheduler, the same for everybody;
    // now it is a field on the policy (NT-8/F6).
    expect(Number.isInteger(DEFAULT_SLA_WARNING_MINUTES)).toBe(true)
    expect(DEFAULT_SLA_WARNING_MINUTES).toBeGreaterThan(0)
  })

  it('the team-assignment event has its own stable name', () => {
    // A team-scoped policy was only chosen at creation, when there is almost
    // never a team yet (SL-10).
    expect(TICKET_TEAM_ASSIGNED_EVENT).toBe('ticket.team_assigned')
  })
})

describe('automations', () => {
  it('everything that existed before was written by a person', () => {
    expect(DEFAULT_AUTOMATION_ORIGIN).toBe('manual')
    for (const o of AUTOMATION_ORIGINS) expect(isAutomationOrigin(o)).toBe(true)
    for (const v of [undefined, null, 42, '', 'ai', 'AI_PROPOSAL']) expect(isAutomationOrigin(v)).toBe(false)
  })

  it('an automation born from a proposal may only write ticket fields', () => {
    // None of these runs code, calls anything outside, or advances a
    // workflow — the three things the programme forbade for good. The list
    // is applied twice: at creation and again at every switch-on, because
    // the content can change in between.
    expect([...AZIONI_AMMESSE_DA_PROPOSTA].sort()).toEqual(['assign_team', 'create_comment', 'set_field', 'set_sla'])
    for (const forbidden of ['execute_script', 'call_webhook', 'transition', 'create_entity']) {
      expect(AZIONI_AMMESSE_DA_PROPOSTA).not.toContain(forbidden)
    }
  })

  it('every event type declares the tickets it runs on, and they are all known types', () => {
    for (const [eventType, entities] of Object.entries(AUTOMATION_EVENT_ENTITIES)) {
      expect(entities.length, eventType).toBeGreaterThan(0)
      for (const e of entities) expect(AUTOMATION_ENTITY_TYPES, `${eventType} → ${e}`).toContain(e)
    }
  })

  it('a change has no field update: it advances by steps', () => {
    for (const e of ['on_update', 'on_field_change']) {
      expect(automationEventSupported(e, 'change'), e).toBe(false)
      expect(automationEventSupported(e, 'incident'), e).toBe(true)
    }
    expect(automationEventSupported('on_create', 'change')).toBe(true)
    expect(automationEventSupported('on_transition', 'change')).toBe(true)
  })

  it('on_sla_breach runs exactly on the tickets that have an SLA', () => {
    for (const t of AUTOMATION_ENTITY_TYPES) {
      expect(automationEventSupported('on_sla_breach', t), t).toBe((SLA_ENTITY_TYPES as readonly string[]).includes(t))
    }
  })

  it('an unknown event or an unknown entity is not supported, and does not throw', () => {
    expect(automationEventSupported('on_full_moon', 'incident')).toBe(false)
    expect(automationEventSupported('on_create', 'ci')).toBe(false)
  })

  it('an event type that names a prototype property answers "no" instead of throwing', () => {
    // Found writing this test: a plain lookup returns `Object.prototype
    // .toString`, which passes the `!!` and then makes `.includes` throw.
    // The event type comes from an automation's stored data, so a TypeError
    // here is a 500 where the answer is simply "no".
    for (const fromThePrototype of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(automationEventSupported(fromThePrototype, 'incident'), fromThePrototype).toBe(false)
    }
  })

  it('an automation writes as itself, so its own events do not wake the automations again', () => {
    // An "on update" rule that updates a field, or an "on transition" rule
    // that transitions, would otherwise run forever.
    expect(AUTOMATION_ACTOR).toBe('automation')
  })

  it('the notification action delivers in-app and by e-mail', () => {
    // Nobody consumed this event at all for a while (AU-2).
    expect([...AUTOMATION_NOTIFICATION_CHANNELS]).toEqual(['in_app', 'email'])
  })
})
