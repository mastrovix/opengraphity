/**
 * La sezione dei conflitti di rilascio.
 *
 * Due cose si pinnano, e sono quelle per cui la sezione esiste:
 *
 *  - «nessun conflitto» SI VEDE. Una sezione che appare solo quando c'è un
 *    problema lascia il dubbio fra «non ci sono conflitti» e «nessuno ha
 *    guardato», e davanti a un'approvazione quel dubbio si risolve sempre nel
 *    modo sbagliato;
 *  - quando c'è un conflitto si vedono TUTTE E TRE le finestre: la mia, la sua
 *    e la parte in comune. Senza le prime due non si sa cosa spostare; senza
 *    la terza si deve calcolare a mente davanti a una decisione.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { DeployConflictsSection } from './DeployConflictsSection'
import type { ChangeDeployConflict } from '@/types/change'

const conflitto = (over: Partial<ChangeDeployConflict> = {}): ChangeDeployConflict => ({
  changeId: 'chg-2', code: 'CHG00000002', title: 'Aggiornamento kernel', currentStep: 'scheduled',
  ciId: 'ci-1', ciName: 'srv-web-01',
  mine:    { start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' },
  theirs:  { start: '2026-10-01T22:00:00.000Z', end: '2026-10-02T02:00:00.000Z' },
  overlap: { start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' },
  ...over,
})

describe('DeployConflictsSection', () => {
  it('senza conflitti lo DICE, invece di non comparire', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[]} />)
    expect(screen.getByText(/Release conflicts/)).toBeInTheDocument()
    expect(screen.getByText(/No release conflict/)).toBeInTheDocument()
  })

  it('mostra codice, titolo, CI e passo dell\'altra change', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto()]} />)
    expect(screen.getByText('CHG00000002')).toBeInTheDocument()
    expect(screen.getByText(/Aggiornamento kernel/)).toBeInTheDocument()
    expect(screen.getByText('srv-web-01')).toBeInTheDocument()
    expect(screen.getByText(/scheduled/)).toBeInTheDocument()
  })

  it('il codice è un link alla change che confligge: si va a guardarla', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto()]} />)
    expect(screen.getByRole('link', { name: 'CHG00000002' })).toHaveAttribute('href', '/changes/chg-2')
  })

  it('porta le tre finestre, con le etichette di chi è chi', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto()]} />)
    for (const etichetta of ['This change', 'The other change', 'Overlap']) {
      expect(screen.getByText(etichetta), etichetta).toBeInTheDocument()
    }
  })

  it('raggruppa per CI: il CI è la cosa che le due change si dividono', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[
      conflitto({ ciId: 'ci-2', ciName: 'srv-db-09', changeId: 'chg-7', code: 'CHG00000007' }),
      conflitto({ ciId: 'ci-1', ciName: 'srv-web-01' }),
      conflitto({ ciId: 'ci-1', ciName: 'srv-web-01', changeId: 'chg-8', code: 'CHG00000008' }),
    ]} />)
    // Un titolo per CI, non uno per riga.
    expect(screen.getAllByText('srv-web-01')).toHaveLength(1)
    expect(screen.getAllByText('srv-db-09')).toHaveLength(1)
    expect(screen.getByText('CHG00000007')).toBeInTheDocument()
    expect(screen.getByText('CHG00000008')).toBeInTheDocument()
  })

  it('il conteggio nell\'intestazione dice quanti sono', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto(), conflitto({ changeId: 'chg-3', code: 'CHG00000003' })]} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('una change senza passo non mostra un separatore vuoto', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto({ currentStep: null })]} />)
    expect(screen.getByText(/Aggiornamento kernel/).textContent).not.toMatch(/·\s*$/)
  })
})
