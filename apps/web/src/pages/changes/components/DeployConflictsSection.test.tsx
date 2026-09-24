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
 *
 * The section starts closed (owner's choice, 24 Sep 2026): the header speaks
 * for it — the count, red with conflicts, a warning with unreadable plans.
 */
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { DeployConflictsSection } from './DeployConflictsSection'
import type { ChangeDeployConflict } from '@/types/change'
import en from '@/i18n/locales/en.json'
import itJson from '@/i18n/locales/it.json'

const conflitto = (over: Partial<ChangeDeployConflict> = {}): ChangeDeployConflict => ({
  changeId: 'chg-2', code: 'CHG00000002', title: 'Aggiornamento kernel', currentStep: 'scheduled',
  ciId: 'ci-1', ciName: 'srv-web-01',
  mine:    { start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' },
  theirs:  { start: '2026-10-01T22:00:00.000Z', end: '2026-10-02T02:00:00.000Z' },
  overlap: { start: '2026-10-01T23:00:00.000Z', end: '2026-10-02T01:00:00.000Z' },
  ...over,
})

/** Renders the section and opens it: it starts closed. */
function aperta(props: Parameters<typeof DeployConflictsSection>[0]) {
  const r = renderWithProviders(<DeployConflictsSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /Change deploy conflicts/ }))
  return r
}

describe('DeployConflictsSection', () => {
  it('starts closed, and the header still answers: the count and, with conflicts, red — even closed', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto(), conflitto({ changeId: 'chg-3', code: 'CHG00000003' })]} />)
    const toggle = screen.getByRole('button', { name: /Change deploy conflicts/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('CHG00000002')).toBeNull()
    expect(toggle).toHaveTextContent('2')
    const titolo = screen.getByText(/Change deploy conflicts/)
    expect(titolo).toHaveStyle({ color: 'var(--color-white)' })
    expect(toggle.parentElement).toHaveStyle({ background: 'var(--color-danger)' })
  })

  it('closed with no conflict: the count says 0 and the header is not an alarm', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[]} />)
    const toggle = screen.getByRole('button', { name: /Change deploy conflicts/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('0')
    expect(toggle.parentElement).not.toHaveStyle({ background: 'var(--color-danger)' })
  })

  it('closed with an unreadable plan and no conflict: the header warns, a 0 cannot pass for «no conflict»', () => {
    renderWithProviders(<DeployConflictsSection conflitti={[]} illeggibili={['TASK00000009']} />)
    const toggle = screen.getByRole('button', { name: /Change deploy conflicts/ })
    expect(toggle.parentElement).toHaveStyle({ background: 'var(--color-warning-bg)' })
    expect(screen.getByText(/Change deploy conflicts/)).toHaveStyle({ color: 'var(--color-warning-text)' })
  })

  it('open, an unreadable plan is named above the answer', () => {
    aperta({ conflitti: [], illeggibili: ['TASK00000009'] })
    expect(screen.getByText(/TASK00000009/)).toBeInTheDocument()
  })

  it('senza conflitti lo DICE, invece di non comparire', () => {
    aperta({ conflitti: [] })
    expect(screen.getByText(/Change deploy conflicts/)).toBeInTheDocument()
    // D23: the empty state speaks of deploy, like the title — not of «release».
    expect(screen.getByText('No deploy conflict: no other change deploys on these CIs in an overlapping window.')).toBeInTheDocument()
    expect(screen.queryByText(/release/i)).not.toBeInTheDocument()
  })

  it('con un conflitto la testata è rossa e il titolo è BIANCO', () => {
    /*
     * Il rosso pieno con sopra il turchese di serie non si legge: il
     * proprietario l'ha visto a schermo. Qui si pinna la coppia — fondo
     * d'allarme e testo bianco — perché è una regola di leggibilità, non
     * una preferenza.
     */
    renderWithProviders(<DeployConflictsSection conflitti={[conflitto()]} />)
    const titolo = screen.getByText(/Change deploy conflicts/)
    expect(titolo).toHaveStyle({ color: 'var(--color-white)' })
    const testata = titolo.closest('div')!
    expect(testata).toHaveStyle({ background: 'var(--color-danger)' })
  })

  it('mostra codice, titolo, CI e passo dell\'altra change', () => {
    aperta({ conflitti: [conflitto()] })
    expect(screen.getByText('CHG00000002')).toBeInTheDocument()
    expect(screen.getByText(/Aggiornamento kernel/)).toBeInTheDocument()
    expect(screen.getByText('srv-web-01')).toBeInTheDocument()
    expect(screen.getByText(/scheduled/)).toBeInTheDocument()
  })

  it('il codice è un link alla change che confligge: si va a guardarla', () => {
    aperta({ conflitti: [conflitto()] })
    expect(screen.getByRole('link', { name: 'CHG00000002' })).toHaveAttribute('href', '/changes/chg-2')
  })

  it('porta le tre finestre, con le etichette di chi è chi', () => {
    aperta({ conflitti: [conflitto()] })
    for (const etichetta of ['This change', 'The other change', 'Overlap']) {
      expect(screen.getByText(etichetta), etichetta).toBeInTheDocument()
    }
  })

  it('raggruppa per CI: il CI è la cosa che le due change si dividono', () => {
    aperta({ conflitti: [
      conflitto({ ciId: 'ci-2', ciName: 'srv-db-09', changeId: 'chg-7', code: 'CHG00000007' }),
      conflitto({ ciId: 'ci-1', ciName: 'srv-web-01' }),
      conflitto({ ciId: 'ci-1', ciName: 'srv-web-01', changeId: 'chg-8', code: 'CHG00000008' }),
    ] })
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
    aperta({ conflitti: [conflitto({ currentStep: null })] })
    expect(screen.getByText(/Aggiornamento kernel/).textContent).not.toMatch(/·\s*$/)
  })

  it('D23: in both languages the section speaks of deploy, as its title does, not of release', () => {
    for (const texts of [en.pages.changeDetail.deployConflicts, itJson.pages.changeDetail.deployConflicts]) {
      for (const key of ['title', 'none', 'lede', 'unreadable_one', 'unreadable_other'] as const) {
        expect(texts[key], key).toMatch(/deploy/i)
        expect(texts[key], key).not.toMatch(/release|rilasci/i)
      }
    }
  })
})
