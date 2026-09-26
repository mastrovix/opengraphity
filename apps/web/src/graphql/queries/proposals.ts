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
      counts { open accepted rejected notNow expired superseded openFaults }
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
      auditEntryId executionError executionErrorKey executionErrorParams { name value } undoable
      verification verifiedAt verificationDetail { name value }
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
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
      auditEntryId executionError executionErrorKey executionErrorParams { name value } undoable
      verification verifiedAt verificationDetail { name value }
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
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
      auditEntryId executionError executionErrorKey executionErrorParams { name value } undoable
      verification verifiedAt verificationDetail { name value }
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
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
      auditEntryId executionError executionErrorKey executionErrorParams { name value } undoable
      verification verifiedAt verificationDetail { name value }
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
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
      auditEntryId executionError executionErrorKey executionErrorParams { name value } undoable
      verification verifiedAt verificationDetail { name value }
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
    }
  }
`

export const RUN_PROPOSAL_ANALYSIS = gql`
  mutation RunProposalAnalysis {
    runProposalAnalysis { created skipped { name value } }
  }
`

/**
 * I DUE GESTI DI CHI È D'ACCORDO (20 set 2026).
 *
 * Sei generi di proposta su otto non portano un'azione eseguibile, e fino a
 * oggi per quelli non esisteva un modo di dire «sì»: restavano «rifiuta»,
 * «non ora» o la scadenza. `acknowledgeProposal` è «l'ho vista, è vera, non
 * serve altro»; `openProblemFromProposal` è «è vera e qualcuno ci lavori».
 */
export const ACKNOWLEDGE_PROPOSAL = gql`
  mutation AcknowledgeProposal($id: ID!) {
    acknowledgeProposal(id: $id) {
      id status decidedAt decidedBy decidedByName
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
    }
  }
`

export const OPEN_PROBLEM_FROM_PROPOSAL = gql`
  mutation OpenProblemFromProposal($id: ID!, $impact: String!, $urgency: String!) {
    openProblemFromProposal(id: $id, impact: $impact, urgency: $urgency) {
      id status decidedAt decidedBy decidedByName
      acknowledgeable problemOpenable openedProblemId openedProblemNumber
    }
  }
`

/**
 * IL FASCICOLO D'INDAGINE (20 set 2026).
 *
 * Domanda del proprietario: «una volta aperto il problem come faccio a dire
 * ad Anthropic di risolverlo?». Questo è il ponte: tutto quello che serve a
 * indagare, in un testo solo che si copia in una sessione di sviluppo dove i
 * sorgenti ci sono. Nessuna chiamata al modello — sono fatti, non una
 * seconda interpretazione degli stessi fatti.
 */
export const GET_PROBLEM_DOSSIER = gql`
  query ProblemDossier($problemId: ID!) {
    problemDossier(problemId: $problemId)
  }
`
