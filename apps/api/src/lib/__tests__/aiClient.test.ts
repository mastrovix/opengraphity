/**
 * UN SOLO POSTO DA CUI SI PARLA AL MODELLO (revisione AI, ondata 8).
 *
 * Sei servizi avevano ognuno il proprio `new Anthropic()` e la propria copia
 * della lettura della risposta, e le copie si erano già allontanate: il
 * troncamento (`stop_reason === 'max_tokens'`) era gestito nei due
 * progettisti e non in triage né in post-incident, dove una risposta tagliata
 * a metà veniva annunciata come «non leggibile».
 *
 * Il guardiano tiene la regola: il client si chiede a `getAnthropic()`. Chi
 * scrive la settima funzione AI se ne accorge qui, non dalla differenza fra
 * due messaggi d'errore sei mesi dopo.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { leggiJSONDalModello, leggiTestoDalModello, registraRisposta } from '../aiClient.js'
import { renderMetrics } from '../../middleware/metrics.js'
import type Anthropic from '@anthropic-ai/sdk'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sorgenti(p, out); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function risposta(over: Partial<Anthropic.Message> & { text?: string }): Anthropic.Message {
  const { text, ...resto } = over
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'test',
    content: text === undefined ? [] : [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...resto,
  } as Anthropic.Message
}

const CHIAVI = { troncata: 'errors.ai.truncated', illeggibile: 'errors.ai.badAnswer' }

describe('aiClient — un solo posto da cui si parla al modello', () => {
  it('nessun servizio costruisce il proprio client', () => {
    const colpevoli = sorgenti(SRC)
      .filter((p) => p !== path.join(SRC, 'lib', 'aiClient.ts'))
      .filter((p) => /new Anthropic\(/.test(fs.readFileSync(p, 'utf8')))
      .map((p) => path.relative(SRC, p))
    expect(colpevoli).toEqual([])
  })

  it('le metriche AI sono ESPOSTE: una famiglia dichiarata e non aggiunta a renderMetrics non esiste', () => {
    // La trappola di questo registro: si dichiara il contatore, lo si
    // incrementa, e poi non lo si mette nell'elenco che `/metrics` stampa —
    // la metrica «c'è» nel codice e non arriva a Prometheus.
    const esposizione = renderMetrics()
    for (const nome of ['ai_calls_total', 'ai_tokens_total', 'ai_discards_total', 'ai_call_duration_seconds']) {
      expect(esposizione).toContain(`# TYPE ${nome}`)
    }
  })

  it('una chiamata contata compare nell’esposizione con la sua funzione e il suo esito', () => {
    registraRisposta('formDesigner', 'ok', { usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } })
    const esposizione = renderMetrics()
    expect(esposizione).toMatch(/ai_calls_total\{feature="formDesigner",outcome="ok"\} \d+/)
    // `cache_read` è il numero che dice se il punto di cache lavora davvero.
    expect(esposizione).toMatch(/ai_tokens_total\{feature="formDesigner",kind="cache_read"\} 900/)
  })

  it('una risposta troncata si chiama troncata, non «illeggibile»', () => {
    // Il difetto che stava in triage e in post-incident: `max_tokens` finiva
    // in `JSON.parse`, che falliva, e l'utente leggeva la diagnosi sbagliata.
    const tagliata = risposta({ stop_reason: 'max_tokens', text: '{"a": 1' })
    expect(() => leggiJSONDalModello(tagliata, 'triage', CHIAVI))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ai.truncated' } }) }))
    expect(() => leggiTestoDalModello(tagliata, 'postIncident', CHIAVI))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ai.truncated' } }) }))
  })

  it('una risposta rifiutata dal modello lo dice, e non prova a leggerla', () => {
    const rifiuto = risposta({ stop_reason: 'refusal' })
    expect(() => leggiJSONDalModello(rifiuto, 'triage', CHIAVI))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ai.modelRefused' } }) }))
  })

  it('un JSON valido torna com’è, e un JSON rotto alza la chiave di quel servizio', () => {
    expect(leggiJSONDalModello(risposta({ text: '{"a":1}' }), 'triage', CHIAVI)).toEqual({ a: 1 })
    expect(() => leggiJSONDalModello(risposta({ text: 'non json' }), 'triage', CHIAVI))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ai.badAnswer' } }) }))
  })

  it('un testo vuoto non si consegna come bozza', () => {
    expect(() => leggiTestoDalModello(risposta({ text: '   ' }), 'postIncident', CHIAVI))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ai.badAnswer' } }) }))
    expect(leggiTestoDalModello(risposta({ text: '  nota  ' }), 'postIncident', CHIAVI)).toBe('nota')
  })
})
