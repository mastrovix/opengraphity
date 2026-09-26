/**
 * THE ROW OPENS ITS ITEM (26 Sep 2026, the owner: «perché alcune tabelle hanno
 * i link?» → «riga cliccabile»).
 *
 * In a table the row itself opens what it shows, as in the incident and change
 * lists: its name is not drawn as a link. Where a hand-made table keeps a
 * `<Link>` on the name, it is there for the keyboard (D·3.2: a focusable <tr>
 * cannot say it is a link) and to open in a new tab — so it stays an anchor
 * but looks like the text around it. A link to SOMETHING ELSE in the row (the
 * CI of an alarm, a related item) is a real link and stays underlined.
 */
import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** The link on the row's own name: an anchor for the keyboard, plain text to the eye. */
export function RowLink({ to, title, state, children }: { to: string; title?: string; state?: unknown; children: ReactNode }) {
  return (
    <Link to={to} title={title} state={state} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>
      {children}
    </Link>
  )
}

/**
 * The props of a hand-made row that opens its item on click. A click on a
 * control inside the row (button, link, field) belongs to the control, as in
 * SortableFilterTable. No tabIndex: the keyboard goes to the RowLink.
 */
export function rowOpens(open: () => void) {
  return {
    onClick: (e: MouseEvent<HTMLElement>) => {
      const control = (e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="switch"]')
      if (control && e.currentTarget.contains(control)) return
      open()
    },
    // The same stripe as every row that opens something (index.css `.row-opens`).
    className: 'row-opens',
    style: { cursor: 'pointer' } as const,
  }
}
