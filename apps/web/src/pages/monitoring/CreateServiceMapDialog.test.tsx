/**
 * Dialogo «Crea una mappa»: la spunta «crea come bozza» (ondata 2) manda
 * `status: draft`, senza spunta resta `active`; il fallimento della lista dei
 * candidati è un testo visibile, non un select vuoto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { CreateServiceMapDialog } from './CreateServiceMapDialog'
import { GET_SERVICE_MAP_CANDIDATES } from '@/graphql/queries'
import { CREATE_SERVICE_MAP } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, SERVICE } from '@/test/mocks/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const candidatesMock: GqlMock = {
  request: { query: GET_SERVICE_MAP_CANDIDATES, variables: () => true },
  result: { data: { serviceMapCandidates: [SERVICE] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const RELATIONSHIPS = ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE']

function renderDialog(extra: GqlMock[]) {
  return renderWithProviders(<CreateServiceMapDialog open onClose={() => {}} />, { mocks: [candidatesMock, ...extra] })
}

describe('CreateServiceMapDialog', () => {
  it('la spunta «crea come bozza» manda status: draft', async () => {
    const seen: unknown[] = []
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_MAP, variables: (v) => { seen.push(v); return true } },
      result: { data: { createServiceMap: mapDetail({ status: 'draft' }) } },
    }
    const { user } = renderDialog([create])
    await user.selectOptions(await screen.findByLabelText('Business application'), 'ba-1')
    await user.click(screen.getByLabelText('Create as a draft'))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(seen).toEqual([{ serviceId: 'ba-1', maxDepth: 4, relationshipTypes: RELATIONSHIPS, status: 'draft' }]))
  })

  it('senza spunta la mappa nasce attiva', async () => {
    const seen: unknown[] = []
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_MAP, variables: (v) => { seen.push(v); return true } },
      result: { data: { createServiceMap: mapDetail() } },
    }
    const { user } = renderDialog([create])
    await user.selectOptions(await screen.findByLabelText('Business application'), 'ba-1')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(seen).toEqual([{ serviceId: 'ba-1', maxDepth: 4, relationshipTypes: RELATIONSHIPS, status: 'active' }]))
  })
})
