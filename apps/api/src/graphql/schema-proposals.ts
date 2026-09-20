/**
 * LE PROPOSTE DI MIGLIORAMENTO — lo schema (20 set 2026).
 *
 * Nota sul titolo: non c'è un campo `title`. C'è `kind` + `params`, e la
 * frase la compone il browser nella lingua di chi guarda — come per i rilievi
 * della diagnostica e per le anomalie. Una frase scritta qui sarebbe congelata
 * in una lingua sola per sempre, e un admin che ha scelto l'inglese dal
 * proprio Profilo la leggerebbe in italiano.
 */
export function proposalsSDL(): string {
  return `
  # ── Proposte di miglioramento ──────────────────────────────────────────────

  type ProposalParam {
    name:  String!
    value: String!
  }

  """Un soggetto delle prove. Il tipo c'è perché la pagina ne fa un link E perché il permesso di lettura si decide sul tipo."""
  type ProposalEvidenceRef {
    entityType: String!
    id:         String!
    label:      String
    """False quando chi guarda non ha il permesso di leggere quel tipo: la riga si conta, non si mostra."""
    visible:    Boolean!
  }

  type ProposalEvidence {
    """Quante volte è stata osservata la cosa."""
    n:          Int!
    """In quanti giorni di finestra. Zero per una fotografia della configurazione."""
    windowDays: Int!
    refs:       [ProposalEvidenceRef!]!
    """Quanti riferimenti sono stati nascosti per mancanza di permessi: si dice, non si tace."""
    hiddenRefs: Int!
    extra:      [ProposalParam!]!
  }

  type Proposal {
    id:          ID!
    area:        String!
    """La chiave della frase: la compone il client. Mai prosa."""
    kind:        String!
    params:      [ProposalParam!]!
    fingerprint: String!
    evidence:    ProposalEvidence!
    """L'ordinamento della pagina. Non è un «tempo risparmiato»: quello non è misurato."""
    occurrences: Int!
    windowDays:  Int!
    """Il tipo dell'azione dal catalogo chiuso, o null per una proposta da leggere e basta."""
    actionType:  String
    """Prosa di un analista AI (ondate future). Null per gli analisti deterministici."""
    rationale:   String
    """La lingua in cui il rationale è stato scritto: la pagina lo dice a chi legge in un'altra."""
    rationaleLanguage: String
    status:      String!
    createdAt:   String!
    decidedAt:   String
    """L'id di chi ha deciso: per mostrarlo usa «decidedByName»."""
    decidedBy:   String
    decidedByName: String
    rejectedKind: String
    rejectedNote: String
    notNowUntil:  String
    """La voce di Audit dell'azione eseguita: dalla proposta si arriva a cosa è successo davvero."""
    auditEntryId: String
    """Perché l'esecuzione è fallita, quando è fallita. Una proposta accettata e non eseguita lo dice."""
    executionError: String
    """Se «Disfa» ha senso adesso: accettata, non già disfatta, con lo stato precedente salvato e un'azione che sa disfarsi. Un bottone che fallirà non si offre."""
    undoable: Boolean!
  }

  type ProposalCounts {
    open:       Int!
    accepted:   Int!
    rejected:   Int!
    notNow:     Int!
    expired:    Int!
    superseded: Int!
  }

  type ProposalsResult {
    items:  [Proposal!]!
    total:  Int!
    counts: ProposalCounts!
    """Quante proposte aperte può avere questo cliente, e quante ne sono già aperte."""
    maxOpen:     Int!
    """Null quando non è mai girata. La pagina distingue «mai girata» da «girata e niente da proporre»."""
    lastRunAt:   String
    """False quando la piattaforma non ha la chiave Anthropic: restano solo le proposte deterministiche."""
    aiAvailable: Boolean!
  }

  type ProposalRunResult {
    """Quante proposte sono nate in questo giro."""
    created: Int!
    """Quante non sono state scritte, e perché: i tetti e la memoria dei rifiuti si vedono."""
    skipped: [ProposalParam!]!
  }

  extend type Query {
    proposals(status: [String!], area: [String!], limit: Int, offset: Int): ProposalsResult!
    proposal(id: ID!): Proposal
  }

  extend type Mutation {
    """Accetta ed esegue. L'azione si esegue come chi accetta, e l'Audit Log lo registra con il suo nome."""
    acceptProposal(id: ID!): Proposal!
    """Rifiuta. La nota è obbligatoria: serve a chi rilegge, e all'analista della volta dopo."""
    rejectProposal(id: ID!, kind: String!, note: String!): Proposal!
    """Rimanda. Non zittisce l'impronta: torna aperta alla data scelta."""
    postponeProposal(id: ID!, until: String!): Proposal!
    """Disfa l'azione di una proposta accettata, se l'azione sa come si disfa."""
    undoProposal(id: ID!): Proposal!
    """Fa girare l'analisi adesso, per questo cliente."""
    runProposalAnalysis: ProposalRunResult!
  }
  `
}
