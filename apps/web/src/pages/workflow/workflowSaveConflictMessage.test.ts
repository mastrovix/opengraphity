/**
 * Secondo giro UI del 15 set 2026 · V-4: sul conflitto di versione il
 * disegnatore mostrava due toast con lo stesso contenuto (il suo e quello del
 * link di Apollo con la frase dell'API). Resta un avviso solo: quello dell'API,
 * che dice le versioni e che le modifiche non sono state applicate.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import en from '@/i18n/locales/en.json'
import it_ from '@/i18n/locales/it.json'

describe('conflitto di versione del workflow: un avviso solo', () => {
  it('il disegnatore non aggiunge un suo toast; la frase dell\'API dice che le modifiche non sono state applicate', () => {
    const page = fs.readFileSync(path.resolve(__dirname, 'WorkflowDesignerPage.tsx'), 'utf8')
    expect(page).not.toContain('saveConflict')
    expect(JSON.stringify(en)).not.toContain('"saveConflict"')
    expect((en as { errors: { workflow: { concurrentEdit: string } } }).errors.workflow.concurrentEdit).toContain('your changes were not applied')
    expect((it_ as { errors: { workflow: { concurrentEdit: string } } }).errors.workflow.concurrentEdit).toContain('le tue modifiche non sono state applicate')
  })
})
