import { gql } from '@apollo/client'

// ── Aggregati del lavoro quotidiano ──────────────────────────────────────────
// Numeri deterministici, non proposte: esistono perché una persona li guardi
// prima che un modello li legga.

export const GET_DAILY_WORK_AGGREGATES = gql`
  query GetDailyWorkAggregates($windowDays: Int) {
    dailyWorkAggregates(windowDays: $windowDays) {
      coverage {
        tickets withCreationEntry entries humanEntries
        genericEntries unreadableActions windowDays
      }
      actions { object verb n distinctActors distinctObjects }
      stepTimes { stepName n medianHours p90Hours over48h discardedZeros }
      pairs { first then n distinctObjects distinctActors }
      aiUsage { feature n distinctActors }
      thresholds {
        minWindowDays minOccurrences minRunsPerStep
        pairMinOccurrences pairMinDistinctObjects pairMinDistinctActors pairMaxMinutes
      }
    }
  }
`
