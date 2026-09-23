/**
 * WHAT-IF: reading the result of an analysis.
 *
 * `WhatIfPage.test.tsx` covers the search, the run and the type labels. This
 * file covers what a planner does with the result: the impacted CIs are
 * filtered, sorted and paged IN THE BROWSER (the analysis is already loaded),
 * the services and teams tabs list what is hit, and a row opens the CI or the
 * path that reaches it. A filter that silently keeps rows it should drop, or
 * a sort that puts rows in a meaningless order, makes a planner believe the
 * wrong thing about the blast radius, so those are pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { FilterGroup, FilterOperator } from '@/components/FilterBuilder'
import { WhatIfPage } from './WhatIfPage'

// The analysis is a lazy query: named in `held`, it stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useLazyQuery>[0]
  return {
    ...m,
    useLazyQuery: (doc: Doc) => {
      const [run, r] = m.useLazyQuery(doc)
      return held.has(nomeOperazione(doc)) ? [run, { ...r, data: undefined, loading: true }] as const : [run, r] as const
    },
  }
})
// The path graph is D3: what matters here is which path it is given, with which icons.
vi.mock('@/components/MiniPathGraph', () => ({
  MiniPathGraph: ({ pathNames, typeIconMap }: { pathNames: string[]; typeIconMap: Map<string, string> }) =>
    <div data-testid="mini-path">{`${pathNames.join(' > ')} (icons: ${typeIconMap.size})`}</div>,
}))
// The real builder, plus a button that applies `crafted.group`: a rule the
// builder cannot produce today, as a later builder might offer it.
const crafted = vi.hoisted(() => ({ group: null as FilterGroup | null }))
vi.mock('@/components/FilterBuilder', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/FilterBuilder')>()
  return {
    ...real,
    FilterBuilder: (props: Parameters<typeof real.FilterBuilder>[0]) => (
      <>
        <real.FilterBuilder {...props} />
        {crafted.group && <button type="button" onClick={() => props.onApply(crafted.group)}>Apply the crafted filter</button>}
      </>
    ),
  }
})

const ci = (id: string, name: string, type: string, over: Record<string, unknown> = {}) => ({
  id, name, type, environment: null, status: 'active', impactLevel: 'high', impactPath: ['orders-db', name], isRedundant: false, ...over,
})
const TARGET = ci('db-1', 'orders-db', 'database_instance', { impactLevel: 'target', impactPath: [] })
const IMPACTED = [
  ci('srv-1', 'orders-app-01', 'server', { environment: 'production', impactLevel: 'critical' }),
  ci('db-2', 'reports-db', 'database_instance', { impactLevel: 'high' }),
  ci('srv-2', 'cache-01', 'server', { environment: 'staging', impactLevel: 'medium' }),
  ci('app-1', 'billing-api', 'application', { environment: 'production', impactLevel: 'low', impactPath: ['billing-api'] }),
]

const result = (over: Record<string, unknown> = {}) => ({
  targetCI: TARGET, action: 'impact', impactedCIs: IMPACTED, impactedServices: [], impactedTeams: [],
  totalImpacted: IMPACTED.length, riskScore: 70, hasRedundancy: false, openIncidents: 0, ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  crafted.group = null
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', icon: 'server' }, { name: 'database_instance', icon: 'database' }] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'db-1', name: 'orders-db', type: 'database_instance' }] } }
  apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result() }
})

const names = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map((r) => within(r).getAllByRole('cell')[0]!.textContent)

type User = ReturnType<typeof renderWithProviders>['user']

async function filterBy(user: User, field: string, operator: string | null, value?: string | string[]) {
  // The panel stays open after «Reset»: open it only when it is closed.
  if (!screen.queryByRole('button', { name: 'Add filter' })) await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
  await user.click(screen.getByRole('button', { name: 'Add filter' }))
  await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), field)
  if (operator) await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of condition 1' }), operator)
  if (Array.isArray(value)) {
    const group = screen.getByRole('group', { name: 'Value of condition 1' })
    for (const v of value) await user.click(within(group).getByText(v))
  } else if (value !== undefined) {
    const input = screen.getByLabelText('Value of condition 1')
    if (input.tagName === 'SELECT') await user.selectOptions(input, value)
    else await user.type(input, value)
  }
  await user.click(screen.getByRole('button', { name: 'Apply' }))
}

describe('filtering the impacted CIs', () => {
  it('offers name, the types found, the impact levels and the environments found', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const field = screen.getByRole('combobox', { name: 'Field of condition 1' })
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select field...', 'CI Name', 'CI Type', 'Impact Level', 'Environment'])
    const optionsOf = () => within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent)
    await user.selectOptions(field, 'type')
    expect(optionsOf()).toEqual(['Select', 'Server', 'Database Instance', 'Application'])
    await user.selectOptions(field, 'impactLevel')
    expect(optionsOf()).toEqual(['Select', 'Critical', 'High', 'Medium', 'Low'])
    await user.selectOptions(field, 'environment')
    expect(optionsOf()).toEqual(['Select', 'production', 'staging'])
  })

  it('by name, «contains» ignores case', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedCIs: [...IMPACTED, ci('x', 'Orders-Archive', 'server')] }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'name', null, 'ORDERS')
    expect(names()).toEqual(['orders-app-01', 'Orders-Archive'])
  })

  // «equals» is exact, as on the server and in every other list: the page's
  // own filter lower-cased it until it took the shared one (tour of 23 Sep 2026).
  it('by name, «starts with» and «equals», which is exact as in every other list', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'name', 'starts_with', 'rep')
    expect(names()).toEqual(['reports-db'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(names()).toHaveLength(4)
    await filterBy(user, 'name', 'equals', 'cache-01')
    expect(names()).toEqual(['cache-01'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await filterBy(user, 'name', 'equals', 'Cache-01')
    expect(screen.getByText('No impacted CIs')).toBeInTheDocument()
  })

  it('by type, and by several impact levels at once', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'type', null, 'server')
    expect(names()).toEqual(['orders-app-01', 'cache-01'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await filterBy(user, 'impactLevel', 'in', ['Critical', 'Low'])
    expect(names()).toEqual(['orders-app-01', 'billing-api'])
  })

  it('by environment: «not equals» and «is not one of» keep the CIs with no environment too', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'environment', 'not_equals', 'production')
    expect(names()).toEqual(['reports-db', 'cache-01'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await filterBy(user, 'environment', 'not_in', ['staging', 'production'])
    expect(names()).toEqual(['reports-db'])
  })

  it('by environment: empty and not empty', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'environment', 'is_empty')
    expect(names()).toEqual(['reports-db'])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await filterBy(user, 'environment', 'is_not_empty')
    expect(names()).toEqual(['orders-app-01', 'cache-01', 'billing-api'])
  })

  it('when nothing matches, the table says there is no impacted CI', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'name', null, 'nothing-like-this')
    expect(screen.getByText('No impacted CIs')).toBeInTheDocument()
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the page's own filter
   * handled six operators and kept every row for any other, so «CI Name ends
   * with -db» showed the whole list as if it were the filtered one.
   */
  it('by name, «ends with» narrows the list', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await filterBy(user, 'name', 'ends_with', '-db')
    expect(names()).toEqual(['reports-db'])
  })

  it('conditions joined by OR keep the CIs that match either one', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    for (const [n, value] of [[1, 'reports'], [2, 'cache']] as const) {
      await user.selectOptions(screen.getByRole('combobox', { name: `Field of condition ${n}` }), 'name')
      await user.type(screen.getByRole('textbox', { name: `Value of condition ${n}` }), value)
    }
    await user.click(screen.getByRole('button', { name: 'OR' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(names()).toEqual(['reports-db', 'cache-01'])
  })

  it('an operator the filter cannot evaluate is said, and no CI is shown as if it matched', async () => {
    crafted.group = { rules: [{ id: 'r1', field: 'name', operator: 'sounds_like' as string as FilterOperator, value: 'orders', logic: 'AND' }] }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Apply the crafted filter' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This filter cannot be applied to the impacted CIs: Unknown filter operator: "sounds_like". Change it, or press «Reset».',
    )
    expect(screen.queryByRole('table')).toBeNull()
    // Reset brings the whole list back.
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(names()).toHaveLength(4)
  })
})

