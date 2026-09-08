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
