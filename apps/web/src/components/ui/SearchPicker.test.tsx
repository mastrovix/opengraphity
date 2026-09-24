/**
 * THE SEARCHABLE PICKER (D10 / D21 / D34): a choice among hundreds is typed,
 * not scrolled, and the names are never cut.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchPicker, matchOptions, type PickerOption, listPlacement } from './SearchPicker'

const TEAMS: PickerOption[] = [
  { id: 't1', label: 'SUP_Network EMEA' },
  { id: 't2', label: 'SUP_Database Platform North America (Contoso Consulting)', detail: 'Support' },
  { id: 't3', label: 'SUP_Storage APAC' },
]

/** The picker as a page uses it: the page owns the value. */
function Harness(props: Partial<React.ComponentProps<typeof SearchPicker>> & { onPicked?: (o: PickerOption | null) => void }) {
  const [value, setValue] = useState<PickerOption | null>(props.value ?? null)
  return (
    <SearchPicker
      label="Team"
      options={props.options ?? TEAMS}
      value={value}
      onChange={(o) => { setValue(o); props.onPicked?.(o) }}
      {...(props.clearLabel ? { clearLabel: props.clearLabel } : {})}
      {...(props.maxResults ? { maxResults: props.maxResults } : {})}
      {...(props.loading ? { loading: true } : {})}
      {...(props.error ? { error: props.error } : {})}
      {...(props.hint ? { hint: props.hint } : {})}
      {...(props.invalid ? { invalid: true } : {})}
    />
  )
}

const box = () => screen.getByRole('combobox', { name: 'Team' })
const optionNames = () => within(screen.getByRole('listbox', { name: 'Team' })).queryAllByRole('option').map((o) => o.textContent)

describe('matchOptions', () => {
  it('matches the label and the second line, ignoring case, and caps the list', () => {
    expect(matchOptions(TEAMS, 'network', 10).shown.map((o) => o.id)).toEqual(['t1'])
    expect(matchOptions(TEAMS, 'SUPPORT', 10).shown.map((o) => o.id)).toEqual(['t2'])
    expect(matchOptions(TEAMS, '', 2)).toEqual({ shown: TEAMS.slice(0, 2), more: 1 })
    expect(matchOptions(TEAMS, '  apac ', 10).shown.map((o) => o.id)).toEqual(['t3'])
  })
})

describe('SearchPicker', () => {
  it('opens on focus with every choice, full names included, and filters as one types', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(box())
    expect(box()).toHaveAttribute('aria-expanded', 'true')
    expect(optionNames()).toEqual(['SUP_Network EMEA', 'SUP_Database Platform North America (Contoso Consulting)Support', 'SUP_Storage APAC'])
    await user.type(box(), 'stor')
    expect(optionNames()).toEqual(['SUP_Storage APAC'])
  })

  it('a click on a name chooses it; closed, the box shows the choice in full', async () => {
    const user = userEvent.setup()
    const onPicked = vi.fn()
    render(<Harness onPicked={onPicked} />)
    await user.click(box())
    await user.click(screen.getByRole('option', { name: /Database Platform/ }))
    expect(onPicked).toHaveBeenCalledWith(TEAMS[1])
    expect(box()).toHaveAttribute('aria-expanded', 'false')
    expect(box()).toHaveValue('SUP_Database Platform North America (Contoso Consulting)')
    expect(box()).toHaveAttribute('title', 'SUP_Database Platform North America (Contoso Consulting)')
  })

  it('keyboard: arrows move, Enter chooses, Escape closes without choosing', async () => {
    const user = userEvent.setup()
    const onPicked = vi.fn()
    render(<Harness onPicked={onPicked} />)
    await user.click(box())
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onPicked).toHaveBeenCalledWith(TEAMS[0])
    await user.click(box())
    await user.keyboard('{Escape}')
    expect(box()).toHaveAttribute('aria-expanded', 'false')
    expect(onPicked).toHaveBeenCalledTimes(1)
  })

  it('Enter with nothing active does not choose, and does not submit the form around it', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const onPicked = vi.fn()
    render(<form onSubmit={onSubmit}><Harness onPicked={onPicked} /></form>)
    await user.click(box())
    await user.keyboard('{Enter}')
    expect(onPicked).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('the «empty» choice comes first when offered, and chooses null', async () => {
    const user = userEvent.setup()
    const onPicked = vi.fn()
    render(<Harness clearLabel="— not assigned —" value={TEAMS[0]!} onPicked={onPicked} />)
    await user.click(box())
    expect(optionNames()[0]).toBe('— not assigned —')
    // The current choice is marked as selected.
    expect(screen.getByRole('option', { name: 'SUP_Network EMEA' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('option', { name: '— not assigned —' }))
    expect(onPicked).toHaveBeenCalledWith(null)
    expect(box()).toHaveValue('')
  })

  it('says how many more there are when the list is capped, and when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Harness maxResults={1} />)
    await user.click(box())
    expect(screen.getByText('2 more: type to narrow down.')).toBeInTheDocument()
    await user.type(box(), 'zzz')
    expect(screen.getByText('Nothing matches «zzz».')).toBeInTheDocument()
  })

  it('an empty list of choices says so', async () => {
    const user = userEvent.setup()
    render(<Harness options={[]} />)
    await user.click(box())
    expect(screen.getByText('There is nothing to choose.')).toBeInTheDocument()
  })

  it('while loading it says so, and a load failure is shown instead of an empty list', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness options={[]} loading />)
    await user.click(box())
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    unmount()
    render(<Harness options={[]} error="teams down" />)
    await user.click(box())
    expect(screen.getByText('The choices could not be loaded: teams down')).toBeInTheDocument()
    expect(screen.queryByText('There is nothing to choose.')).not.toBeInTheDocument()
  })

  it('shows the hint under the box and marks a missing required choice', () => {
    render(<Harness hint="Support teams only." invalid />)
    expect(screen.getByText('Support teams only.')).toBeInTheDocument()
    expect(box()).toHaveAttribute('aria-invalid', 'true')
  })

  it('a disabled picker does not open', async () => {
    const user = userEvent.setup()
    render(<SearchPicker label="Team" options={TEAMS} value={null} onChange={vi.fn()} disabled />)
    await user.click(box())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

/** Tour of 24 Sep 2026 (G36): the list of teams ran under the bottom edge of a dialog. */
describe('where the list opens', () => {
  it('below when it fits, above when there is more room above, never taller than the room', () => {
    // 600 px of room below: below, full height.
    expect(listPlacement({ top: 100, bottom: 130 }, { top: 0, bottom: 730 })).toEqual({ up: false, maxHeight: 280 })
    // Near the bottom of a dialog: 60 px below, 400 above → above, full height.
    expect(listPlacement({ top: 470, bottom: 500 }, { top: 60, bottom: 568 })).toEqual({ up: true, maxHeight: 280 })
    // Little room either way: the larger side, with its height, never below 120.
    expect(listPlacement({ top: 200, bottom: 230 }, { top: 60, bottom: 400 })).toEqual({ up: false, maxHeight: 162 })
    expect(listPlacement({ top: 90, bottom: 120 }, { top: 60, bottom: 180 })).toEqual({ up: false, maxHeight: 120 })
  })
})