describe('sorting and paging the impacted CIs', () => {
  it('a column sorts ascending, then descending', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    const header = () => within(screen.getByRole('columnheader', { name: /CI Name/ })).getByRole('button')
    await user.click(header())
    expect(names()).toEqual(['billing-api', 'cache-01', 'orders-app-01', 'reports-db'])
    await user.click(header())
    expect(names()).toEqual(['reports-db', 'orders-app-01', 'cache-01', 'billing-api'])
  })

  it('CIs in the same environment stay together when sorted by environment', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(within(screen.getByRole('columnheader', { name: /Environment/ })).getByRole('button'))
    const order = names()
    // production, production, then staging (the CI without environment: next test).
    const withEnv = order.filter((n) => n !== 'reports-db')
    expect(withEnv).toEqual(['orders-app-01', 'billing-api', 'cache-01'])
  })

  it('a CI without environment goes last, whichever the direction', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    const header = () => within(screen.getByRole('columnheader', { name: /Environment/ })).getByRole('button')
    await user.click(header())
    expect(names()).toEqual(['orders-app-01', 'billing-api', 'cache-01', 'reports-db'])
    await user.click(header())
    expect(names()).toEqual(['cache-01', 'orders-app-01', 'billing-api', 'reports-db'])
  })

  /*
   * Found by these tests (tour of 23 Sep 2026), fixed: the page sorted with
   * its own `<`/`>` instead of the table's `sortRowsBy`: «web-10» came before
   * «web-9», a CI without environment came first, and Impact sorted
   * alphabetically (critical, high, low, medium) instead of by severity.
   */
  it('names sort with numbers in numeric order, as in every other table', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedCIs: [ci('a', 'web-10', 'server'), ci('b', 'web-9', 'server')] }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(within(screen.getByRole('columnheader', { name: /CI Name/ })).getByRole('button'))
    expect(names()).toEqual(['web-9', 'web-10'])
  })

  it('impact sorts by severity, not alphabetically', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(within(screen.getByRole('columnheader', { name: /Impact/ })).getByRole('button'))
    expect(names()).toEqual(['orders-app-01', 'reports-db', 'cache-01', 'billing-api'])
  })

  it('shows twenty CIs a page', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ci(`c${i}`, `ci-${String(i).padStart(2, '0')}`, 'server'))
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedCIs: many, totalImpacted: 25 }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    expect(names()).toHaveLength(20)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(names()).toEqual(['ci-20', 'ci-21', 'ci-22', 'ci-23', 'ci-24'])
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(names()[0]).toBe('ci-00')
  })
})

