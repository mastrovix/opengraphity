/**
 * Interno o esterno: i due valori di `Team.sourcing`, lato interfaccia.
 *
 * Gli stessi di `apps/api/src/lib/teamSourcing.ts`, che li valida in
 * scrittura. Non è un vocabolario del Dizionario, di proposito: è un fatto
 * binario (persone dell'organizzazione / di un fornitore), non una
 * classificazione che il cliente arricchisce. Le etichette sono chiavi i18n.
 */
export const TEAM_SOURCINGS = ['internal', 'external'] as const
export type TeamSourcing = typeof TEAM_SOURCINGS[number]

/** La chiave dell'etichetta; un valore sconosciuto (o null) si legge «non indicato». */
export function teamSourcingKey(v: string | null | undefined): string {
  return v === 'internal' || v === 'external' ? `pages.teams.sourcing.${v}` : 'pages.teams.sourcing.notSet'
}
