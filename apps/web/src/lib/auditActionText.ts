/**
 * COME SI LEGGE UN'AZIONE DELL'AUDIT LOG (20 set 2026, decisione del
 * proprietario dopo il giro nel browser).
 *
 * Il registro scrive il nome tecnico dell'azione — `enum_type.value_renamed`,
 * `service_map.auto_sync_changed` — e la pagina lo mostrava così com'è, sia
 * nella colonna sia nella tendina del filtro. Chi amministra un'organizzazione
 * non ha nessun motivo di sapere che una policy SLA sta dietro alla parola
 * «ola_contract», e la tendina era un elenco di duecento identificatori.
 *
 * ## La regola, decisa dal proprietario
 * Si traducono le AZIONI DI DOMINIO: quelle che qualcuno ha deciso di
 * registrare perché contano («un tipo di CI è stato cancellato», «una
 * scadenza ha spostato un ticket»). NON si traduce `mutation.<nome>`: quella
 * è la rete di sicurezza del registro unico — una mutation che nessuno ha
 * dotato di una voce propria — e il suo nome tecnico È l'informazione, perché
 * dice quale operazione GraphQL è passata.
 *
 * Un'azione che questo bundle non conosce (un'API più nuova, o una voce
 * storica di un vocabolario poi cambiato) si legge grezza, com'era prima: il
 * registro è di conformità, non si nasconde una riga perché non la si sa
 * nominare.
 */

/** Prefisso delle voci scritte dal registro unico delle mutation. */
export const PREFISSO_MUTATION = 'mutation.'

/** Suffisso delle transizioni di workflow: `<entità>.step_entered`. */
const SUFFISSO_PASSO = '.step_entered'

export interface TraduzioneAzione {
  /** Come si legge il t(). */
  t: (key: string, params?: Record<string, unknown>) => string
  /** Se la chiave esiste nella lingua corrente (i18next `exists`). */
  exists: (key: string) => boolean
  /** L'etichetta del cliente per un tipo ITIL, per le transizioni. */
  labelOf?: (entityType: string) => string
}

/**
 * La frase da mostrare per un'azione del registro.
 *
 * Non torna mai vuoto: senza traduzione torna l'azione stessa.
 */
export function auditActionLabel(azione: string, { t, exists, labelOf }: TraduzioneAzione): string {
  // Il registro unico delle mutation: il nome tecnico è il contenuto.
  if (azione.startsWith(PREFISSO_MUTATION)) return azione

  // `incident.step_entered`, `change.step_entered`, … : una sola frase per
  // tutti, con l'etichetta che il cliente ha dato al tipo.
  if (azione.endsWith(SUFFISSO_PASSO)) {
    const entita = azione.slice(0, -SUFFISSO_PASSO.length)
    return t('audit.action.stepEntered', { entity: labelOf ? labelOf(entita) : entita })
  }

  const chiave = `audit.action.${azione}`
  return exists(chiave) ? t(chiave) : azione
}
