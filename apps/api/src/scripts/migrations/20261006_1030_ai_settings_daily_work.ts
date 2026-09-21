/**
 * L'INTERRUTTORE DELL'ANALISTA DEL LAVORO QUOTIDIANO (20 set 2026, ondata 5).
 *
 * Il secondo spento di fabbrica, e non è lo stesso del primo:
 * `platformSelfAnalysis` legge l'archivio degli errori del server (che
 * attraversa il perimetro fra i clienti), `dailyWorkAnalysis` legge il
 * registro di UN cliente e propone dentro casa sua. Perimetri diversi,
 * decisioni diverse.
 *
 * Stesso corpo di `20261005_1100`, estratto lì per non averne due copie: una
 * migrazione gira una volta sola, quindi ogni funzione nuova ha bisogno di un
 * id nuovo ma non di una regola nuova.
 */
import type { Migration } from '@opengraphity/neo4j'
import { aggiungiInterruttoriMancanti } from './20261005_1100_ai_settings_missing_features.js'

export const aiSettingsDailyWork: Migration = {
  id: '20261006_1030_ai_settings_daily_work',
  description: 'Add the dailyWorkAnalysis switch (off) to tenants that already saved their AI settings',
  up: (session) => aggiungiInterruttoriMancanti(session, '20261006_1030_ai_settings_daily_work'),
}
