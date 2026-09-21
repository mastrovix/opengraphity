import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import it from './it.json'
import en from './en.json'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      it: { translation: it },
      en: { translation: en },
    },
    /*
      LA LINGUA LA DECIDE IL CLIENTE, non il browser (13 set 2026).

      `navigator` era in questa lista e `fallbackLng` era `'it'`: il portale si
      mostrava in italiano a un cliente irlandese, o in inglese a uno italiano
      col browser in inglese, senza che nessuno avesse deciso niente. E chi
      apre il portale e un `end_user`: non ha una pagina dove scegliere la
      lingua, quindi per lui il default dell'azienda non e una comodita — e la
      sola cosa che decide.

      Qui resta solo il bootstrap: la prima lingua spedita, per il tempo che
      passa fra il primo pixel e la risposta di `tenantLanguageSettings`
      (`usePortalLanguage`). La scelta vera arriva dal grafo.
    */
    fallbackLng:   'en',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
    },
  })

/**
 * `<html lang>` segue la lingua vera, come nel web (secondo giro UI del 15 set
 * 2026): nel portale restava quella dell'HTML, e un lettore di schermo leggeva
 * l'inglese con la pronuncia italiana dopo un cambio di lingua.
 */
function allineaLang(lingua: string): void {
  document.documentElement.lang = lingua
}
allineaLang(i18n.resolvedLanguage ?? i18n.language)
i18n.on('languageChanged', allineaLang)

export default i18n
