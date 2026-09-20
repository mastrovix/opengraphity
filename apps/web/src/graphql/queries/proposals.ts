import { gql } from '@apollo/client'

// ── Proposte di miglioramento ────────────────────────────────────────────────
// Il titolo NON arriva da qui: arrivano `kind` e `params`, e la frase la
// compone la pagina nella lingua di chi guarda.
//
// I campi sono ripetuti per esteso in ogni documento invece di essere
// interpolati da una costante: il guardiano `webDocuments.test.ts` confronta
// questi documenti con lo schema dell'API, e un'interpolazione che non sa
// risolvere gli impedisce di controllarli — cioè spegne il controllo proprio
// sul file nuovo.

export const GET_PROPOSALS = gql`
  query GetProposals($status: [String!], $area: [String!], $limit: Int, $offset: Int) {
    proposals(status: $status, area: $area, limit: $limit, offset: $offset) {
      total
      maxOpen
      lastRunAt
      aiAvailable
      counts { open accepted rejected notNow expired superseded }
      items {
        id area kind params { name value }
      evidence {
        n windowDays hiddenRefs
        refs { entityType id label visible }
        extra { name value }
      }
      occurrences windowDays actionType
      rationale rationaleLanguage
      status createdAt decidedAt decidedBy decidedByName
      rejectedKind rejectedNote notNowUntil
      auditEntryId executionError undoable
      }
    }
  }
`

export const ACCEPT_PROPOSAL = gql`
  mutation AcceptProposal($id: ID!) {
    acceptProposal(id: $id) {
        id area kind params { name value }
      evidence {
        n windowDays hiddenRefs
        refs { entityType id label visible }
        extra { name value }
      }
      occurrences windowDays actionType
      rationale rationaleLanguage
      status createdAt decidedAt decidedBy decidedByName
      rejectedKind rejectedNote notNowUntil
      auditEntryId executionError undoable
    }
  }
`

export const REJECT_PROPOSAL = gql`
  mutation RejectProposal($id: ID!, $kind: String!, $note: String!) {
    rejectProposal(id: $id, kind: $kind, note: $note) {
        id area kind params { name value }
      evidence {
        n windowDays hiddenRefs
        refs { entityType id label visible }
        extra { name value }
      }
      occurrences windowDays actionType
      rationale rationaleLanguage
      status createdAt decidedAt decidedBy decidedByName
      rejectedKind rejectedNote notNowUntil
      auditEntryId executionError undoable
    }
  }
`

export const POSTPONE_PROPOSAL = gql`
  mutation PostponeProposal($id: ID!, $until: String!) {
    postponeProposal(id: $id, until: $until) {
        id area kind params { name value }
      evidence {
        n windowDays hiddenRefs
        refs { entityType id label visible }
        extra { name value }
      }
      occurrences windowDays actionType
      rationale rationaleLanguage
      status createdAt decidedAt decidedBy decidedByName
      rejectedKind rejectedNote notNowUntil
      auditEntryId executionError undoable
    }
  }
`

export const UNDO_PROPOSAL = gql`
  mutation UndoProposal($id: ID!) {
    undoProposal(id: $id) {
        id area kind params { name value }
      evidence {
        n windowDays hiddenRefs
        refs { entityType id label visible }
        extra { name value }
      }
      occurrences windowDays actionType
      rationale rationaleLanguage
      status createdAt decidedAt decidedBy decidedByName
      rejectedKind rejectedNote notNowUntil
      auditEntryId executionError undoable
    }
  }
`

export const RUN_PROPOSAL_ANALYSIS = gql`
  mutation RunProposalAnalysis {
    runProposalAnalysis { created skipped { name value } }
  }
`
