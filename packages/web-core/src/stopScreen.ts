/**
 * LA SCHERMATA CHE FERMA L'APP, quando continuare non ha senso (17 set 2026).
 *
 * Nasce dal tenant sospeso: l'app riceveva un rifiuto definitivo e reagiva
 * come se fosse temporaneo — rinfresca, riprova, torna al login — girando per
 * sempre. Un rifiuto definitivo merita l'opposto: una frase, e lo stop.
 *
 * Il testo arriva da chi chiama, tradotto: qui non c'è i18n, perché questo
 * pacchetto è condiviso fra tre app che hanno bundle di lingua diversi.
 *
 * Si scrive come TESTO e non come HTML (revisione totale · F-19): il dettaglio
 * può venire dalla rete, e con `innerHTML` un `<` lo mangerebbe — o peggio,
 * ci si potrebbe infilare del markup.
 */

export interface SchermataDiStop {
  /** Dove disegnarla: di solito il nodo radice dell'app. */
  root: HTMLElement
  titolo: string
  dettaglio: string
}

let giaMostrata = false

/**
 * IDEMPOTENTE, e non per eleganza: le query in polling continuano a tornare
 * rifiutate una dopo l'altra (il portale ne ha una ogni trenta secondi), e
 * ogni rifiuto chiama di nuovo questa funzione. Ridisegnare a ogni giro
 * farebbe lampeggiare la pagina proprio mentre si spiega che è ferma.
 */
export function mostraSchermataDiStop(s: SchermataDiStop): void {
  if (giaMostrata) return
  giaMostrata = true

  const box = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.setAttribute('style', 'display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:system-ui;padding:24px;text-align:center')

  const titolo = document.createElement('div')
  titolo.setAttribute('style', 'font-size:20px;font-weight:600;color:var(--color-danger)')
  titolo.textContent = s.titolo

  const dettaglio = document.createElement('div')
  dettaglio.setAttribute('style', 'color:var(--color-slate);font-size:14px;max-width:46ch;line-height:1.5')
  dettaglio.textContent = s.dettaglio

  box.append(titolo, dettaglio)
  s.root.replaceChildren(box)
}

/** Solo per i test: la schermata si disegna una volta per caricamento di pagina. */
export function resetSchermataDiStop(): void {
  giaMostrata = false
}
