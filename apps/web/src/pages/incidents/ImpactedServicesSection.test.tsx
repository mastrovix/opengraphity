/**
 * Sezione «Servizi impattati» del dettaglio incident (ondata 3): nome (link al
 * servizio), salute, punteggio; e la regola che conta di più — con zero
 * servizi la sezione NON compare.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { ImpactedServicesSection } from './ImpactedServicesSection'
import { renderWithProviders } from '@/test/utils'
import type { ImpactedServiceRef } from '@/types/services'

const SERVICES: ImpactedServiceRef[] = [
  { id: 'map-1', name: 'Enterprise Billing', health: 'degraded', impactScore: 41 },
  { id: 'map-2', name: 'Payroll', health: 'down', impactScore: 100 },
]

describe('ImpactedServicesSection', () => {
  it('elenca i servizi con salute e punteggio, ognuno un link al dettaglio', () => {
    renderWithProviders(<ImpactedServicesSection services={SERVICES} />)
    expect(screen.getByText('Impacted services')).toBeInTheDocument()
    const rows = screen.getAllByTestId('impacted-service-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
    expect(screen.getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/monitoring/services/map-2')
    expect(screen.getByText('Degraded')).toBeInTheDocument()
    expect(screen.getByText('Down')).toBeInTheDocument()
    expect(screen.getByLabelText('Impact score 41 out of 100')).toBeInTheDocument()
    expect(screen.getByLabelText('Impact score 100 out of 100')).toBeInTheDocument()
  })

  it('nessun servizio: la sezione è nascosta del tutto (niente riquadro vuoto)', () => {
    const { container } = renderWithProviders(<ImpactedServicesSection services={[]} />)
    expect(screen.queryByText('Impacted services')).not.toBeInTheDocument()
    expect(container.querySelector('[data-testid="impacted-service-row"]')).toBeNull()
  })

  it('salute fuori vocabolario: detta in chiaro, mai una riga senza badge', () => {
    renderWithProviders(<ImpactedServicesSection services={[{ ...SERVICES[0]!, health: 'weird' as ImpactedServiceRef['health'] }]} />)
    expect(screen.getByText('Unknown (weird)')).toBeInTheDocument()
  })
})
