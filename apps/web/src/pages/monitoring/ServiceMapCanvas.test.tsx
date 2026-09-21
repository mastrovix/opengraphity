/**
 * Mappa del servizio: quel che la rende leggibile alla scala vera e da
 * tastiera (revisione 2 · C-9 e C-10).
 *
 * - il contenitore scorre sul nodo che conta (prima causa all'apertura, poi il
 *   selezionato): `scrollIntoView` è stubbato in `test/setup.ts`, qui si spia;
 * - le etichette dei livelli stanno in una colonna ferma a sinistra;
 * - sopra la soglia la mappa si apre sul solo percorso d'impatto, col chip dei
 *   nodi fuori dal percorso che si espande;
 * - ricerca del nodo per nome, «Adatta» (zoom);
 * - `role="group"` con nome, un solo nodo nel giro dei tab, frecce fra i nodi,
 *   descrizione del percorso, legenda come lista, riassunto testuale.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { ServiceMapCanvas } from './ServiceMapCanvas'
import { FOCUS_THRESHOLD, LABEL_W, NODE_H, NODE_W, PAD } from './serviceMapLayout'
import { renderWithProviders } from '@/test/utils'
import { mapDetail, node, NODES, CAUSES } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

const detail = (over: Record<string, unknown> = {}) => mapDetail(over) as unknown as ServiceMapDetail

function renderMap(over: Record<string, unknown> = {}, selectedId: string | null = null) {
  const onSelect = vi.fn()
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  const r = renderWithProviders(<ServiceMapCanvas map={detail(over)} selectedId={selectedId} onSelect={onSelect} />)
  return { ...r, onSelect, scrollIntoView }
}

const nodeOf = (ciId: string) => screen.getAllByTestId('service-map-node').find((n) => n.getAttribute('data-ci-id') === ciId)!

/** Un livello 2 largo: `count` componenti operativi sotto api-03, più db-01 che è la causa. */
const wideMap = (count: number) => ({
  nodes: [
    NODES[0],
    NODES[1],
    ...Array.from({ length: count }, (_, i) => node({ id: `srv-${String(i).padStart(3, '0')}`, name: `srv-${String(i).padStart(3, '0')}` })),
  ],
  nodeCount: count + 2,
  explanation: [CAUSES[0]],
})

