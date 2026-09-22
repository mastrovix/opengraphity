/**
 * The fields that SLA policies and OLA/UC contracts share: how time counts,
 * and the compliance target with its attention threshold.
 *
 * Why these behaviours matter: an SLA that counts time on the wrong calendar
 * breaches (or never breaches) for reasons nobody can see. So the selector
 * must start with NO choice (a policy used to be born "in business hours"
 * without anyone deciding it), must offer 24×7 plus every named calendar of
 * the organisation, and must hand back exactly what was chosen. The two
 * compliance boxes must report which of the two values changed, or the report
 * would colour attainment against the wrong threshold.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { screen, fireEvent } from '@testing-library/react'
import { ALWAYS_ON, ComplianceFields, TimeCountingField } from './ServiceTargetFields'
import { GET_SERVICE_CALENDARS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const calendar = (id: string, name: string) => ({
  __typename: 'ServiceCalendar', id, name, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [],
  usedBySlaPolicies: 0, usedByOlaContracts: 0, usedByWorkflowSteps: 0,
})

const calendarsMock = (list: ReturnType<typeof calendar>[]): GqlMock => ({
  request: { query: GET_SERVICE_CALENDARS },
  result: { data: { serviceCalendars: list } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function TimeCountingHarness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState('')
  return <TimeCountingField id="tc" value={value} onChange={(v) => { setValue(v); onChange(v) }} />
}

describe('TimeCountingField', () => {
  it('starts with no choice, then offers 24×7 and every named calendar and returns the choice', async () => {
    const onChange = vi.fn()
    const { user } = renderWithProviders(<TimeCountingHarness onChange={onChange} />, {
      mocks: [calendarsMock([calendar('cal-it', 'Italy office'), calendar('cal-us', 'US support')])],
    })
    const select = screen.getByLabelText('Time counts *')
    // No pre-selected way of counting time: the admin has to decide it.
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: '— Choose how time counts —' })).toBeDisabled()

    expect(await screen.findByRole('option', { name: 'Calendar: US support' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '24×7' })).toHaveValue(ALWAYS_ON)

    await user.selectOptions(select, 'cal-us')
    expect(onChange).toHaveBeenLastCalledWith('cal-us')
    expect(select).toHaveValue('cal-us')
    await user.selectOptions(select, ALWAYS_ON)
    expect(onChange).toHaveBeenLastCalledWith(ALWAYS_ON)
  })

  it('points to where calendars are managed', () => {
    renderWithProviders(<TimeCountingField id="tc" value="" onChange={() => {}} />, { mocks: [calendarsMock([])] })
    expect(screen.getByRole('link', { name: 'Manage calendars' })).toHaveAttribute('href', '/settings/organization')
    // With no calendar in the organisation, 24×7 is still a valid choice.
    expect(screen.getByRole('option', { name: '24×7' })).toBeInTheDocument()
  })
})

describe('ComplianceFields', () => {
  it('shows both values and reports which one changed', () => {
    const onChange = vi.fn()
    renderWithProviders(<ComplianceFields idPrefix="sla" target="99.5" warning="97" onChange={onChange} />)
    const target = screen.getByLabelText('Compliance target (%) *')
    const warning = screen.getByLabelText('Attention threshold (%) *')
    expect(target).toHaveValue(99.5)
    expect(warning).toHaveValue(97)

    fireEvent.change(target, { target: { value: '99.9' } })
    expect(onChange).toHaveBeenLastCalledWith({ complianceTarget: '99.9' })
    fireEvent.change(warning, { target: { value: '95' } })
    expect(onChange).toHaveBeenLastCalledWith({ complianceWarning: '95' })
    expect(screen.getByText(/green from the target, yellow from the threshold/)).toBeInTheDocument()
  })
})