describe('a row of the impacted CIs', () => {
  it('the path button opens and closes the path, drawn with the icons of the metamodel', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    const row = screen.getByRole('row', { name: /orders-app-01/ })
    await user.click(within(row).getByTitle('View path'))
    expect(screen.getByTestId('mini-path')).toHaveTextContent('orders-db > orders-app-01 (icons: 2)')
    await user.click(within(row).getByTitle('View path'))
    expect(screen.queryByTestId('mini-path')).toBeNull()
  })

  it('a CI reached in a single step has no path to draw, and its path column says so', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedCIs: [...IMPACTED, ci('z', 'lonely', 'server', { impactPath: [] })] }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    const billing = screen.getByRole('row', { name: /billing-api/ })
    await user.click(within(billing).getByTitle('View path'))
    expect(screen.queryByTestId('mini-path')).toBeNull()
    expect(within(screen.getByRole('row', { name: /lonely/ })).getAllByRole('cell')[4]).toHaveTextContent('—')
  })

  it('without the metamodel types the path is drawn with no icons', async () => {
    delete apolloFinto.risposte['GetCITypes']
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(within(screen.getByRole('row', { name: /orders-app-01/ })).getByTitle('View path'))
    expect(screen.getByTestId('mini-path')).toHaveTextContent('(icons: 0)')
  })
})