describe('ServiceMapCanvas', () => {
  it('C-9: all\'apertura il contenitore scorre sulla prima causa; alla selezione sul nodo scelto', () => {
    const { scrollIntoView, rerender } = renderMap()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' })
    const first = scrollIntoView.mock.instances[0] as HTMLElement
    expect(first.getAttribute('data-ci-id')).toBe('db-01')          // la prima causa, non un angolo vuoto

    scrollIntoView.mockClear()
    rerender(<ServiceMapCanvas map={detail()} selectedId="cert-billing" onSelect={() => {}} />)
    expect((scrollIntoView.mock.instances[0] as HTMLElement).getAttribute('data-ci-id')).toBe('cert-billing')
  })

  it('C-9: senza cause si apre sul servizio', () => {
    const { scrollIntoView } = renderMap({ explanation: [], health: 'operational' })
    expect((scrollIntoView.mock.instances[0] as HTMLElement).getAttribute('data-testid')).toBe('service-map-root')
  })

  it('C-9: le etichette dei livelli stanno in una colonna a parte, fuori dall\'area che scorre', () => {
    renderMap()
    const labels = screen.getAllByTestId('map-level-label')
    expect(labels.map((l) => l.textContent)).toEqual(['Level 0', 'Level 1', 'Level 2'])

    // La colonna NON è dentro l'elemento che scorre: se lo fosse, scorrendo a
    // destra le carte le passerebbero sotto (era il difetto del velo `sticky`).
    const scroller = screen.getByTestId('service-map').parentElement!
    expect(scroller.contains(labels[0]!)).toBe(false)
    const gutter = labels[0]!.parentElement!.parentElement!
    expect(gutter.parentElement).toBe(scroller.parentElement)          // sorelle: colonna + area che scorre
    expect(gutter).toHaveStyle({ width: `${LABEL_W}px`, overflow: 'hidden' })
    expect(labels[0]).toHaveStyle({ left: `${PAD}px`, width: `${LABEL_W - PAD - 12}px`, height: `${NODE_H}px` })
  })

  it('C-9: scorrendo in verticale le etichette seguono le righe; in orizzontale restano ferme', () => {
    renderMap()
    const scroller = screen.getByTestId('service-map').parentElement as HTMLElement
    const labelsLayer = screen.getAllByTestId('map-level-label')[0]!.parentElement as HTMLElement

    scroller.scrollTop = 120
    fireEvent.scroll(scroller)
    expect(labelsLayer.style.transform).toBe('translateY(-120px)')

    // lo scorrimento orizzontale non sposta la colonna: è fuori dall'area che scorre
    scroller.scrollLeft = 400
    fireEvent.scroll(scroller)
    expect(labelsLayer.style.transform).toBe('translateY(-120px)')
  })

  it('la carta del servizio ha lo stesso impaginato delle altre: nome sopra, tipo e salute sotto', () => {
    renderMap()
    const root = screen.getByTestId('service-map-root')
    const other = screen.getAllByTestId('service-map-node')[0]!

    // stessa struttura: due righe, non tre impilate
    expect(root.children).toHaveLength(2)
    expect(other.children).toHaveLength(2)
    // stessa dimensione e stessa spaziatura interna
    expect(root).toHaveStyle({ width: `${NODE_W}px`, height: `${NODE_H}px`, padding: '8px 10px', gap: '3px' })
    expect(other).toHaveStyle({ width: `${NODE_W}px`, height: `${NODE_H}px`, padding: '8px 10px', gap: '3px' })
    // righe che non si comprimono: senza questo il testo si sovrappone
    for (const line of [...root.children, ...other.children]) expect(line).toHaveStyle({ flexShrink: '0', lineHeight: '1.25' })
    // prima riga il nome, seconda riga tipo e salute
    expect(root.children[0]).toHaveTextContent('Enterprise Billing')
    expect(root.children[1]).toHaveTextContent('Service')
    expect(root.children[1]).toHaveTextContent('Degraded')
  })

  it('C-9: zoom «Adatta» e ritorno alla dimensione reale', async () => {
    const { user } = renderMap()
    expect(screen.getByTestId('service-map')).toHaveAttribute('data-scale', '1')
    expect(screen.queryByRole('button', { name: 'Actual size' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fit' }))
    expect(Number(screen.getByTestId('service-map').getAttribute('data-scale'))).toBeLessThan(1)
    await user.click(screen.getByRole('button', { name: 'Actual size' }))
    expect(screen.getByTestId('service-map')).toHaveAttribute('data-scale', '1')
  })

  it('C-9: ricerca del nodo per nome → lo seleziona; nessun risultato è detto, non è un silenzio', async () => {
    const { user, onSelect } = renderMap()
    const box = screen.getByLabelText('Search for a component on the map')
    await user.type(box, 'db-')
    await user.click(within(screen.getByTestId('map-search-results')).getByRole('button', { name: 'db-01' }))
    expect(onSelect).toHaveBeenCalledWith('db-01')

    await user.clear(box)
    await user.type(box, 'zzz')
    expect(screen.getByTestId('map-search-results')).toHaveTextContent('No component with "zzz" in its name.')
  })

  it('C-9: sotto la soglia si vede tutto e non c\'è nessun interruttore del percorso', () => {
    renderMap()
    expect(screen.getByTestId('service-map')).toHaveAttribute('data-focus', 'false')
    expect(screen.queryByTestId('map-collapsed-chip')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show every component' })).not.toBeInTheDocument()
  })

  it('C-9: sopra la soglia si apre sul solo percorso d\'impatto; il chip espande il livello', async () => {
    const count = FOCUS_THRESHOLD + 10
    const { user } = renderMap(wideMap(count))
    expect(screen.getByTestId('service-map')).toHaveAttribute('data-focus', 'true')
    const shown = screen.getAllByTestId('service-map-node').length
    expect(shown).toBeLessThan(count + 2)
    expect(nodeOf('db-01')).toBeInTheDocument()                      // la causa c'è sempre

    const chip = screen.getByTestId('map-collapsed-chip')
    expect(chip).toHaveAttribute('data-level', '2')
    expect(chip).toHaveTextContent(`+${count + 2 - shown} components off the path`)
    await user.click(chip)
    expect(screen.getAllByTestId('service-map-node')).toHaveLength(count + 2)
    expect(screen.queryByTestId('map-collapsed-chip')).not.toBeInTheDocument()

    // l'interruttore riporta tutto in vista
    await user.click(screen.getByRole('button', { name: 'Show every component' }))
    expect(screen.getByTestId('service-map')).toHaveAttribute('data-focus', 'false')
    expect(screen.getAllByTestId('service-map-node')).toHaveLength(count + 2)
  })

  it('il componente scelto è evidenziato col turchese dell\'applicazione, lo stesso delle sezioni', () => {
    renderWithProviders(<ServiceMapCanvas map={detail()} selectedId="db-01" onSelect={() => {}} />)
    const picked = nodeOf('db-01')
    const other  = nodeOf('cert-billing')

    // il turchese vince sul colore della salute e su quello del percorso d'impatto
    expect(picked.style.border).toContain('var(--color-brand)')
    expect(picked.style.background).toBe('var(--color-brand-light)')
    expect(picked).toHaveAttribute('aria-pressed', 'true')

    expect(other.style.border).not.toContain('var(--color-brand)')
    expect(other).toHaveAttribute('aria-pressed', 'false')
  })

  it('«Isola»: la mappa mostra solo la catena, lo dice in un avviso e si torna indietro da lì', async () => {
    const onIsolate = vi.fn()
    const { user } = renderWithProviders(
      <ServiceMapCanvas map={detail()} selectedId={null} onSelect={() => {}} isolatedId="db-01" onIsolate={onIsolate} />,
    )
    const shown = screen.getAllByTestId('service-map-node').map((el) => el.getAttribute('data-ci-id'))
    expect(shown).toContain('db-01')
    expect(shown).not.toContain('cert-billing')                    // fuori dalla catena

    const banner = screen.getByTestId('map-isolated-banner')
    expect(banner).toHaveTextContent('Chain of db-01')
    expect(banner).toHaveTextContent('outside the chain')
    await user.click(within(banner).getByRole('button', { name: 'Show the whole map' }))
    expect(onIsolate).toHaveBeenCalledWith(null)
  })

  it('C-10: gruppo con nome, riassunto testuale, legenda come lista', () => {
    renderMap()
    expect(screen.getByRole('group', { name: /Service map of Enterprise Billing/ })).toBeInTheDocument()
    expect(screen.getByTestId('map-summary')).toHaveTextContent('1 component down out of 4.')
    expect(screen.getByTestId('map-summary')).toHaveTextContent('Impact path: db-01 → api-03 → Enterprise Billing; cache-02 → api-03 → Enterprise Billing.')
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(within(legend).getAllByRole('listitem').length).toBeGreaterThan(5)
  })

  it('C-10: un solo nodo nel giro dei tab, le frecce si spostano fra i nodi e fra i livelli', async () => {
    const { user } = renderMap()
    const tabbable = () => screen.getAllByTestId('service-map-node').filter((n) => n.getAttribute('tabindex') === '0')
    expect(tabbable()).toHaveLength(1)
    expect(tabbable()[0]).toBe(nodeOf('db-01'))                       // si parte da una causa

    nodeOf('db-01').focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(nodeOf('db-01'))              // ultimo della riga: non si esce dalla mappa
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(nodeOf('cert-billing'))       // riga 2, ordine del layout
    expect(tabbable()).toHaveLength(1)
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(nodeOf('api-03'))             // su per il `via`
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(nodeOf('cache-02'))           // giù sul primo figlio
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(nodeOf('db-01'))              // ultimo della riga
  })

  it('C-10: i nodi sul percorso portano la descrizione del percorso; gli altri no', () => {
    renderMap()
    const described = nodeOf('db-01').getAttribute('aria-describedby')!
    expect(document.getElementById(described)).toHaveTextContent('On the impact path (Down): db-01 → api-03 → Enterprise Billing')
    expect(nodeOf('cert-billing')).not.toHaveAttribute('aria-describedby')
  })
})
