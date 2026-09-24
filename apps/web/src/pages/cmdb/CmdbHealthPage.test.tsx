/**
 * THE CMDB HEALTH PAGE (owner's request, 24 Sep 2026): what is missing or does
 * not add up in the CMDB, live.
 *
 * What it must get right:
 *  - one card per check: how many CIs it finds out of how many it looked at,
 *    green with «nothing to fix» at zero, and the certificate types it could
 *    not check named, not skipped;
 *  - the page says which retired statuses are left out;
 *  - a card opens the list of its CIs (and a second click closes it); the
 *    chosen check lives in the URL;
 *  - the list asks the server with the filters and the page, links each CI to
 *    its detail, says what is wrong with each, and the CSV holds all of them.
 *  - three checks come from the CMDB chains: with none drawn their cards say
 *    so; the relations one counts relations, not CIs; an incomplete CI says
 *    which links it lacks, a relation not admitted names the CI at its other
 *    end and links to it;
 *  - two tabs, the checks and the chains, the tab in the URL.
 * The rules of the checks are the API's (services/cmdbHealth.ts, its tests);
 * the Chains tab has its own tests (chains/*.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDate } from '@/lib/datetime'
import { GET_CMDB_HEALTH_ITEMS } from '@/graphql/queries'
import { CmdbHealthPage } from './CmdbHealthPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const csv = vi.hoisted(() => ({ exportToCsv: vi.fn() }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: csv.exportToCsv }))
vi.mock('./chains/CmdbChainsTab', () => ({
  CmdbChainsTab: ({ coverage, canEdit }: { coverage: unknown[]; canEdit: boolean }) => <div data-testid="chains-tab">{`${String(coverage.length)} coverage · edit ${String(canEdit)}`}</div>,
}))


const check = (key: string, count: number, population: number, notCheckedTypes: string[] = [], needsChains = false) => ({ key, count, population, notCheckedTypes, needsChains })
const HEALTH = { cmdbHealth: {
  checks: [
    check('chain_orphan', 2307, 18736),
    check('missing_owner_group', 0, 21870),
    check('certificate_expired_in_use', 271, 3000, ['vpn_token']),
    check('duplicate_name', 2, 21870),
    check('required_field_empty', 1, 2262),
  ],
  retiredStatuses: ['inactive', 'decommissioned'],
  chainCount: 3,
  chainCoverage: [{ chainId: 'c1', name: 'Application services', kind: 'application', roots: 10, complete: 8 }],
} }
const item = (over: Record<string, unknown> = {}) => ({
  id: 'ci-1', name: 'srv-01', type: 'server', environment: 'production', status: 'active',
  expiresAt: null, inUseBy: null, sameName: null, missingFields: [],
  missingLinks: [], relation: null, relatedId: null, relatedName: null, relatedType: null, ...over,
})
const items = (list: unknown[], total = list.length) => ({ cmdbHealthItems: { total, population: 100, items: list } })

beforeEach(() => {
  apolloFinto.reset()
  csv.exportToCsv.mockReset()
  apolloFinto.risposte['GetCmdbHealth'] = HEALTH
  apolloFinto.risposte['GetCmdbHealthItems'] = items([item()])
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { name: '__base__', fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active', 'inactive', 'decommissioned'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production', 'staging'] },
  ] } }
})

const mount = (route = '/cmdb/health') => renderWithProviders(<CmdbHealthPage />, { route })
const card = (title: string) => screen.getByRole('button', { name: new RegExp(title) })
const lastItems = () => apolloFinto.chiamata('GetCmdbHealthItems')

describe('CmdbHealthPage — the cards', () => {
  it('one card per check: the count out of the CIs looked at, green at zero, and the types not checked named', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'CMDB Health' })).toBeInTheDocument()
    expect(screen.getByText(/Retired CIs \(.+\) are left out/)).toBeInTheDocument()
    const orphans = card('Outside every chain')
    expect(orphans).toHaveTextContent('2,307')
    expect(orphans).toHaveTextContent('of 18,736 CIs checked · 12.3%')
    // Something found that rounds to nothing does not read 0%.
    expect(card('Required fields empty')).toHaveTextContent('of 2,262 CIs checked · < 0.1%')
    // The share in the card's colour — the colour of its count — the rest of the phrase in bold.
    const share = within(orphans).getByTestId('share')
    expect(share).toHaveTextContent('12.3%')
    expect(share.style.color).toBe(within(orphans).getByText('2,307').style.color)
    expect(share.parentElement!.style.fontWeight).toBe('600')
    expect(orphans).toHaveAttribute('aria-pressed', 'false')
    const owner = card('No Owner Group')
    expect(within(owner).getByLabelText('Nothing to fix')).toBeInTheDocument()
    expect(owner).toHaveTextContent('none of 21,870 CIs checked')
    expect(card('Expired certificates in use')).toHaveTextContent('Not checked: vpn_token (no expiry field).')
    // Nothing chosen yet: the page says what to do.
    expect(screen.getByText('Choose a check to see its CIs.')).toBeInTheDocument()
    expect(lastItems()).toBeUndefined()
  })

  it('a failed load shows the error with a retry, not a healthy CMDB', async () => {
    apolloFinto.erroriQuery['GetCmdbHealth'] = new Error('health unavailable')
    const { user } = mount()
    expect(screen.getByText('health unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /No Owner Group/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a card opens its list and sets ?check=; a second click closes it', async () => {
    const { user } = mount()
    await user.click(card('Outside every chain'))
    await attendiURL('/cmdb/health', { check: 'chain_orphan' })
    expect(card('Outside every chain')).toHaveAttribute('aria-pressed', 'true')
    expect(lastItems()).toEqual({ check: 'chain_orphan', type: null, environment: null, limit: 25, offset: 0 })
    expect(screen.getByRole('region', { name: 'Outside every chain' })).toBeInTheDocument()
    await user.click(card('Outside every chain'))
    await attendiURL('/cmdb/health')
    expect(screen.queryByRole('region')).toBeNull()
  })
})

describe('CmdbHealthPage — the list of a check', () => {
  it('each CI links to its detail, with type, environment, status in the product\'s words', () => {
    mount('/cmdb/health?check=chain_orphan')
    const list = screen.getByRole('region', { name: 'Outside every chain' })
    expect(within(list).getByText('· 1 CI')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'srv-01' })).toHaveAttribute('href', '/ci/server/ci-1')
    const row = within(list).getByRole('link', { name: 'srv-01' }).closest('tr')!
    expect(within(row).getByText('Server')).toBeInTheDocument()
    // A check with nothing more to say shows a dash in the detail.
    expect(within(row).getAllByText('—')).toHaveLength(1)
  })

  it('says what is wrong: when a certificate expired and how many use it, the duplicates, the empty fields', () => {
    apolloFinto.risposte['GetCmdbHealthItems'] = (v?: Record<string, unknown>) => items([
      v?.['check'] === 'certificate_expired_in_use' ? item({ type: 'certificate', expiresAt: '2026-04-25T11:16:27.653Z', inUseBy: 7 })
        : v?.['check'] === 'duplicate_name' ? item({ sameName: 2 })
        : item({ missingFields: ['Serial number', 'Expires at'] }),
    ])
    const first = mount('/cmdb/health?check=certificate_expired_in_use')
    expect(screen.getByText(`Expired on ${formatDate('2026-04-25T11:16:27.653Z')} · used by 7 CIs`)).toBeInTheDocument()
    first.unmount()
    const second = mount('/cmdb/health?check=duplicate_name')
    expect(screen.getByText('Same name as 2 other CIs')).toBeInTheDocument()
    second.unmount()
    mount('/cmdb/health?check=required_field_empty')
    expect(screen.getByText('Empty: Serial number, Expires at')).toBeInTheDocument()
  })

  it('a filter asks the server and starts again from the first page; paging moves the offset', async () => {
    apolloFinto.risposte['GetCmdbHealthItems'] = items([item()], 60)
    const { user } = mount('/cmdb/health?check=chain_orphan')
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastItems()).toMatchObject({ offset: 25 })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'server')
    expect(lastItems()).toMatchObject({ type: 'server', offset: 0 })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Environment' }), 'production')
    expect(lastItems()).toMatchObject({ type: 'server', environment: 'production', offset: 0 })
  })

  it('an empty list says whether it is the check or the filter', async () => {
    apolloFinto.risposte['GetCmdbHealthItems'] = items([])
    const { user } = mount('/cmdb/health?check=missing_owner_group')
    expect(screen.getByText('No CI found: this check has nothing to fix.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Environment' }), 'staging')
    expect(screen.getByText('No CI found with these filters.')).toBeInTheDocument()
  })

  it('a failed list shows the error with a retry', () => {
    apolloFinto.erroriQuery['GetCmdbHealthItems'] = new Error('list unavailable')
    mount('/cmdb/health?check=chain_orphan')
    expect(screen.getByText('list unavailable')).toBeInTheDocument()
  })

  it('the CSV asks the server for every CI of the check with the filters, and exports what the page shows', async () => {
    apolloFinto.query.mockResolvedValue({ data: items([item({ sameName: 1 }), item({ id: 'ci-2', name: 'srv-01', environment: null, status: null, sameName: 1 })]) })
    const { user } = mount('/cmdb/health?check=duplicate_name')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'server')
    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(csv.exportToCsv).toHaveBeenCalled())
    expect(apolloFinto.query).toHaveBeenCalledWith({
      query: GET_CMDB_HEALTH_ITEMS, fetchPolicy: 'network-only',
      variables: { check: 'duplicate_name', type: 'server', environment: null, limit: 10_000, offset: 0 },
    })
    const [name, columns, rows] = csv.exportToCsv.mock.calls[0] as [string, Array<{ key: string }>, Array<Record<string, string>>]
    expect(name).toBe('cmdb-health-duplicate_name')
    expect(columns.map((c) => c.key)).toEqual(['name', 'type', 'environment', 'status', 'detail'])
    expect(rows).toEqual([
      // Environment and status through the tenant's vocabulary (empty here: the value itself).
      { name: 'srv-01', type: 'Server', environment: 'production', status: 'active', detail: 'Same name as 1 other CI' },
      { name: 'srv-01', type: 'Server', environment: '', status: '', detail: 'Same name as 1 other CI' },
    ])
  })

  it('a failed CSV is said, not swallowed, and the button comes back', async () => {
    apolloFinto.query.mockRejectedValue(new Error('export down'))
    const { user } = mount('/cmdb/health?check=chain_orphan')
    await user.click(screen.getByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Export CSV/ })).toBeEnabled())
    expect(csv.exportToCsv).not.toHaveBeenCalled()
  })
})

describe('CmdbHealthPage — the checks the chains decide', () => {
  const chainHealth = (needsChains: boolean) => ({ cmdbHealth: { ...HEALTH.cmdbHealth, chainCount: needsChains ? 0 : 3, checks: [
    check('chain_incomplete', 3, 900, [], needsChains),
    check('relation_not_admitted', needsChains ? 5 : 0, 40, [], needsChains),
  ] } })

  it('with no chain drawn their cards say to draw one; the relations card counts relations', () => {
    apolloFinto.risposte['GetCmdbHealth'] = chainHealth(true)
    mount()
    expect(card('Incomplete chains')).toHaveTextContent('No chain is drawn yet: draw one in the Chains tab.')
    expect(card('Relations not admitted')).toHaveTextContent('of 40 relations checked · 12.5%')
  })

  it('a relations card with nothing found says «none of … relations checked»', () => {
    apolloFinto.risposte['GetCmdbHealth'] = chainHealth(false)
    mount()
    expect(card('Relations not admitted')).toHaveTextContent('none of 40 relations checked')
    expect(card('Incomplete chains')).not.toHaveTextContent('No chain is drawn yet')
  })

  it('an incomplete CI says which links it lacks, in words, with its chain; from several chains, as the alternatives they are', () => {
    apolloFinto.risposte['GetCmdbHealthItems'] = (v?: Record<string, unknown>) => items([
      v?.['offset'] === 0 && v['type'] === 'database'
        ? item({ type: 'database', missingLinks: [
          { chain: 'Applications on databases', ciType: 'database_instance', relationType: 'DEPENDS_ON', direction: 'outgoing' },
          { chain: 'Applications on databases', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming' },
        ] })
        : item({ type: 'application', missingLinks: [
          { chain: 'Applications on servers', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing' },
          { chain: 'Applications on databases', ciType: 'database', relationType: 'DEPENDS_ON', direction: 'outgoing' },
        ] }),
    ])
    const first = mount('/cmdb/health?check=chain_incomplete')
    expect(screen.getByText('Needs one of: Hosted on → Server (Applications on servers) or Depends on → Database (Applications on databases)')).toBeInTheDocument()
    first.unmount()
    apolloFinto.risposte['GetCmdbHealthItems'] = items([item({ type: 'database', missingLinks: [
      { chain: 'Applications on databases', ciType: 'database_instance', relationType: 'DEPENDS_ON', direction: 'outgoing' },
      { chain: 'Applications on databases', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming' },
    ] })])
    mount('/cmdb/health?check=chain_incomplete')
    expect(screen.getByText('Lacks: Depends on → Database Instance + Certificate → Installed on (Applications on databases)')).toBeInTheDocument()
  })

  it('a relation not admitted names the relation and the CI at its other end, links to it, and each relation is its own row', () => {
    const rel = (relatedId: string) => item({ type: 'database', relation: 'USES_CERTIFICATE', relatedId, relatedName: `CER_${relatedId}`, relatedType: 'certificate' })
    apolloFinto.risposte['GetCmdbHealthItems'] = items([rel('c1'), rel('c2')])
    mount('/cmdb/health?check=relation_not_admitted')
    const list = screen.getByRole('region', { name: 'Relations not admitted' })
    expect(within(list).getByText('· 2 relations')).toBeInTheDocument()
    expect(within(list).getAllByRole('row')).toHaveLength(3)
    expect(within(list).getByText(/Uses certificate → CER_c1 \(Certificate\)/)).toBeInTheDocument()
    expect(within(list).getAllByRole('link', { name: 'open' })[1]).toHaveAttribute('href', '/ci/certificate/c2')
  })
})

describe('CmdbHealthPage — the tabs', () => {
  it('the Chains tab sets ?tab=chains and shows the chains with their coverage; Checks takes the tab and the chain out of the URL', async () => {
    const { user } = mount('/cmdb/health?check=chain_orphan')
    expect(screen.getByRole('tab', { name: /Checks/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: /Chains/ }))
    await attendiURL('/cmdb/health', { check: 'chain_orphan', tab: 'chains' })
    // Who may not change the metamodel sees the chains read-only.
    expect(screen.getByTestId('chains-tab')).toHaveTextContent('1 coverage · edit false')
    expect(screen.queryByRole('region', { name: 'Outside every chain' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: /Checks/ }))
    await attendiURL('/cmdb/health', { check: 'chain_orphan' })
    expect(screen.getByRole('region', { name: 'Outside every chain' })).toBeInTheDocument()
  })
})
