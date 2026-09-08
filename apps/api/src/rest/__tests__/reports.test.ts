import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import os from 'os'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}))

// reportExport creates REPORT_DIR at import time: keep test artefacts out of the repo.
process.env['REPORT_DIR'] = path.join(os.tmpdir(), 'opengraphity-reports-test')

const { resolveTenantReportFile } = await import('../reports.js')
const { tenantReportDir, REPORT_DIR } = await import('../../graphql/resolvers/reportExport.js')

describe('report download path resolution (A-11 / C-25)', () => {
  it('serves only from REPORT_DIR/<tenantId>/<uuid>.<ext>', () => {
    const fp = resolveTenantReportFile('tenant-a', '3f2b6a1e-1111-4222-8333-444455556666.pdf')
    expect(fp).toBe(path.join(REPORT_DIR, 'tenant-a', '3f2b6a1e-1111-4222-8333-444455556666.pdf'))
  })

  it('the same filename under another tenant resolves to a different directory', () => {
    const a = resolveTenantReportFile('tenant-a', 'abc.pdf')
    const b = resolveTenantReportFile('tenant-b', 'abc.pdf')
    expect(a).not.toBe(b)
    expect(a!.startsWith(path.join(REPORT_DIR, 'tenant-a'))).toBe(true)
  })

  it.each([
    '../other/abc.pdf',
    '..%2Fabc.pdf',
    'abc.pdf/../../x.pdf',
    'abc.exe',
    'abc',
    'ABC$.pdf',
    'a b.pdf',
    '',
  ])('rejects filename %j', (name) => {
    expect(resolveTenantReportFile('tenant-a', name)).toBeNull()
  })

  it('rejects a tenant id that is not a safe path segment', () => {
    for (const bad of ['../x', 'a/b', '..', '.', 'a b']) {
      let thrown: unknown
      try { tenantReportDir(bad) } catch (e) { thrown = e }
      expect(thrown, bad).toBeInstanceOf(GraphQLError)
    }
  })
})
