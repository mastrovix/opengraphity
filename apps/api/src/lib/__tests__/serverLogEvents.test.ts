/**
 * LE REGOLE DEL CONNETTORE (20 set 2026, ondata 3).
 *
 * Il connettore decide UNA cosa: se una classe di errori merita un evento, e
 * di che gravità. Tutto il resto — deduplica, CI, incident, chiusura — lo fa
 * la pipeline degli eventi, che ha già i suoi test. Qui si prova la
 * decisione, perché è l'unica cosa nuova e perché sbagliarla vuol dire o non
 * accorgersi di un guasto o aprire incident per rumore.
 */
import { describe, it, expect } from 'vitest'
import {
  verdettoPerFirma, eventoPerFirma, SOGLIE, AGGREGATI_CYPHER,
  TENANT_DI_PIATTAFORMA, SORGENTE_DEI_LOG, type FirmaAggregata,
} from '../serverLogEvents.js'

const ADESSO = Date.parse('2026-09-20T12:00:00.000Z')
const firma = (extra: Partial<FirmaAggregata> = {}): FirmaAggregata => ({
  fingerprint: 'f1', service: 'opengrafo-api', module: 'graphql', level: 'error',
  template: 'Variable <str> not defined', stackHead: 'at f (/app/a.js:<n>:<n>)',
  occorrenzeOggi: 0, occorrenzeTotali: 0, giorniDistinti: 0,
  ultimoGiorno: '2026-09-20', ultimoIstante: '2026-09-20T11:00:00.000Z',
  ...extra,
})

describe('acuto: un guasto in corso non aspetta tre giorni', () => {
  it('molte occorrenze oggi bastano, anche al primo giorno', () => {
    const v = verdettoPerFirma(firma({ occorrenzeOggi: SOGLIE.acutoOccorrenze, giorniDistinti: 1, occorrenzeTotali: 20 }), ADESSO)
    expect(v).toEqual({ stato: 'firing', severita: 'critical', motivo: 'acuto' })
  })

  it('una sotto soglia non apre niente', () => {
    expect(verdettoPerFirma(firma({ occorrenzeOggi: SOGLIE.acutoOccorrenze - 1, giorniDistinti: 1, occorrenzeTotali: 19 }), ADESSO)).toBeNull()
  })

  it('l\'acuto vince sul cronico: la cosa più urgente prima', () => {
    const v = verdettoPerFirma(firma({ occorrenzeOggi: 100, giorniDistinti: 7, occorrenzeTotali: 400 }), ADESSO)
    expect(v).toMatchObject({ motivo: 'acuto', severita: 'critical' })
  })
})

describe('cronico: un difetto che dura', () => {
  it('abbastanza giorni distinti E abbastanza occorrenze', () => {
    const v = verdettoPerFirma(firma({
      occorrenzeOggi: 2, giorniDistinti: SOGLIE.cronicoGiorni, occorrenzeTotali: SOGLIE.cronicoOccorrenze,
    }), ADESSO)
    expect(v).toEqual({ stato: 'firing', severita: 'warning', motivo: 'cronico' })
  })

  it('tre giorni con una riga l\'uno NON sono un guasto', () => {
    // La soglia sulle occorrenze esiste per questo: senza, ogni errore
    // sporadico che ricompare diventerebbe un incident.
    expect(verdettoPerFirma(firma({ occorrenzeOggi: 1, giorniDistinti: 3, occorrenzeTotali: 3 }), ADESSO)).toBeNull()
  })

  it('molte occorrenze in UN giorno solo, sotto la soglia acuta, non sono croniche', () => {
    expect(verdettoPerFirma(firma({ occorrenzeOggi: 15, giorniDistinti: 1, occorrenzeTotali: 15 }), ADESSO)).toBeNull()
  })
})

