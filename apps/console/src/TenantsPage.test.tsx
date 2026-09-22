/**
 * THE TENANTS PAGE — where a whole customer gets deleted.
 *
 * Three things this interface has to make plain, and each of them is a test
 * below:
 *
 *  1. WHAT is about to be destroyed. The row carries users and tickets, and
 *     the delete panel lists the nodes by label. A count that could not be
 *     made says "unknown", not zero — "0 tickets" reads as "it is empty",
 *     and that is how a full tenant gets deleted.
 *  2. that suspending is NOT deleting. Two commands, in two places, and the
 *     second requires the first.
 *  3. that deleting is final. A red panel of its own, the slug typed again,
 *     and the node count in front of you.
 *
 * The Delete button is not offered on an active tenant at all — rather than
 * offered and refused. An action offered and then denied teaches that the
 * interface lies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Tenant } from './api'

const api = vi.hoisted(() => ({
  tenants: vi.fn(), create: vi.fn(), footprint: vi.fn(), rename: vi.fn(),
  suspend: vi.fn(), resume: vi.fn(), resetPassword: vi.fn(), purge: vi.fn(),
}))
const collegaAvvisi = vi.hoisted(() => vi.fn())
const getKeycloak = vi.hoisted(() => vi.fn())

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  api,
}))
vi.mock('./tokenRefresh', () => ({ collegaAvvisi }))
vi.mock('./keycloak', () => ({ getKeycloak, keycloak: { token: 'tok' } }))

const { TenantsPage } = await import('./TenantsPage')

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: 't1', slug: 'acme', name: 'Acme', plan: 'pro', timezone: 'Europe/Rome',
  stato: 'active', suspendedAt: null, createdAt: '2026-01-01T00:00:00Z',
  utenti: 12, ticket: 340, appUrl: 'https://acme.opengrafo.com', portalUrl: 'https://portal.acme.opengrafo.com',
  admins: ['anna@acme.example'], ...over,
})

/** Renders and waits for the first list to arrive. */
async function draw(tenants: Tenant[] = [tenant()]) {
  api.tenants.mockResolvedValue({ tenants })
  const user = userEvent.setup()
  render(<TenantsPage />)
  if (tenants.length > 0) await screen.findByText(tenants[0]!.slug)
  return { user }
}

const rowOf = (slug: string) => screen.getByText(slug).closest('tr')!

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.tenants.mockResolvedValue({ tenants: [] })
  api.footprint.mockResolvedValue({ slug: 'acme', nodes: {} })
  getKeycloak.mockReturnValue({ tokenParsed: { email: 'ops@opengrafo.example' }, logout: vi.fn() })
})
afterEach(cleanup)