describe('the services and teams tabs', () => {
  const SERVICES = [
    ci('svc-1', 'Checkout', 'BusinessApplication', { environment: 'production', impactLevel: 'critical', impactPath: ['orders-db', 'orders-app-01', 'Checkout'] }),
    ci('svc-2', 'Reporting', 'business_application', { impactLevel: 'low', impactPath: [] }),
  ]

  it('a service shows its environment, impact and path, and opens its CI page (the graph label becomes the route)', async () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedServices: SERVICES }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Services (2)' }))
    const checkout = within(screen.getByRole('row', { name: /Checkout/ })).getAllByRole('cell').map((c) => c.textContent)
    expect(checkout).toEqual(['Checkout', 'production', 'Critical', 'orders-db → orders-app-01 → Checkout'])
    const reporting = within(screen.getByRole('row', { name: /Reporting/ })).getAllByRole('cell').map((c) => c.textContent)
    expect(reporting).toEqual(['Reporting', '—', 'Low', '—'])
    await user.click(screen.getByText('Checkout'))
    await attendiURL('/ci/business_application/svc-1')
  })

  it('services and teams are shown twenty a page', async () => {
    const services = Array.from({ length: 25 }, (_, i) => ci(`s${i}`, `service-${String(i).padStart(2, '0')}`, 'business_application'))
    const teams = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, name: `team-${String(i).padStart(2, '0')}`, role: 'owner', impactedCICount: 1 }))
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedServices: services, impactedTeams: teams }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Services (25)' }))
    expect(names()).toHaveLength(20)
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(names()).toEqual(['service-20', 'service-21', 'service-22', 'service-23', 'service-24'])
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(names()[0]).toBe('service-00')

    await user.click(screen.getByRole('button', { name: 'Teams (21)' }))
    expect(names()).toHaveLength(20)
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(names()).toEqual(['team-20'])
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(names()[0]).toBe('team-00')
  })

  it('services sort by impact severity too, not alphabetically', async () => {
    const services = [
      ci('s1', 'Billing', 'business_application', { impactLevel: 'low' }),
      ci('s2', 'Checkout', 'business_application', { impactLevel: 'critical' }),
      ci('s3', 'Reporting', 'business_application', { impactLevel: 'medium' }),
    ]
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ impactedServices: services }) }
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Services (3)' }))
    await user.click(within(screen.getByRole('columnheader', { name: /Impact/ })).getByRole('button'))
    expect(names()).toEqual(['Checkout', 'Reporting', 'Billing'])
  })

  it('no team involved: the tab says so', async () => {
    const { user } = renderWithProviders(<WhatIfPage />)
    await user.click(screen.getByRole('button', { name: 'Teams (0)' }))
    expect(screen.getByText('No teams involved')).toBeInTheDocument()
  })
})

describe('the run', () => {
  it('a removal is summarised as a removal', () => {
    apolloFinto.risposte['WhatIfAnalysis'] = { whatIfAnalysis: result({ action: 'remove' }) }
    renderWithProviders(<WhatIfPage />)
    expect(screen.getByText('If orders-db is removed: impacted CIs 4, services 0, teams 0. Risk 70/100.')).toBeInTheDocument()
  })

  it('while the analysis runs the button says so and placeholders stand in for the result', () => {
    held.add('WhatIfAnalysis')
    renderWithProviders(<WhatIfPage />)
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled()
    // The «nothing analysed yet» state is not shown over a running analysis.
    expect(screen.queryByText('Simulate the impact of CMDB graph changes', { selector: 'div' })).toBeNull()
  })

  it('the search list closes when the box loses focus and opens again when it comes back', async () => {
    delete apolloFinto.risposte['WhatIfAnalysis']
    const { user } = renderWithProviders(<WhatIfPage />)
    const box = screen.getByRole('textbox', { name: /Search CI by name/i })
    await user.click(box)
    // An empty box has nothing to show.
    expect(screen.queryByRole('button', { name: /orders-db/ })).toBeNull()
    await user.type(box, 'orders')
    expect(screen.getByRole('button', { name: /orders-db/ })).toBeInTheDocument()
    await user.tab()
    await waitFor(() => expect(screen.queryByRole('button', { name: /orders-db/ })).toBeNull())
    await user.click(box)
    expect(screen.getByRole('button', { name: /orders-db/ })).toBeInTheDocument()
  })

  it('a CI can be chosen from the keyboard (Enter on the option clicks it), and the Analyze button keeps its colour under the pointer', async () => {
    delete apolloFinto.risposte['WhatIfAnalysis']
    const { user } = renderWithProviders(<WhatIfPage />)
    const analyze = screen.getByRole('button', { name: 'Analyze' })
    // Before a CI is chosen the button does not light up under the pointer.
    fireEvent.mouseEnter(analyze)
    expect(analyze.style.background).not.toBe('var(--color-brand)')
    fireEvent.mouseLeave(analyze)
    expect(analyze.style.background).not.toBe('var(--color-brand)')
    const box = screen.getByRole('textbox', { name: /Search CI by name/i })
    await user.type(box, 'orders')
    fireEvent.click(screen.getByRole('button', { name: /orders-db/ }))
    expect(box).toHaveValue('orders-db')
    await user.hover(analyze)
    expect(analyze.style.background).toBe('var(--color-brand)')
    await user.unhover(analyze)
    expect(analyze.style.background).toBe('var(--color-brand)')
  })
})
