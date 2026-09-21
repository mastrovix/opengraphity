/**
 * Verifica «Cosa resta cablato», ondata 6: numerazione, allegati e AI si
 * scelgono dalla pagina Organizzazione, con le stesse regole dell'API.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_AI_SETTINGS, GET_ATTACHMENT_POLICY } from '@/graphql/queries'
import { SET_AI_SETTINGS, SET_ATTACHMENT_POLICY } from '@/graphql/mutations'
import { numberingProblem } from './TicketNumberingSection'
import { AISection } from './AISection'
import { AttachmentPolicySection } from './AttachmentPolicySection'

describe('numberingProblem', () => {
  const draft = (over: Record<string, { prefix: string; digits: string }> = {}) => ({
    incident: { prefix: 'INC', digits: '8' }, problem: { prefix: 'PRB', digits: '8' },
    change: { prefix: 'CHG', digits: '8' }, serviceRequest: { prefix: 'REQ', digits: '8' }, ...over,
  })
  it('le regole dell\'API, prima di salvare', () => {
    expect(numberingProblem(draft())).toBeNull()
    expect(numberingProblem(draft({ incident: { prefix: 'TKT-', digits: '6' } }))).toBeNull()
    expect(numberingProblem(draft({ incident: { prefix: 'inc', digits: '8' } }))).toBe('pages.organization.numberingPrefixInvalid')
    expect(numberingProblem(draft({ incident: { prefix: 'INC', digits: '2' } }))).toBe('pages.organization.numberingDigitsInvalid')
    expect(numberingProblem(draft({ problem: { prefix: 'INCX', digits: '8' } }))).toBe('pages.organization.numberingOverlap')
  })
})

const FEATURES = { __typename: 'AIFeatureSwitches', triage: true, assistant: true, reportAnalysis: true, postIncident: true, kbArticles: true, embeddings: true }

describe('AISection', () => {
  it('spegnere una funzione e salvare manda tutte le scelte', async () => {
    const saved = { ...FEATURES, embeddings: false }
    const sent = vi.fn(() => ({ data: { setAISettings: { __typename: 'AISettings', features: saved, clusterMinSimilarity: 0.72, clusterMinSize: 3, platformConfigured: true, isDefault: false } } }))
    const mocks: GqlMock[] = [
      { request: { query: GET_AI_SETTINGS }, result: { data: { aiSettings: { __typename: 'AISettings', features: FEATURES, clusterMinSimilarity: 0.72, clusterMinSize: 3, platformConfigured: true, isDefault: false } } }, maxUsageCount: Number.POSITIVE_INFINITY },
      {
        request: { query: SET_AI_SETTINGS, variables: { input: { features: { triage: true, assistant: true, reportAnalysis: true, postIncident: true, kbArticles: true, embeddings: false }, clusterMinSimilarity: 0.72, clusterMinSize: 3 } } },
        result: sent,
      },
    ]
    const { user } = renderWithProviders(<AISection />, { mocks })
    const toggle = await screen.findByRole('switch', { name: 'Similarity (embeddings)' })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.click(toggle)
    expect(save).toBeEnabled()
    await user.click(save)
    // La mutation con quelle variabili ha risposto (una variabile diversa non troverebbe il doppio).
    await waitFor(() => expect(sent).toHaveBeenCalled())
  })
})

describe('AttachmentPolicySection', () => {
  it('i tipi si scelgono dal catalogo della piattaforma; senza tipi non si salva', async () => {
    const policy = { __typename: 'AttachmentPolicy', maxSizeMb: 10, extensions: ['pdf'], platformMaxSizeMb: 100, platformExtensions: ['pdf', 'pcap'], isDefault: false }
    const mocks: GqlMock[] = [
      { request: { query: GET_ATTACHMENT_POLICY }, result: { data: { attachmentPolicy: policy } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: SET_ATTACHMENT_POLICY, variables: { input: { maxSizeMb: 10, extensions: ['pdf', 'pcap'] } } }, result: { data: { setAttachmentPolicy: { ...policy, extensions: ['pdf', 'pcap'] } } } },
    ]
    const { user } = renderWithProviders(<AttachmentPolicySection />, { mocks })
    const pdf = await screen.findByRole('button', { name: '.pdf' })
    await user.click(pdf)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(pdf)
    await user.click(screen.getByRole('button', { name: '.pcap' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '.pcap' })).toHaveAttribute('aria-pressed', 'true'))
  })
})
