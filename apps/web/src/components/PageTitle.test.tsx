/**
 * La misura e il colore dell'icona del titolo li decide PageTitle, non chi lo usa.
 * Una pagina che passa un'altra misura o nessun colore ottiene comunque 22 e
 * l'accento: e cosi che l'SLA Report aveva un'icona nera e piu piccola.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Gauge } from 'lucide-react'
import { PageTitle } from './PageTitle'

describe('PageTitle — l\'icona ha sempre la misura e il colore del titolo', () => {
  it.each([
    ['senza misura ne colore', <Gauge key="a" />],
    ['con la misura sbagliata e senza colore', <Gauge key="b" size={20} />],
    ['con un altro colore', <Gauge key="c" size={20} color="var(--color-brand)" />],
  ])('%s → 22 e --color-icon-accent', (_, icona) => {
    const { container } = render(<PageTitle icon={icona}>SLA Report</PageTitle>)
    const svg = container.querySelector('h1 svg')!
    expect(svg.getAttribute('width')).toBe('22')
    expect(svg.getAttribute('height')).toBe('22')
    expect(svg.getAttribute('stroke')).toBe('var(--color-icon-accent)')
  })
})
