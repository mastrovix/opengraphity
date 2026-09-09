/**
 * Shared fragments (E-17). One selection set for "a user reference" and "a
 * team reference": every document that embeds a user/team picks the same
 * fields, so the Apollo cache normalises them to one entry per id.
 *
 * Interpolate with `${USER_REF}` inside gql`…`; `webDocuments.test.ts`
 * resolves the interpolation when validating the documents against the schema.
 */
import { gql } from '@apollo/client'

export const USER_REF = gql`
  fragment UserRef on User { id name email }
`

export const TEAM_REF = gql`
  fragment TeamRef on Team { id name }
`

/**
 * Evento di monitoraggio (Event Management): un'unica selezione per console,
 * dettaglio, risultati delle mutation e le liste "allarmi" di incident e
 * change, così la cache normalizza per id e ogni vista legge la stessa forma.
 * Contratto: apps/api/src/graphql/schema-events.ts.
 */
export const EVENT_FIELDS = gql`
  fragment EventFields on Event {
    id fingerprint externalId status severity title description
    resource resourceKind labels count
    firstSeenAt lastSeenAt resolvedAt acknowledgedAt
    acknowledgedBy { id name }
    source { id name connectorKind }
    ci { id name type status health }
    incident { id number title status }
    suppressedBy { id code title }
    correlation correlationAt
    flappingSince transitions24h
  }
`
