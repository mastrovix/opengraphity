/**
 * Il nome del vocabolario del TIPO DI TEAM, lato interfaccia.
 *
 * È la stessa parola che usa l'API (`apps/api/src/lib/teamVocabularies.ts`):
 * il Dizionario, la validazione in scrittura e la tendina devono nominare lo
 * stesso vocabolario, altrimenti la tendina offre valori che il server
 * rifiuta. Scritta due volte perché web e API non condividono un pacchetto per
 * questo, e il test `teamType.test.tsx` pretende che siano uguali.
 */
export const TEAM_TYPE_VOCABULARY = 'team_type'

/**
 * THE TWO TEAM TYPES THE PRODUCT GIVES A JOB TO (D10 / D34, tour of 23 Sep 2026).
 *
 * `team_type` is a vocabulary of the customer, and it may hold more values;
 * these two are the ones the product itself reads, the same words as
 * `ASSESSMENT_ROLE` in lib/taskStatus.ts: the OWNER team owns a CI (it
 * validates and reviews its changes), the SUPPORT team runs it (it plans and
 * deploys changes, and resolves the incidents). The pickers use them to offer
 * the teams that do the job, instead of all five hundred.
 */
export const TEAM_TYPE = { OWNER: 'owner', SUPPORT: 'support' } as const
export type TeamRole = typeof TEAM_TYPE[keyof typeof TEAM_TYPE]

/** What a picker needs to know about a team. */
export interface TeamChoice {
  id:   string
  name: string
  type: string | null
  /** The Change Manager team: it approves changes, it does not own or run CIs. */
  isChangeManager: boolean | null
}

/**
 * The teams that do this job: of that type, and never the Change Manager team
 * (the tour found the Change Management Office offered as the team of an
 * incident). An untyped team is not offered: the picker says what it filters
 * and lets one show all the teams, so nobody is stuck.
 */
export function teamsFor(role: TeamRole, teams: readonly TeamChoice[]): TeamChoice[] {
  return teams.filter((t) => t.type === role && t.isChangeManager !== true)
}