describe('la quiete', () => {
  it('una firma che non si vede più rientra', () => {
    const vecchio = new Date(ADESSO - (SOGLIE.oreDiQuiete + 1) * 3_600_000).toISOString()
    const v = verdettoPerFirma(firma({ giorniDistinti: 5, occorrenzeTotali: 200, ultimoIstante: vecchio }), ADESSO)
    expect(v).toEqual({ stato: 'resolved' })
  })

  it('ma un guasto ancora in corso NON rientra per il tempo passato', () => {
    // Se la quiete si valutasse prima dell'acuto, un guasto cominciato ieri
    // sera e ancora vivo verrebbe dichiarato rientrato.
    const vecchio = new Date(ADESSO - (SOGLIE.oreDiQuiete + 1) * 3_600_000).toISOString()
    const v = verdettoPerFirma(firma({ occorrenzeOggi: 50, ultimoIstante: vecchio }), ADESSO)
    expect(v).toMatchObject({ stato: 'firing' })
  })

  it('senza ultimo istante è rientrata, non «per sempre accesa»', () => {
    expect(verdettoPerFirma(firma({ giorniDistinti: 5, occorrenzeTotali: 99, ultimoIstante: null }), ADESSO))
      .toEqual({ stato: 'resolved' })
  })
})

describe('l\'evento che esce', () => {
  it('l\'identità è la FIRMA: lo stesso errore domani ritrova il suo evento', () => {
    const ev = eventoPerFirma(firma({ fingerprint: 'abc' }), { stato: 'firing', severita: 'warning', motivo: 'cronico' })
    expect(ev.externalId).toBe('abc')
  })

  it('la risorsa è il nome del PROCESSO, che è come si chiama il CI censito', () => {
    const ev = eventoPerFirma(firma({ service: 'opengrafo-events-worker' }), { stato: 'firing', severita: 'critical', motivo: 'acuto' })
    expect(ev.resource).toBe('opengrafo-events-worker')
    expect(ev.resourceKind).toBe('name')
  })

  it('il titolo porta il template, e dice chi e dove', () => {
    const ev = eventoPerFirma(firma(), { stato: 'firing', severita: 'critical', motivo: 'acuto' })
    expect(ev.title).toBe('opengrafo-api · graphql: Variable <str> not defined')
  })

  it('la descrizione dichiara PERCHÉ è stato aperto, con i numeri e la soglia', () => {
    const ev = eventoPerFirma(
      firma({ occorrenzeOggi: 40, occorrenzeTotali: 40 }),
      { stato: 'firing', severita: 'critical', motivo: 'acuto' },
    )
    // In inglese: è un testo composto dall'API e finisce nel corpo di un
    // ticket (guardiani `noItalianInApiTexts` e `userFacingItalian`).
    expect(ev.description).toContain('40 occurrences today')
    expect(ev.description).toContain(`threshold ${String(SOGLIE.acutoOccorrenze)}`)
    // E dice a chi legge che sta guardando un template, non il messaggio vero.
    expect(ev.description).toContain('TEMPLATE')
  })

  it('il rientro è `resolved` con severità `info`: chiude, non allarma', () => {
    const ev = eventoPerFirma(firma(), { stato: 'resolved' })
    expect(ev.status).toBe('resolved')
    expect(ev.severity).toBe('info')
    expect(ev.description).toBeUndefined()
  })

  it('nessun campo dell\'evento porta dati fuori dall\'allowlist', () => {
    const ev = eventoPerFirma(firma(), { stato: 'firing', severita: 'warning', motivo: 'cronico' })
    const tutto = JSON.stringify(ev)
    // Niente tenant, niente messaggio grezzo, niente `data`.
    expect(tutto).not.toContain('tenant')
    expect(Object.keys(ev.labels).sort()).toEqual(['fingerprint', 'level', 'module', 'motivo', 'source'])
  })
})

describe('gli aggregati', () => {
  it('contano i GIORNI DISTINTI, che è la domanda del progetto', () => {
    expect(AGGREGATI_CYPHER).toContain('count(DISTINCT l.day)')
  })

  it('e le occorrenze del giorno corrente a parte, per l\'acuto', () => {
    expect(AGGREGATI_CYPHER).toContain('CASE WHEN l.day = $oggi')
  })

  it('la finestra è un filtro sull\'indice, non una scansione', () => {
    expect(AGGREGATI_CYPHER).toContain('WHERE l.day >= $dalGiorno')
  })
})

describe('dove finiscono', () => {
  it('nel tenant di piattaforma, sulla sorgente creata dalla migrazione', () => {
    expect(TENANT_DI_PIATTAFORMA).toBe('opengrafo')
    expect(SORGENTE_DEI_LOG).toBe('opengrafo-platform-logs')
  })
})
