import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import it from './locales/it.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, it: { translation: it } },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    /*
      L'INGLESE E' LA LINGUA DEL PRODOTTO, l'italiano una SCELTA (13 set 2026).
      `navigator` era in questa lista, e cambiava tutto: un browser italiano
      — cioe' quasi tutti quelli di chi sviluppa e di chi prova il prodotto —
      atterrava in italiano senza aver scelto niente, e un browser inglese
      atterrava in inglese senza saperlo. Cioe' la lingua non la decideva
      nessuno, e mezza interfaccia si scopriva nella lingua sbagliata per caso.
      Restando il solo `localStorage`, l'italiano si ha SCEGLIENDOLO (dal
      Profilo, che lo scrive qui) e finche' non si sceglie si legge inglese.
    */
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
    },
  })

/**
 * `<html lang>` segue la lingua vera.
 *
 * In `index.html` era `lang="en"`, cablato e mai aggiornato: chi scegliesse
 * l'italiano si ritrovava un lettore di schermo che legge testo italiano con le
 * regole di pronuncia inglesi, e il browser offriva di tradurre una pagina
 * gia' nella lingua giusta. Due righe, e nessun test poteva prenderlo: e'
 * corretto in HTML e sbagliato per chi ascolta.
 */
function allineaLang(lingua: string): void {
  document.documentElement.lang = lingua
}
allineaLang(i18n.resolvedLanguage ?? i18n.language)
i18n.on('languageChanged', allineaLang)

export default i18n
