/**
 * L'INTERRUTTORE DELL'AUTOANALISI NEI DOCUMENTI GIÀ SALVATI (20 set 2026, ondata 4).
 *
 * `AI_FEATURES` è cresciuto di una voce — `platformSelfAnalysis`, la prima
 * spenta di fabbrica. Tre clienti (`c-one`, `c-two`, `c-test`) avevano già
 * salvato le proprie impostazioni AI, e senza questa migrazione il loro
 * documento elencherebbe otto funzioni su nove.
 *
 * Funzionalmente non cambierebbe niente: la lettura è tollerante e un
 * interruttore assente vale fabbrica, cioè spento. Quello che si evita è un
 * BUCO nei dati — un JSON che elenca otto funzioni su nove è una domanda
 * senza risposta per chi lo leggerà fra sei mesi («era spenta? non
 * esisteva?»), e quella domanda tocca sempre a qualcuno che non c'era.
 *
 * Il corpo è quello di `20261005_1100`, estratto lì per non averne due copie:
 * una migrazione gira una volta sola, quindi ogni funzione nuova ha bisogno di
 * un id nuovo, ma NON di una regola nuova. E la regola che conta è la sua:
 * *se il cliente aveva spento tutto, la funzione nuova nasce spenta* — qui
 * nasce spenta comunque, ma la regola resta quella giusta il giorno in cui la
 * funzione nuova avrà un valore di fabbrica acceso.
 */
import type { Migration } from '@opengraphity/neo4j'
import { aggiungiInterruttoriMancanti } from './20261005_1100_ai_settings_missing_features.js'

export const aiSettingsPlatformSelfAnalysis: Migration = {
  id: '20261006_1020_ai_settings_platform_self_analysis',
  description: 'Add the platformSelfAnalysis switch (off) to tenants that already saved their AI settings',
  up: (session) => aggiungiInterruttoriMancanti(session, '20261006_1020_ai_settings_platform_self_analysis'),
}
