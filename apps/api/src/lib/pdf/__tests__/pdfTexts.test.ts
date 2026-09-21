/**
 * Revisione del 14 set 2026 · lingua: i dossier PDF erano stampati in italiano
 * per ogni cliente. Il catalogo ha le due lingue per ogni testo, e la lingua è
 * quella del cliente (`PdfMeta.locale`).
 */
import { describe, it, expect } from 'vitest'
import { PDF_TEXTS, pdfText } from '../texts.js'

describe('testi dei PDF', () => {
  it('ogni testo esiste in inglese e in italiano, con gli stessi segnaposto', () => {
    for (const [key, t] of Object.entries(PDF_TEXTS)) {
      expect(t.en, key).toBeTruthy()
      expect(t.it, key).toBeTruthy()
      const ph = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(ph(t.it), key).toEqual(ph(t.en))
    }
  })

  it('la lingua del dossier sceglie il testo e riempie i segnaposto', () => {
    expect(pdfText({ language: 'en', timeZone: 'UTC' }, 'comments', { count: 3 })).toBe('Comments (3)')
    expect(pdfText({ language: 'it', timeZone: 'UTC' }, 'comments', { count: 3 })).toBe('Commenti (3)')
    expect(pdfText({ language: 'en', timeZone: 'UTC' }, 'footerPage', { page: 1, pages: 2 })).toBe('Page 1/2')
  })
})
