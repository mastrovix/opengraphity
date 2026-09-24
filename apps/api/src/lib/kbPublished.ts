import { ValidationError } from './errors.js'

/**
 * Un articolo KB è pubblicato quando la sua istanza di workflow sta in un passo
 * di **categoria** `published` — non quando il suo stato si chiama «published».
 *
 * Il passo ha un nome del cliente (lo rinomina dal disegnatore) e una categoria
 * del prodotto. Liste, portale e REST già guardavano la categoria; i
 * suggerimenti per somiglianza e l'assistente filtravano su
 * `status = 'published'`, quindi con il passo rinominato restavano vuoti senza
 * dire perché (verifica «Cosa resta cablato», ondata 1).
 */
export function kbArticlePublishedCypher(variable: string): string {
  return `EXISTS { MATCH (${variable})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep {category: 'published'}) }`
}

/**
 * WHO an article is for (owner's decision of 24 Sep 2026: «Pubblico per
 * articolo»). A known error names internal systems and their causes: it is
 * for the staff. A how-to or a FAQ is for everyone, the portal included.
 * The portal shows only the published articles for everyone.
 */
export const KB_AUDIENCES = ['staff', 'everyone'] as const
export type KbAudience = typeof KB_AUDIENCES[number]

/** The audience of an article nobody chose one for: the staff — what is not declared public is not shown outside. */
export const KB_DEFAULT_AUDIENCE: KbAudience = 'staff'

export function isKbAudience(value: unknown): value is KbAudience {
  return typeof value === 'string' && (KB_AUDIENCES as readonly string[]).includes(value)
}

export function assertKbAudience(value: unknown): KbAudience {
  if (isKbAudience(value)) return value
  throw new ValidationError(
    `KB audience "${String(value)}" is not valid: expected one of ${KB_AUDIENCES.join(', ')}`,
    { key: 'errors.kb.invalidAudience', params: { value: String(value), allowed: KB_AUDIENCES.join(', ') } },
  )
}

/** Published AND for everyone: what the portal (who does not work the knowledge base) may read. */
export function kbArticlePortalCypher(variable: string): string {
  return `${kbArticlePublishedCypher(variable)} AND ${variable}.audience = 'everyone'`
}