describe('the list', () => {
  it('loads on mount and shows the tenants', async () => {
    await draw([tenant(), tenant({ id: 't2', slug: 'globex', name: 'Globex' })])
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('Globex')).toBeTruthy()
  })

  it('an empty installation says so instead of showing an empty table', async () => {
    api.tenants.mockResolvedValue({ tenants: [] })
    render(<TenantsPage />)
    expect(await screen.findByText('No tenant in this installation.')).toBeTruthy()
  })

  it('a failed load is announced, not left as a silent "loading…"', async () => {
    api.tenants.mockRejectedValue(new Error('Platform API down'))
    render(<TenantsPage />)
    expect((await screen.findByRole('alert')).textContent).toContain('Platform API down')
  })

  it('a count that could not be made reads "unknown", never zero', async () => {
    // "0 tickets" reads as "it is empty", and that is how a full tenant gets
    // deleted.
    await draw([tenant({ utenti: null, ticket: null })])
    expect(within(rowOf('acme')).getAllByText('unknown')).toHaveLength(2)
  })

  it('a real zero is shown as a number, with thousands separated', async () => {
    await draw([tenant({ utenti: 0, ticket: 12_345 })])
    const row = within(rowOf('acme'))
    expect(row.getByText('0')).toBeTruthy()
    expect(row.getByText('12,345')).toBeTruthy()
  })

  it('a tenant with NO active administrator is flagged: nobody can sign in', async () => {
    // It shows in no other column — there can be ten users and not one of
    // them an admin.
    await draw([tenant({ admins: [] })])
    expect(within(rowOf('acme')).getByTitle('No active administrator: nobody can sign in')).toBeTruthy()
  })

  it('a missing plan or address says what is missing rather than nothing', async () => {
    await draw([tenant({ plan: null, appUrl: null, portalUrl: null })])
    const row = within(rowOf('acme'))
    expect(row.getByText('not set')).toBeTruthy()
    expect(row.getByText('not configured')).toBeTruthy()
  })

  it('the tenant addresses open in a new tab, safely', async () => {
    // The console must not get lost because somebody went to look at an app.
    await draw()
    const link = within(rowOf('acme')).getByRole('link', { name: 'acme.opengrafo.com' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('a SUSPENDED tenant keeps its links: they stop at the login, which is how you check', async () => {
    await draw([tenant({ stato: 'suspended' })])
    expect(within(rowOf('acme')).getByRole('link', { name: 'acme.opengrafo.com' })).toBeTruthy()
  })
})

describe('suspend is not delete', () => {
  it('an ACTIVE tenant offers Suspend and no Delete at all', async () => {
    // Offered and then denied teaches that the interface lies.
    await draw()
    const row = within(rowOf('acme'))
    expect(row.getByRole('button', { name: 'Suspend' })).toBeTruthy()
    expect(row.queryByRole('button', { name: 'Delete…' })).toBeNull()
  })

  it('a SUSPENDED tenant offers Resume and Delete', async () => {
    await draw([tenant({ stato: 'suspended' })])
    const row = within(rowOf('acme'))
    expect(row.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(row.getByRole('button', { name: 'Delete…' })).toBeTruthy()
    expect(row.queryByRole('button', { name: 'Suspend' })).toBeNull()
  })

  it('suspending and resuming take the list back FROM THE SERVER, not from a guess', async () => {
    const { user } = await draw()
    api.suspend.mockResolvedValue({ tenants: [tenant({ stato: 'suspended' })] })
    await user.click(screen.getByRole('button', { name: 'Suspend' }))
    expect(api.suspend).toHaveBeenCalledWith('acme')
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy()
  })

  it('a refused action is announced and the list is left alone', async () => {
    const { user } = await draw()
    api.suspend.mockRejectedValue(new Error('Tenant is already suspended'))
    await user.click(screen.getByRole('button', { name: 'Suspend' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Tenant is already suspended')
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeTruthy()
  })
})

describe('renaming', () => {
  it('renames the display name and says the slug cannot change', async () => {
    const { user } = await draw()
    // The sentence is broken up by an <em> around "slug".
    expect(screen.getByText(/is the identity/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByLabelText('New name for acme')
    await user.clear(input)
    await user.type(input, 'Acme S.p.A.')
    api.rename.mockResolvedValue({ tenants: [tenant({ name: 'Acme S.p.A.' })] })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.rename).toHaveBeenCalledWith('acme', 'Acme S.p.A.')
  })

  it('cancelling puts the old name back and asks nothing', async () => {
    const { user } = await draw()
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await user.type(screen.getByLabelText('New name for acme'), '!!!')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.rename).not.toHaveBeenCalled()
    expect(screen.getByText('Acme')).toBeTruthy()
  })
})

describe('the delete panel', () => {
  async function openDelete(nodes: Record<string, number> = { Incident: 340, User: 12 }) {
    api.footprint.mockResolvedValue({ slug: 'acme', nodes })
    const { user } = await draw([tenant({ stato: 'suspended' })])
    await user.click(screen.getByRole('button', { name: 'Delete…' }))
    await screen.findByRole('heading', { name: /Delete .acme. permanently/ })
    return { user }
  }

  it('says what it removes, and that there is no undo and no export', async () => {
    await openDelete()
    const panel = screen.getByRole('heading', { name: /permanently/ }).closest('div')!
    expect(panel.textContent).toContain('It cannot be undone')
    expect(panel.textContent).toContain('take a backup first')
  })

  it('counts what would be deleted, by label and in total', async () => {
    await openDelete({ Incident: 340, User: 12 })
    expect(await screen.findByText('Incident: 340')).toBeTruthy()
    expect(screen.getByText('User: 12')).toBeTruthy()
    expect(screen.getByText('total: 352')).toBeTruthy()
  })

  it('a tenant with nothing in it says so, which is not the same as "still counting"', async () => {
    await openDelete({})
    expect(await screen.findByText('no nodes carry this tenant id')).toBeTruthy()
  })

  it('a failed count is announced: deleting blind is the thing to avoid', async () => {
    api.footprint.mockRejectedValue(new Error('Neo4j unavailable'))
    const { user } = await draw([tenant({ stato: 'suspended' })])
    await user.click(screen.getByRole('button', { name: 'Delete…' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Neo4j unavailable')
  })

  it('the button stays disabled until the slug is typed EXACTLY', async () => {
    const { user } = await openDelete()
    const button = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement
    const input = screen.getByLabelText(/Type/)
    expect(button.disabled).toBe(true)
    await user.type(input, 'acm')
    expect(button.disabled).toBe(true)
    await user.type(input, 'E')          // wrong case is not the slug
    expect(button.disabled).toBe(true)
    await user.clear(input)
    await user.type(input, 'acme')
    expect(button.disabled).toBe(false)
  })

  it('deleting reports how much went, and reloads the list', async () => {
    const { user } = await openDelete()
    api.purge.mockResolvedValue({ slug: 'acme', nodiCancellati: 352, realmCancellato: true })
    api.tenants.mockResolvedValue({ tenants: [] })
    await user.type(screen.getByLabelText(/Type/), 'acme')
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(api.purge).toHaveBeenCalledWith('acme', 'acme')
    expect((await screen.findByRole('status')).textContent).toContain('352 nodes removed')
    expect(screen.getByRole('status').textContent).toContain('Keycloak realm removed')
  })

  it('a delete that fails is announced and the panel stays open', async () => {
    const { user } = await openDelete()
    api.purge.mockRejectedValue(new Error('Realm still has sessions'))
    await user.type(screen.getByLabelText(/Type/), 'acme')
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Realm still has sessions')
    expect(screen.getByRole('heading', { name: /permanently/ })).toBeTruthy()
  })

  it('"Keep it" closes the panel and deletes nothing', async () => {
    const { user } = await openDelete()
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('heading', { name: /permanently/ })).toBeNull()
    expect(api.purge).not.toHaveBeenCalled()
  })
})

describe('the one-time passwords', () => {
  it('Reset password is offered only where there IS an administrator', async () => {
    await draw([tenant({ admins: [] })])
    expect(within(rowOf('acme')).queryByRole('button', { name: 'Reset password…' })).toBeNull()
    cleanup()
    await draw([tenant({ admins: ['anna@acme.example'] })])
    expect(within(rowOf('acme')).getByRole('button', { name: 'Reset password…' })).toBeTruthy()
  })

  it('a new password is shown once, and says it is stored nowhere', async () => {
    const { user } = await draw()
    await user.click(screen.getByRole('button', { name: 'Reset password…' }))
    api.resetPassword.mockResolvedValue({ email: 'anna@acme.example', temporaryPassword: 'Tmp-9x!', tenantSospeso: false })
    await user.click(await screen.findByRole('button', { name: 'Reset password' }))
    expect(await screen.findByText('Tmp-9x!')).toBeTruthy()
    expect(screen.getByText(/stored\s+nowhere/)).toBeTruthy()
  })

  it('when the tenant is suspended the password panel says the password alone is not enough', async () => {
    const { user } = await draw([tenant({ stato: 'suspended' })])
    await user.click(screen.getByRole('button', { name: 'Reset password…' }))
    api.resetPassword.mockResolvedValue({ email: 'anna@acme.example', temporaryPassword: 'Tmp-9x!', tenantSospeso: true })
    await user.click(await screen.findByRole('button', { name: 'Reset password' }))
    expect(await screen.findByText(/resume it before they can sign in/)).toBeTruthy()
  })
})

describe('the header and the token warnings', () => {
  it('shows who is signed in, and initials for the avatar', async () => {
    getKeycloak.mockReturnValue({ tokenParsed: { email: 'anna.rossi@opengrafo.example' }, logout: vi.fn() })
    await draw()
    expect(screen.getByText('anna.rossi@opengrafo.example')).toBeTruthy()
    expect(screen.getByText('AR')).toBeTruthy()
  })

  it('a token that says nothing about the user does not break the page', async () => {
    // `getKeycloak()` throws before init; the page must still render.
    getKeycloak.mockImplementation(() => { throw new Error('not initialized') })
    await draw()
    expect(screen.getByRole('heading', { name: 'Tenants' })).toBeTruthy()
    expect(screen.getByText('?')).toBeTruthy()
  })

  it('signing out goes back to the console\'s own origin', async () => {
    const logout = vi.fn()
    getKeycloak.mockReturnValue({ tokenParsed: { email: 'ops@x' }, logout })
    const { user } = await draw()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(logout).toHaveBeenCalledWith({ redirectUri: window.location.origin })
  })

  it('the token-refresh warnings are wired into the page, not left in the browser console', async () => {
    // "Keycloak unreachable — retrying in Ns" has to be read.
    await draw()
    expect(collegaAvvisi).toHaveBeenCalled()
    const [mostraErrore, mostraRipresa] = collegaAvvisi.mock.calls[0]! as [(m: string) => void, (m: string) => void]
    mostraErrore('Keycloak unreachable — retrying in 8s')
    expect((await screen.findByRole('alert')).textContent).toContain('Keycloak unreachable')
    mostraRipresa('Connection to Keycloak restored')
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(screen.getByRole('status').textContent).toContain('restored')
  })

  it('the footer says this console is not a tenant application', async () => {
    await draw()
    expect(screen.getByText(/not a tenant application/)).toBeTruthy()
  })
})

describe('creating a tenant', () => {
  const nuovo = async () => {
    const { user } = await draw([])
    await user.click(screen.getByRole('button', { name: /New tenant/ }))
    await screen.findByRole('heading', { name: 'New tenant' })
    return { user }
  }

  it('says the slug is permanent and what it becomes', async () => {
    // It is the Keycloak realm, the subdomain and the tenant id of every
    // node: it is the one field that cannot be changed afterwards.
    await nuovo()
    expect(screen.getByText(/Permanent: it is the Keycloak realm/)).toBeTruthy()
    expect(screen.getByText(/This one can be changed later/)).toBeTruthy()
  })

  it('the timezone starts from the browser\'s, so the usual case needs no typing', async () => {
    await nuovo()
    const tz = screen.getByLabelText(/Timezone/) as HTMLInputElement
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  })

  it('Create stays disabled until there is a slug AND an administrator email', async () => {
    // Everything else has a sensible default; these two the server cannot
    // invent.
    const { user } = await nuovo()
    const create = screen.getByRole('button', { name: 'Create tenant' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    await user.type(screen.getByLabelText(/Slug/), 'acme')
    expect(create.disabled).toBe(true)
    await user.type(screen.getByLabelText(/email/), 'anna@acme.example')
    expect(create.disabled).toBe(false)
  })

  it('whitespace alone is not a slug', async () => {
    const { user } = await nuovo()
    await user.type(screen.getByLabelText(/Slug/), '   ')
    await user.type(screen.getByLabelText(/email/), '   ')
    expect((screen.getByRole('button', { name: 'Create tenant' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends every field, then shows the one-time password and reloads', async () => {
    const { user } = await nuovo()
    await user.type(screen.getByLabelText(/Slug/), 'acme')
    await user.type(screen.getByLabelText(/Display name/), 'Acme')
    await user.selectOptions(screen.getByLabelText(/Plan/), 'pro')
    await user.type(screen.getByLabelText(/email/), 'anna@acme.example')
    await user.type(screen.getByLabelText(/First name/), 'Anna')
    await user.type(screen.getByLabelText(/Last name/), 'Rossi')

    api.create.mockResolvedValue({ slug: 'acme', temporaryPassword: 'Tmp-1!', steps: ['realm', 'admin'] })
    api.tenants.mockResolvedValue({ tenants: [tenant()] })
    await user.click(screen.getByRole('button', { name: 'Create tenant' }))

    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'acme', name: 'Acme', plan: 'pro',
      adminEmail: 'anna@acme.example', adminFirstName: 'Anna', adminLastName: 'Rossi',
    }))
    expect(await screen.findByText('Tmp-1!')).toBeTruthy()
    expect(screen.getByText(/shown once/)).toBeTruthy()
  })

  it('a creation with no password (an existing realm) shows no password panel', async () => {
    const { user } = await nuovo()
    await user.type(screen.getByLabelText(/Slug/), 'acme')
    await user.type(screen.getByLabelText(/email/), 'anna@acme.example')
    api.create.mockResolvedValue({ slug: 'acme', temporaryPassword: null, steps: [] })
    await user.click(screen.getByRole('button', { name: 'Create tenant' }))
    expect((await screen.findByRole('status')).textContent).toContain('created')
    expect(screen.queryByText(/shown once/)).toBeNull()
  })

  it('a refused creation is announced and the form stays filled in', async () => {
    // Retyping seven fields because the slug was taken is the kind of thing
    // that makes somebody stop using a tool.
    const { user } = await nuovo()
    await user.type(screen.getByLabelText(/Slug/), 'acme')
    await user.type(screen.getByLabelText(/email/), 'anna@acme.example')
    api.create.mockRejectedValue(new Error('That slug is already in use'))
    await user.click(screen.getByRole('button', { name: 'Create tenant' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That slug is already in use')
    expect((screen.getByLabelText(/Slug/) as HTMLInputElement).value).toBe('acme')
  })

  it('Cancel closes the form and creates nothing', async () => {
    const { user } = await nuovo()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'New tenant' })).toBeNull()
    expect(api.create).not.toHaveBeenCalled()
  })
})

describe('the one-time password panel', () => {
  async function conPassword() {
    const { user } = await draw([])
    await user.click(screen.getByRole('button', { name: /New tenant/ }))
    await user.type(screen.getByLabelText(/Slug/), 'acme')
    await user.type(screen.getByLabelText(/email/), 'anna@acme.example')
    api.create.mockResolvedValue({ slug: 'acme', temporaryPassword: 'Tmp-1!', steps: [] })
    await user.click(screen.getByRole('button', { name: 'Create tenant' }))
    await screen.findByText('Tmp-1!')
    return { user }
  }

  it('copies the password and says it did', async () => {
    // `userEvent.setup()` installa la sua clipboard finta su `navigator`: si
    // spia quella, invece di sostituirla (sovrascriverla rompe l'utente).
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const { user } = await conPassword()
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('Tmp-1!')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('closes only when somebody says they have it: this is the only place it appears', async () => {
    // It is stored nowhere and cannot be shown again, so it must not vanish
    // on its own or when the list reloads.
    const { user } = await conPassword()
    expect(screen.getByText('Tmp-1!')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'I have it' }))
    expect(screen.queryByText('Tmp-1!')).toBeNull()
  })
})
