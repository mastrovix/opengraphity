/**
 * THE LIVE PREVIEW of the widget configuration panel.
 *
 * It is the only way a user sees what a widget will show BEFORE saving it,
 * and it draws with the same body as the real card. The promises it makes
 * while the user configures:
 *  - the card header is the card's own: the title (or "Widget title" while
 *    there is none) and the chosen period — never a raw translation key;
 *  - loading shows a spinner, nothing to preview yet shows a hint, data shows
 *    the widget with a line of totals under it;
 *  - grouped values are read by their Dictionary label ("Production"), the
 *    way the lists of the product show them, not the stored value;
 *  - a widget with a fixed data source (active alarms) previews its real
 *    body, and never asks to "configure the options above", which that type
 *    does not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import { meFixture } from '@/test/mocks/gql'
import { WidgetPreview } from './WidgetPreview'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

type Props = ComponentProps<typeof WidgetPreview>

function preview(over: Partial<Props> = {}) {
  const props: Props = {
    widgetType: 'counter', color: '#0ea5e9', title: '', previewData: null, previewLoading: false, timeRange: 'all',
    ...over,
  }
  return renderWithProviders(withVocabularyLabels(<WidgetPreview {...props} />))
}

const spinner = (container: HTMLElement) => container.querySelector('[style*="spin"]')

beforeEach(() => {
  apolloFinto.reset()
  // The Dictionary tells which vocabulary a grouped field uses.
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [{ name: 'environment', enumTypeName: 'environment' }] }] }
  apolloFinto.risposte['GetMe'] = { me: meFixture('operator') }
  apolloFinto.risposte['GetEventStats'] = { eventStats: {
    firing: 5, critical: 2, warning: 3, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9, stormSources: [],
  } }
})

describe('WidgetPreview — the card header', () => {
  it('an untitled widget previews as "Widget title", with the chosen period as a chip', () => {
    preview({ timeRange: '1y' })
    expect(screen.getByText('Live preview')).toBeInTheDocument()
    expect(screen.getByText('Widget title')).toBeInTheDocument()
    expect(screen.getByText('1 year')).toBeInTheDocument()
  })

  it('the title typed so far replaces the placeholder; the "All" period is not a chip', () => {
    preview({ title: 'Open incidents', timeRange: 'all' })
    expect(screen.getByText('Open incidents')).toBeInTheDocument()
    expect(screen.queryByText('Widget title')).toBeNull()
    expect(screen.queryByText('All')).toBeNull()
  })

  it('a period without a translation, or no period at all, never shows a raw translation key', () => {
    const { unmount } = preview({ title: 'Open incidents', timeRange: '6h' })
    expect(screen.getByText('Open incidents')).toBeInTheDocument()
    expect(screen.queryByText(/pages\.dashboard/)).toBeNull()
    unmount()
    preview({ title: 'Open incidents', timeRange: '' })
    expect(screen.queryByText(/pages\.dashboard/)).toBeNull()
  })
})

describe('WidgetPreview — the card body', () => {
  it('while the preview loads: a spinner, no hint and no totals', () => {
    const { container } = preview({ previewLoading: true, previewData: { value: 3, label: null, series: [] } })
    expect(spinner(container)).not.toBeNull()
    expect(screen.queryByText('Configure the options above to see the preview')).toBeNull()
    expect(screen.queryByText('Total:')).toBeNull()
  })

  it('with nothing to preview yet, it asks to configure the options', () => {
    const { container } = preview()
    expect(screen.getByText('Configure the options above to see the preview')).toBeInTheDocument()
    expect(spinner(container)).toBeNull()
  })

  it('a counter previews the rounded value, captioned "Preview" while untitled, and the totals line repeats it', async () => {
    preview({ previewData: { value: 1234.6, label: null, series: [] } })
    // The body is loaded lazily (it brings the chart library): wait for it.
    expect(await screen.findByText('Preview')).toBeInTheDocument()
    // Once in the counter, once in the totals line.
    expect(screen.getAllByText('1,235')).toHaveLength(2)
    expect(screen.getByText('Total:')).toHaveTextContent('Total: 1,235')
    // No groups, no categories to count.
    expect(screen.queryByText('Categories:')).toBeNull()
  })

  it('a titled counter is captioned with its title', async () => {
    preview({ title: 'Open incidents', previewData: { value: 8, label: null, series: [] } })
    // In the card header, and as the caption of the counter once the body has loaded.
    await waitFor(() => expect(screen.getAllByText('Open incidents')).toHaveLength(2))
    expect(screen.getAllByText('8')).toHaveLength(2)
    expect(screen.queryByText('Preview')).toBeNull()
  })

  it('grouped values are shown by their Dictionary label, and the totals line counts the categories', async () => {
    preview({
      widgetType: 'table', entityType: 'server', groupByField: 'environment',
      previewData: { value: null, label: null, series: [{ label: 'production', value: 3 }, { label: 'lab', value: 1 }] },
    })
    const production = await screen.findByText('Production')
    expect(production.closest('tr')).toHaveTextContent('Production3')
    // A value the vocabulary does not know is the true data, shown as it is.
    expect(screen.getByText('lab').closest('tr')).toHaveTextContent('lab1')
    expect(screen.queryByText('production')).toBeNull()
    expect(screen.getByText('Categories:')).toHaveTextContent('Categories: 2')
    // No overall value: no total.
    expect(screen.queryByText('Total:')).toBeNull()
  })

  it('a widget with a fixed data source previews its real body — no hint, no totals', () => {
    preview({ widgetType: 'active_alarms', title: 'Alarms', previewData: { value: 3, label: null, series: [] } })
    const card = screen.getByText('Alarms').closest('div')!.parentElement!
    expect(within(card).getByRole('link', { name: 'Critical 2' })).toHaveAttribute('href', '/events?stat=critical')
    expect(screen.queryByText('Configure the options above to see the preview')).toBeNull()
    expect(screen.queryByText('Total:')).toBeNull()
  })
})
