/**
 * LE PAROLE CHE NON SI TRADUCONO (20 set 2026, ondata 4).
 *
 * ## Perché esiste
 * La regola c'era da mesi — «si traduce ciò che descrive, resta inglese ciò
 * che nomina» — e il glossario no. `servicesShared.tsx` cita «il glossario del
 * progetto» come se esistesse; la migrazione degli enum ha deciso che
 * Standard/Normal/Emergency restano inglesi; i nomi delle lingue non si
 * traducono. Tre decisioni giuste in tre posti, e nessuna lista che un modello
 * possa leggere.
 *
 * Finché a scrivere prosa italiana erano il triage e le note post-incident, il
 * danno era un termine tradotto male in una frase che una persona rilegge.
 * Dall'ondata 4 il modello scrive il `rationale` di una PROPOSTA, che resta
 * nel grafo e che qualcuno leggerà fra mesi: «registro di controllo» al posto
 * di «Audit Log» manda a cercare una pagina che non si chiama così.
 *
 * ## Come si legge questa lista
 * Non è «parole inglesi che ci piacciono». È: **termini che NOMINANO qualcosa
 * di preciso dentro il prodotto o nel mestiere**, dove la traduzione rompe il
 * collegamento fra quello che il modello scrive e quello che la persona vede
 * sullo schermo o cerca nella documentazione.
 *
 * Quando una parola è solo descrittiva si traduce, e infatti qui non c'è:
 * «gravità» sta per severity nelle frasi, «coda» per queue, «guasto» per
 * fault. La prova che serve a distinguere: **esiste una voce di menu, un
 * campo, uno stato o uno standard che si chiama così?** Se sì, resta.
 */

/**
 * I termini, con il motivo per cui ciascuno è qui. Il motivo non è
 * decorazione: è quello che permette a chi aggiunge una voce fra sei mesi di
 * capire se ne ha il diritto.
 */
export const GLOSSARIO: ReadonlyArray<{ termine: string; perche: string }> = [
  // ── Entità ITIL: sono i nomi dei ticket, e sono anche le voci di menu.
  { termine: 'Incident',       perche: 'entità del prodotto e voce di menu' },
  { termine: 'Problem',        perche: 'entità del prodotto e voce di menu' },
  { termine: 'Change',         perche: 'entità del prodotto e voce di menu' },
  { termine: 'Service Request', perche: 'entità del prodotto e voce di menu' },
  { termine: 'Known Error',    perche: 'termine ITIL con un significato preciso' },
  { termine: 'Major Incident', perche: 'stato dichiarabile sul ticket' },
  { termine: 'CAB',            perche: 'sigla ITIL (Change Advisory Board)' },
  // ── Misure e accordi: compaiono come campi e come colonne.
  { termine: 'SLA',            perche: 'campo del ticket e pagina di configurazione' },
  { termine: 'OLA',            perche: 'campo del ticket (il tempo del team)' },
  // ── Oggetti della CMDB.
  { termine: 'CMDB',           perche: 'voce di menu' },
  { termine: 'CI',             perche: 'Configuration Item: sigla usata ovunque nell\'interfaccia' },
  { termine: 'Configuration Item', perche: 'il nome per esteso della stessa cosa' },
  // ── Pagine e funzioni che si chiamano così sullo schermo.
  { termine: 'Audit Log',      perche: 'il nome della pagina' },
  { termine: 'Knowledge Base', perche: 'il nome della pagina' },
  { termine: 'Dry-run',        perche: 'il nome del modo di esecuzione' },
  { termine: 'workflow',       perche: 'il nome del disegnatore e del motore' },
  { termine: 'webhook',        perche: 'il nome dell\'integrazione' },
  // ── I tre tipi di change: decisione esplicita del proprietario (0d5f7694).
  { termine: 'Standard',       perche: 'tipo di change, deciso dal proprietario che resta inglese' },
  { termine: 'Normal',         perche: 'tipo di change, deciso dal proprietario che resta inglese' },
  { termine: 'Emergency',      perche: 'tipo di change, deciso dal proprietario che resta inglese' },
] as const

/** Solo i termini, per chi deve comporre una frase. */
export const TERMINI_INGLESI: readonly string[] = GLOSSARIO.map((v) => v.termine)

/**
 * La riga da mettere fra i blocchi di sistema, subito dopo quella della
 * lingua e PRIMA del contesto cacheabile (`bloccoDiContesto`), così non
 * spezza il prefisso che la cache riusa.
 *
 * È una riga e non un paragrafo: un'istruzione lunga su una cosa piccola si
 * perde fra le altre.
 */
export function rigaDelGlossario(): string {
  return `Keep these terms in English even when writing in another language, `
    + `because they are the names of things the reader sees on screen: `
    + `${TERMINI_INGLESI.join(', ')}.`
}
