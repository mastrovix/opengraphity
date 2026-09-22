/**
 * THE TARGETS AN INBOUND WEBHOOK MAY WRITE.
 *
 * An incoming webhook fills a ticket from an outside system, and the page
 * that configures the mapping offers these. `affectedCI` is the one worth
 * pinning: an incident with no impacted CI does not get created (an ITIL
 * rule the service enforces), so without that target an incident-shaped
 * webhook failed ALWAYS with "An incident must have at least one impacted
 * CI" — the feature was not usable at all (M-18).
 */
import { describe, it, expect } from 'vitest'
import {
  INBOUND_TICKET_FIELDS, INBOUND_AFFECTED_CI_FIELD,
  isInboundTicketEntityType, inboundTicketFieldsFor,
} from '../inboundTicketFields.js'

describe('inbound ticket fields', () => {
  it('an incident can name its impacted CI, and a problem does not need one', () => {
    expect(INBOUND_TICKET_FIELDS.incident).toContain(INBOUND_AFFECTED_CI_FIELD)
    expect(INBOUND_TICKET_FIELDS.problem).not.toContain(INBOUND_AFFECTED_CI_FIELD as never)
  })

  it('both types carry a title and a description: a ticket with neither says nothing', () => {
    for (const fields of Object.values(INBOUND_TICKET_FIELDS)) {
      expect(fields).toContain('title')
      expect(fields).toContain('description')
    }
  })

  it('an incident is graded by severity and a problem by priority', () => {
    expect(INBOUND_TICKET_FIELDS.incident).toContain('severity')
    expect(INBOUND_TICKET_FIELDS.problem).toContain('priority')
  })

  it('no list repeats a target: a duplicate would map the same value twice', () => {
    for (const [type, fields] of Object.entries(INBOUND_TICKET_FIELDS)) {
      expect(new Set(fields).size, type).toBe(fields.length)
    }
  })

  it('the guard takes the two ticket types and nothing else', () => {
    for (const t of Object.keys(INBOUND_TICKET_FIELDS)) expect(isInboundTicketEntityType(t)).toBe(true)
    for (const v of [undefined, null, 42, '', 'change', 'event', 'toString', 'constructor']) {
      expect(isInboundTicketEntityType(v), String(v)).toBe(false)
    }
  })

  it('a type that creates no ticket gives null, not an empty list', () => {
    // `event` has its own validation, per connector: null says "not my
    // business", an empty list would say "no targets allowed".
    expect(inboundTicketFieldsFor('event')).toBeNull()
    expect(inboundTicketFieldsFor('change')).toBeNull()
    expect(inboundTicketFieldsFor(null)).toBeNull()
    expect(inboundTicketFieldsFor(42)).toBeNull()
  })

  it('a ticket type gives exactly its own list', () => {
    expect(inboundTicketFieldsFor('incident')).toBe(INBOUND_TICKET_FIELDS.incident)
    expect(inboundTicketFieldsFor('problem')).toBe(INBOUND_TICKET_FIELDS.problem)
  })
})
