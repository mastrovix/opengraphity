/**
 * Secondo giro UI del 15 set 2026 · V-7: in italiano la barra delle fasi della
 * change diceva «Approval, Scheduled, Closed» anche se i passi hanno la
 * traduzione: la pagina le passava `.label`, non l'etichetta nella lingua attiva.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { screen } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { withLocalizedLabel } from '@/lib/localizedLabel'
import { PhaseChipBar } from './PhaseChipBar'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('PhaseChipBar nella lingua di chi guarda', () => {
  it('con i passi localizzati mostra «Approvazione»; la pagina della change li localizza', async () => {
    await i18n.changeLanguage('it')
    const steps = [
      { name: 'approval', label: 'Approval', labels: [{ language: 'it', label: 'Approvazione' }], isTerminal: false },
      { name: 'closed', label: 'Closed', labels: [{ language: 'it', label: 'Chiusa' }], isTerminal: true },
    ]
    renderWithProviders(<PhaseChipBar current="approval" steps={steps.map(withLocalizedLabel)} />)
    expect(screen.getByText('Approvazione')).toBeInTheDocument()
    expect(screen.queryByText('Approval')).toBeNull()
    const page = fs.readFileSync(path.resolve(__dirname, '../ChangeDetailPage.tsx'), 'utf8')
    expect(page).toContain('<PhaseChipBar current={currentStep} steps={wfSteps.map(withLocalizedLabel)} />')
    expect(page).not.toContain('stepLabel={wfByName.get(currentStep)?.label')
  })
})
