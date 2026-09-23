/**
 * AN ADDRESS WITHOUT A ROW IN THE PERMISSION TABLE.
 *
 * A menu entry or a route whose page has no row must fail loudly, naming the
 * address — never open the page to everyone, nor hide it without a word.
 * The leading slash of a menu address is not part of the key.
 */
import { describe, it, expect } from 'vitest'
import { routePermissions } from './routePermissions'

describe('routePermissions', () => {
  it('reads the row of an address with or without its leading slash', () => {
    expect(routePermissions('/admin/audit')).toEqual(routePermissions('admin/audit'))
    expect(routePermissions('/admin/audit')).toEqual(['admin.audit'])
  })

  it('an address with no row is an error that names it', () => {
    expect(() => routePermissions('/admin/secret-page')).toThrow('[routePermissions] no permission rule for route "/admin/secret-page"')
  })
})
