/**
 * Secondo giro UI del 15 set 2026 · V-20. Un widget con i valori raggruppati per
 * priorità mostrava «Critica» a chi aveva scelto l'inglese: le etichette dei
 * valori seguivano la lingua dell'azienda, non quella di chi guarda. L'API
 * accetta `language`; ogni documento che chiede valori di report o di widget
 * deve passarlo, altrimenti si torna alla lingua dell'azienda senza accorgersene.
 */
import { describe, it, expect } from 'vitest'
import { print } from 'graphql'
import { GET_DASHBOARD, GET_MY_DASHBOARD } from '../queries/dashboard'
import { EXECUTE_REPORT, PREVIEW_REPORT_SECTION } from '../queries/reports'
import { ADD_DASHBOARD_WIDGET, SAVE_DASHBOARD_LAYOUT } from '../mutations/dashboard'

describe('i valori di report e widget arrivano nella lingua di chi guarda', () => {
  it.each([
    ['GET_DASHBOARD', GET_DASHBOARD],
    ['GET_MY_DASHBOARD', GET_MY_DASHBOARD],
    ['ADD_DASHBOARD_WIDGET', ADD_DASHBOARD_WIDGET],
    ['SAVE_DASHBOARD_LAYOUT', SAVE_DASHBOARD_LAYOUT],
  ])('%s chiede data ed error con la lingua', (_name, doc) => {
    const src = print(doc)
    expect(src).toContain('$language: String')
    expect(src).toContain('data(language: $language)')
    expect(src).toContain('error(language: $language)')
  })

  it.each([
    ['EXECUTE_REPORT', EXECUTE_REPORT, 'executeReport('],
    ['PREVIEW_REPORT_SECTION', PREVIEW_REPORT_SECTION, 'previewReportSection('],
  ])('%s passa la lingua', (_name, doc, field) => {
    const src = print(doc)
    expect(src).toMatch(new RegExp(`${field.replace('(', '\\(')}[^)]*language: \\$language`))
  })
})
