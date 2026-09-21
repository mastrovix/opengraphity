/**
 * L'INTERRUTTORE DELL'AIUTO ALLA CONFIGURAZIONE (20 set 2026, ondata 6).
 *
 * Il terzo e ultimo spento di fabbrica del programma. Stesso corpo di
 * `20261005_1100`, estratto lì per non averne tre copie.
 */
import type { Migration } from '@opengraphity/neo4j'
import { aggiungiInterruttoriMancanti } from './20261005_1100_ai_settings_missing_features.js'

export const aiSettingsConfigurationAssist: Migration = {
  id: '20261006_1050_ai_settings_configuration_assist',
  description: 'Add the configurationAssist switch (off) to tenants that already saved their AI settings',
  up: (session) => aggiungiInterruttoriMancanti(session, '20261006_1050_ai_settings_configuration_assist'),
}
