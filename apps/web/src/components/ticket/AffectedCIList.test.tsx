/**
 * AffectedCIList — ondata 7 · D-15.
 *
 * Qui c'era una QUARTA copia della palette degli stati CI, con TRE valori
 * (`active`, `maintenance`, `decommissioned`) e accesso diretto
 * `STATUS_BG[ci.status]`: uno stato che il cliente aggiunge — o i 68 CI
 * `expired`/`revoked` dal vivo — usciva `undefined` e la pastiglia restava sul
 * neutro del MicroBadge, senza che nessuno lo dicesse. Adesso è la palette
 * unica di `lib/ciEnums`, col vocabolario del cliente: valore suo senza colore
 * = neutro, valore fuori vocabolario = rosso e detto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { AffectedCIList, type AffectedCIRef } from './AffectedCIList'
import { CI_STATUS_STYLE } from '@/lib/ciEnums'
import { NEUTRAL_VALUE_STYLE } from '@/lib/domainStyle'
import { renderWithProviders } from '@/test/utils'
import { baseCITypeMock } from '@/test/mocks/gql'

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

/**
 * Solo gli errori della palette: il mock condiviso del tipo base non porta
 * `scope`/`tenantId` e Apollo lo segnala in console — rumore di fondo che non
 * riguarda questo test.
 */
const paletteErrors = (): string[] =>
  (consoleError.mock.calls as unknown[][]).map((c) => String(c[0])).filter((m: string) => m.startsWith('[CI_STATUS_STYLE]'))

const ci = (over: Partial<AffectedCIRef>): AffectedCIRef =>
  ({ id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production', ...over })

/** L'elenco vive dentro un `CollapsibleGroup` per tipo, chiuso di default: si apre. */
async function render(cis: AffectedCIRef[], statuses?: string[]) {
  const r = renderWithProviders(
    <AffectedCIList
      affectedCIs={cis}
      rules={[]}
      ciResults={[]}
      onSearchChange={vi.fn()}
      onAddCI={vi.fn()}
      onRemoveCI={vi.fn()}
      defaultOpen
    />,
    { mocks: [baseCITypeMock(statuses)] },
  )
  await r.user.click(await screen.findByRole('button', { name: /server/i }))
  return r
}

describe('AffectedCIList — pastiglia dello stato del CI', () => {
  it('stato con un colore assegnato → quel colore, ed etichetta leggibile', async () => {
    await render([ci({ status: 'maintenance' })])
    const pill = await screen.findByText('Maintenance')
    expect(pill).toHaveStyle({ backgroundColor: CI_STATUS_STYLE['maintenance']!.bg, color: CI_STATUS_STYLE['maintenance']!.color })
    expect(paletteErrors()).toEqual([])
  })

  it('stato NEL vocabolario del cliente senza colore (expired) → neutro e silenzioso, non una pastiglia senza sfondo', async () => {
    await render([ci({ status: 'expired' })], ['active', 'expired', 'revoked'])
    const pill = await screen.findByText('Expired')
    expect(pill).toHaveStyle({ backgroundColor: NEUTRAL_VALUE_STYLE.bg, color: NEUTRAL_VALUE_STYLE.color })
    expect(paletteErrors()).toEqual([])
  })

  it('stato FUORI dal vocabolario del cliente → rosso e console.error (è un record da sistemare)', async () => {
    await render([ci({ status: 'zombie' })], ['active', 'inactive'])
    const pill = await screen.findByText('Zombie')
    expect(pill).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(paletteErrors()).toContain('[CI_STATUS_STYLE] "zombie" non è nel vocabolario di questo cliente (active, inactive)')
  })
})
