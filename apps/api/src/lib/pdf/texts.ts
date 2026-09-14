/**
 * I TESTI DEI DOSSIER PDF, nella lingua del cliente (revisione del 14 set 2026
 * · lingua). Intestazioni, etichette e colonne erano italiane per ogni cliente;
 * il PDF si stampa con `PdfMeta.locale`, quindi la lingua è quella del cliente
 * (le date seguono già il suo fuso).
 *
 * I nomi tecnici restano uguali nelle due lingue (Root cause, Workaround,
 * Status, Trigger, Watcher, Risk score, Environment, Filename).
 */
import type { PdfLocale } from './common.js'

type Texts = { en: string; it: string }

export const PDF_TEXTS = {
  details:            { en: 'Details', it: 'Dettagli' },
  description:        { en: 'Description', it: 'Descrizione' },
  category:           { en: 'Category', it: 'Categoria' },
  createdAt:          { en: 'Created on', it: 'Creato il' },
  updatedAt:          { en: 'Updated on', it: 'Aggiornato il' },
  resolvedAt:         { en: 'Resolved on', it: 'Risolto il' },
  closedAt:           { en: 'Closed on', it: 'Chiuso il' },
  createdBy:          { en: 'Created by', it: 'Creato da' },
  assignee:           { en: 'Assignee', it: 'Assegnatario' },
  affectedUsers:      { en: 'Affected users', it: 'Utenti impattati' },
  why:                { en: 'Why', it: 'Perché' },
  what:               { en: 'What', it: 'Cosa' },
  requester:          { en: 'Requester', it: 'Richiedente' },
  approval:           { en: 'Approval', it: 'Approvazione' },
  slaLine:            { en: 'SLA — response by: {response} ({responseMet})  |  resolution by: {resolve} ({resolveMet})', it: 'SLA — risposta entro: {response} ({responseMet})  |  risoluzione entro: {resolve} ({resolveMet})' },
  met:                { en: 'met', it: 'rispettata' },
  notMet:             { en: 'not met', it: 'non rispettata' },
  affectedCIs:        { en: 'Affected CIs ({count})', it: 'CI impattati ({count})' },
  noCIs:              { en: 'No linked CI.', it: 'Nessun CI collegato.' },
  noTasksForCI:       { en: 'No task for this CI.', it: 'Nessun task per questo CI.' },
  phase:              { en: 'phase', it: 'fase' },
  colName:            { en: 'Name', it: 'Nome' },
  colType:            { en: 'Type', it: 'Tipo' },
  colTask:            { en: 'Task', it: 'Task' },
  colCode:            { en: 'Code', it: 'Codice' },
  colOutcome:         { en: 'Outcome/Score', it: 'Esito/Score' },
  colCompleted:       { en: 'Completed', it: 'Completato' },
  colDate:            { en: 'Date', it: 'Data' },
  colAction:          { en: 'Action', it: 'Azione' },
  colUser:            { en: 'User', it: 'Utente' },
  colDetail:          { en: 'Detail', it: 'Dettaglio' },
  colStep:            { en: 'Step', it: 'Step' },
  colEntered:         { en: 'Entered', it: 'Entrata' },
  colExited:          { en: 'Exited', it: 'Uscita' },
  colDuration:        { en: 'Duration', it: 'Durata' },
  colActor:           { en: 'Actor', it: 'Attore' },
  colNotes:           { en: 'Notes', it: 'Note' },
  colSize:            { en: 'Size', it: 'Dimensione' },
  colUploadedBy:      { en: 'Uploaded by', it: 'Caricato da' },
  colUploadedAt:      { en: 'Uploaded on', it: 'Caricato il' },
  colNumber:          { en: 'Number', it: 'Numero' },
  colTitle:           { en: 'Title', it: 'Titolo' },
  auditTrail:         { en: 'Audit trail ({count})', it: 'Audit trail ({count})' },
  noAudit:            { en: 'No audit entry.', it: 'Nessuna voce di audit.' },
  workflowHistory:    { en: 'Workflow history ({count})', it: 'Cronologia workflow ({count})' },
  noWorkflowHistory:  { en: 'No workflow history.', it: 'Nessuna cronologia workflow.' },
  comments:           { en: 'Comments ({count})', it: 'Commenti ({count})' },
  noComments:         { en: 'No comments.', it: 'Nessun commento.' },
  unknownUser:        { en: 'Unknown user', it: 'Utente sconosciuto' },
  attachments:        { en: 'Attachments ({count})', it: 'Allegati ({count})' },
  noAttachments:      { en: 'No attachments.', it: 'Nessun allegato.' },
  customFields:       { en: 'Additional fields', it: 'Campi aggiuntivi' },
  relatedIncidents:   { en: 'Related incidents ({count})', it: 'Incident correlati ({count})' },
  noRelatedIncidents: { en: 'No related incident.', it: 'Nessun incident correlato.' },
  relatedChanges:     { en: 'Related changes ({count})', it: 'Change correlate ({count})' },
  noRelatedChanges:   { en: 'No related change.', it: 'Nessuna change correlata.' },
  footerGenerated:    { en: 'Generated on {at} by {by} — tenant {tenant}', it: 'Generato il {at} da {by} — tenant {tenant}' },
  footerPage:         { en: 'Page {page}/{pages}', it: 'Pagina {page}/{pages}' },
  notAvailable:       { en: 'n/a', it: 'n/d' },
  deployPlan:         { en: 'Deploy plan', it: 'Piano di deploy' },
  daysShort:          { en: 'd', it: 'g' },
} as const satisfies Record<string, Texts>

export type PdfTextKey = keyof typeof PDF_TEXTS

export function pdfText(locale: PdfLocale, key: PdfTextKey, params: Record<string, string | number> = {}): string {
  const lang = locale.language === 'it' ? 'it' : 'en'
  return PDF_TEXTS[key][lang].replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m))
}
