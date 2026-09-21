/**
 * GLI AGGREGATI DEL LAVORO QUOTIDIANO — lo schema (20 set 2026).
 *
 * Ondata 2 di «Miglioramento continuo». Sono numeri deterministici, non
 * proposte: servono a una persona per guardarli PRIMA che un modello li
 * legga. Se sono sbagliati, si vede qui e non fra due ondate.
 *
 * Il campo che conta di più è `coverage`: dice quanto vedono gli altri. Un
 * aggregato che non dichiara la propria copertura mente per omissione.
 */
export function dailyWorkSDL(): string {
  return `
  # ── Aggregati del lavoro quotidiano ────────────────────────────────────────

  """Quanto vedono gli aggregati. Si legge per primo: se è bassa, tutto il resto parla di una minoranza dei fatti."""
  type DailyWorkCoverage {
    tickets:             Int!
    withCreationEntry: Int!
    entries:         Int!
    """Di quelle, quante sono di una persona e non del prodotto."""
    humanEntries:          Int!
    """Voci generiche \`mutation.*\`: ci sono, ma dicono meno."""
    genericEntries:      Int!
    """Azioni che la normalizzazione non ha saputo leggere: si contano, non si nascondono."""
    unreadableActions:     Int!
    windowDays:     Int!
  }

  type DailyWorkAction {
    object:          String!
    verb:            String!
    n:               Int!
    distinctActors:  Int!
    distinctObjects: Int!
  }

  """Quanto stanno fermi i ticket in un passo. Mediana e p90, MAI la media: su dati veri la media è cinque volte la mediana."""
  type DailyWorkStepTime {
    stepName:    String!
    n:           Int!
    medianHours:  Float!
    p90Hours:      Float!
    over48h:    Int!
    """Esecuzioni scartate perché portavano uno zero finto (le chiusure d'ufficio dell'import)."""
    discardedZeros: Int!
  }

  """Due azioni di fila, stesso oggetto, stessa persona, entro quindici minuti."""
  type DailyWorkPair {
    first:           String!
    then:             String!
    n:               Int!
    distinctObjects: Int!
    distinctActors:  Int!
  }

  type DailyWorkAIUsage {
    feature:        String!
    n:              Int!
    distinctActors: Int!
  }

  type DailyWorkThresholds {
    minWindowDays:     Int!
    minOccurrences:         Int!
    minRunsPerStep: Int!
    pairMinOccurrences:         Int!
    pairMinDistinctObjects:    Int!
    pairMinDistinctActors:     Int!
    pairMaxMinutes:      Int!
  }

  type DailyWorkAggregates {
    coverage:   DailyWorkCoverage!
    actions:    [DailyWorkAction!]!
    stepTimes:  [DailyWorkStepTime!]!
    pairs:      [DailyWorkPair!]!
    aiUsage:    [DailyWorkAIUsage!]!
    """Le soglie del motore, mostrate perché chi legge sappia cosa è stato scartato e perché."""
    thresholds: DailyWorkThresholds!
  }

  extend type Query {
    dailyWorkAggregates(windowDays: Int): DailyWorkAggregates!
  }
  `
}
