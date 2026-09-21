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
