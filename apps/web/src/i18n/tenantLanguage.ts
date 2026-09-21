/**
 * QUALE LINGUA, E CHI L'HA DECISA.
 *
 * Tre cose diverse, e prima erano confuse in una:
 *
 *  1. la lingua che una PERSONA ha scelto dal proprio Profilo — vince sempre;
 *  2. la lingua predefinita dell'AZIENDA — configurazione del cliente, e vale
 *     per chi non ha scelto (la maggioranza: nessuno passa dal Profilo il primo
 *     giorno);
 *  3. la lingua del BROWSER, che non è né l'una né l'altra e prima decideva
 *     tutto: `navigator` era nel rilevamento di i18next, quindi un browser
 *     italiano atterrava in italiano e uno inglese in inglese, senza che
 *     nessuno avesse deciso niente — e mezza interfaccia si scopriva nella
 *     lingua sbagliata per caso.
 *
 * ## Perché serve un secondo indicatore
 * i18next tiene la lingua corrente in `localStorage` (`i18nextLng`) e la
 * riscrive a ogni `changeLanguage`, comprese quelle che facciamo NOI applicando
 * il default dell'azienda. Quel valore quindi non sa distinguere «l'ho scelta
 * io» da «me l'ha messa il prodotto»: se lo prendessimo per una scelta, il
 * giorno in cui l'azienda cambia lingua nessuno se ne accorgerebbe. La scelta
 * di una persona si registra qui, e solo il Profilo la scrive.
 */
import i18n from './i18n'

const CHIAVE_SCELTA = 'og.language.chosen'

/** Vero se questa persona ha scelto la propria lingua dal Profilo. */
export function linguaSceltaDallUtente(): boolean {
  try {
    return window.localStorage.getItem(CHIAVE_SCELTA) === 'true'
  } catch {
    // localStorage negato (finestra privata, terze parti bloccate): nessuna
    // scelta registrata, quindi vale il default dell'azienda. Non e un errore.
    return false
  }
}

/** La scelta di una persona: la scrive SOLO il Profilo. */
export async function scegliLinguaPersonale(lingua: string): Promise<void> {
  try { window.localStorage.setItem(CHIAVE_SCELTA, 'true') } catch { /* vedi sopra */ }
  await i18n.changeLanguage(lingua)
}

/** Torna alla lingua dell'azienda: dimentica la scelta personale. */
export async function usaLinguaDellOrganizzazione(lingua: string | null): Promise<void> {
  try { window.localStorage.removeItem(CHIAVE_SCELTA) } catch { /* vedi sopra */ }
  if (lingua) await i18n.changeLanguage(lingua)
}

/**
 * Applica la lingua predefinita dell'azienda. Non tocca chi ha scelto la
 * propria: il chiamante lo verifica con `linguaSceltaDallUtente`, perché la
 * decisione «chi vince» sta scritta in un posto solo e si legge.
 */
export async function applicaLinguaDelCliente(lingua: string): Promise<void> {
  if (i18n.language === lingua) return
  await i18n.changeLanguage(lingua)
}
