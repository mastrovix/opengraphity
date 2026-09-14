/**
 * Chi ha scritto un commento quando non è una persona.
 *
 * I commenti del monitoraggio (`author_id = 'monitoring'`) e delle regole
 * (`author_label` = nome della regola) non hanno un utente: la pagina
 * scriveva «Unknown user» (giro del 14 set 2026). Qui il tipo e il nome, e
 * l'interfaccia li mostra nella sua lingua.
 */
type Props = Record<string, unknown>

export function commentAuthorKind(comment: Props, hasUser: boolean): 'automation' | 'monitoring' | null {
  if (hasUser) return null
  if (comment['author_id'] === 'monitoring') return 'monitoring'
  // Le automazioni scrivono come `AUTOMATION_ACTOR` (consumers/automationConsumer.ts).
  if (comment['author_id'] === 'automation') return 'automation'
  if (typeof comment['author_label'] === 'string' && comment['author_label'] !== '') return 'automation'
  return null
}

export function commentAuthorLabel(comment: Props): string | null {
  return typeof comment['author_label'] === 'string' && comment['author_label'] !== '' ? comment['author_label'] : null
}
