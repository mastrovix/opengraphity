/**
 * «This AI feature is turned off for your organization».
 *
 * Why it matters: a greyed-out AI button with no explanation looks broken.
 * The notice must name the feature and tell the reader who can turn it back
 * on: an admin gets the link straight to the AI tab of the Organization page,
 * everyone else is told to ask an admin (a link they could not open would be
 * a dead end).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, renderHook } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import i18n from '@/i18n/i18n'
import { AIDisabledNotice, useAIDisabledText } from './AIDisabledNotice'

const perms = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }) }))

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const featureName = T('pages.organization.aiFeature.triage')

beforeEach(() => { perms.list = [] })

describe('AIDisabledNotice', () => {
  it('an admin gets the link to the AI tab of the Organization page', () => {
    perms.list = ['config.organization']
    renderWithProviders(<AIDisabledNotice feature="triage" />)
    const notice = screen.getByTestId('ai-disabled-triage')
    expect(notice).toHaveTextContent(featureName)
    expect(screen.getByRole('link', { name: T('components.aiDisabled.adminLink') })).toHaveAttribute('href', '/settings/organization?tab=ai')
  })

  it('anyone else is told to ask an admin, with no link', () => {
    renderWithProviders(<AIDisabledNotice feature="triage" />)
    expect(screen.getByRole('status')).toHaveTextContent(T('components.aiDisabled.askAdmin'))
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('useAIDisabledText', () => {
  it('the short text for a disabled button follows the same rule', () => {
    perms.list = ['config.organization']
    expect(renderHook(() => useAIDisabledText('triage')).result.current).toBe(T('components.aiDisabled.adminShort', { feature: featureName }))
    perms.list = []
    expect(renderHook(() => useAIDisabledText('triage')).result.current).toBe(T('components.aiDisabled.userShort', { feature: featureName }))
  })
})
