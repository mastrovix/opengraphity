/**
 * RESOLVING WHILE THE ALARM STILL FIRES (tour of 23 Sep 2026): the resolve
 * dialog names the correlated alarms that are still firing. It is a warning,
 * not a block.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import type { EventRow } from '@/types/events'
import { FiringAlarmsWarning } from './FiringAlarmsWarning'

const alarm = (id: string, status: string, title = `Alarm ${id}`, ci: EventRow['ci'] = null): EventRow =>
  ({ id, status, title, ci } as unknown as EventRow)

describe('FiringAlarmsWarning', () => {
  it('no alarm still firing: nothing to say', () => {
    const { container } = renderWithProviders(<FiringAlarmsWarning events={[alarm('a', 'resolved'), alarm('b', 'suppressed')]} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('one firing alarm: named, with its CI', () => {
    renderWithProviders(<FiringAlarmsWarning events={[alarm('a', 'firing', 'CPU high', { id: 'ci-1', name: 'web-01', type: 'server', status: 'active', health: 'down' } as EventRow['ci']), alarm('b', 'resolved')]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The monitoring alarm «CPU high» (web-01) is still firing. You can resolve anyway, but the problem may not be over.')
  })

  it('many firing alarms: the first three named, the others counted', () => {
    renderWithProviders(<FiringAlarmsWarning events={['a', 'b', 'c', 'd', 'e'].map((id) => alarm(id, 'firing'))} />)
    expect(screen.getByRole('alert')).toHaveTextContent('5 monitoring alarms are still firing: «Alarm a», «Alarm b», «Alarm c» and 2 more.')
  })
})

describe('the incident detail wires it into the resolve dialog', () => {
  it('shown for a transition towards a step of category «resolved», with the alarms the page already loaded', async () => {
    // The page is too large to mount here with its fifteen queries: the wiring is pinned on its source.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'IncidentDetailPage.tsx'), 'utf8')
    expect(src).toMatch(/incidentStepCategory\(pendingTransition\.toStep\) === 'resolved' && <FiringAlarmsWarning events=\{incident\.correlatedEvents\} \/>/)
  })
})
