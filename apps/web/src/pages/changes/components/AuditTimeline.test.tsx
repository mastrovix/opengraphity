/**
 * Revisione del 14 set 2026 · CH-5: i dettagli dell'audit della change erano
 * frasi italiane salvate così («CI x aggiunto»). Ora portano chiave e dati, e
 * la timeline compone la frase nella lingua di chi guarda; le voci vecchie
 * senza chiave si mostrano come sono.
 */
import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n/i18n'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { AuditTimeline } from './AuditTimeline'

describe('AuditTimeline — dettaglio nella lingua di chi guarda', () => {
  afterEach(async () => { await i18n.changeLanguage('en') })

  it('con detailKey la frase si compone; senza, si mostra il testo salvato', async () => {
    await i18n.changeLanguage('it')
    const { user } = renderWithProviders(<AuditTimeline audit={[
      { timestamp: '2026-09-14T10:00:00Z', action: 'ci_added', detail: 'CI db-01 added', detailKey: 'ciAdded', detailParams: '{"ci":"db-01"}', actor: null },
      { timestamp: '2026-09-13T10:00:00Z', action: 'ci_removed', detail: 'CI vecchio rimosso', detailKey: null, detailParams: null, actor: null },
    ]} />)
    await user.click(screen.getByRole('button', { name: /Registro delle modifiche/ }))
    expect(screen.getByText('CI db-01 aggiunto')).toBeInTheDocument()
    expect(screen.getByText('CI vecchio rimosso')).toBeInTheDocument()
  })
})
