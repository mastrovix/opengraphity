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
import { palette } from '@/lib/tokens'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
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
  (consoleError.mock.calls as unknown[][]).map((c) => String(c[0])).filter((m: string) => m.startsWith('[ci_status]'))

const ci = (over: Partial<AffectedCIRef>): AffectedCIRef =>
  ({ id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production', ...over })

/** L'elenco vive dentro un `CollapsibleGroup` per tipo, chiuso di default: si apre. */
async function render(cis: AffectedCIRef[], statuses?: string[]) {
  // I colori del Dizionario (F9): `maintenance` giallo-avviso, come il seme del prodotto.
  const vocab = {
    // Giro UI · U-26: l'etichetta è quella del Dizionario (prima un title-case del valore).
    valuesOf: () => null, vocabularyLabelOf: () => null, entriesOf: () => null, loading: false, error: null,
    labelOf: (name: string, value: string) => (name === 'ci_status' ? ({ maintenance: 'Maintenance', expired: 'Expired' } as Record<string, string>)[value] ?? null : null),
    colorOf: (name: string, value: string) => (name === 'ci_status' && value === 'maintenance' ? 'warning' as const : null),
  }
  const r = renderWithProviders(
    <DomainVocabularyContext.Provider value={vocab}>
    <AffectedCIList
      affectedCIs={cis}
      excludedTypes={[]}
      ciResults={[]}
      onSearchChange={vi.fn()}
      onAddCI={vi.fn()}
      onRemoveCI={vi.fn()}
      defaultOpen
    />
    </DomainVocabularyContext.Provider>,
    { mocks: [baseCITypeMock(statuses)] },
  )
  await r.user.click(await screen.findByRole('button', { name: /server/i }))
  return r
}

describe('AffectedCIList — pastiglia dello stato del CI', () => {
  it('stato con un colore assegnato → quel colore, ed etichetta leggibile', async () => {
    await render([ci({ status: 'maintenance' })])
    const pill = await screen.findByText('Maintenance')
    expect(pill).toHaveStyle({ backgroundColor: palette.warning.tint, color: palette.warning.text })
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
    // un valore fuori vocabolario non ha etichetta: si legge com'è
    const pill = await screen.findByText('zombie')
    expect(pill).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(paletteErrors()).toContain('[ci_status] "zombie" is not in the vocabulary of this tenant (active, inactive)')
  })
})

// ── Revisione del 15 set 2026 · CM-8 ──────────────────────────────────────────
describe('AffectedCIList — i tipi di CI esclusi non si propongono', () => {
  it('nella ricerca manca il certificato, escluso per questo tipo di ticket; il server resta', async () => {
    const onAddCI = vi.fn()
    const { user } = renderWithProviders(
      <AffectedCIList
        affectedCIs={[]}
        excludedTypes={['certificate']}
        ciResults={[ci({ id: 'srv-1', name: 'SRV-01', type: 'server' }), ci({ id: 'cert-1', name: 'cert-portale', type: 'certificate' })]}
        onSearchChange={vi.fn()}
        onAddCI={onAddCI}
        onRemoveCI={vi.fn()}
        defaultOpen
      />,
      { mocks: [baseCITypeMock()] },
    )
    await user.click(screen.getByRole('button', { name: /Add CI/i }))
    // Il tipo si legge con la sua etichetta, non col nome interno (20 set 2026).
    expect(screen.getByPlaceholderText(/Certificate/)).toBeInTheDocument()
    expect(screen.getByText('SRV-01')).toBeInTheDocument()
    expect(screen.queryByText('cert-portale')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+' }))
    expect(onAddCI).toHaveBeenCalledWith('srv-1')
  })
})

