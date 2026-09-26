/**
 * THE TWO COLUMNS OF A DETAIL PAGE (D9, tour of 23 Sep 2026).
 *
 * Every detail page had its own inline grid: `'1fr 340px'` on incidents and
 * problems, `'1fr 300px'` on requests, `'1fr 360px'` on change tasks. A `1fr`
 * track has an automatic minimum — the widest thing in the column — so one
 * wide element (the monitoring alarms table of an incident) pushed the main
 * column to ~700px, and at a 1297px window with the sidebar open the side
 * column (workflow history, similar incidents) overflowed the page by 45px and
 * was cut off.
 *
 * The rule now lives in ONE place, the `.og-detail` class in `index.css`:
 * the main column is `minmax(0, 1fr)` — it shrinks, and wide content scrolls
 * inside its own container — and the side column keeps its width. Under 900px
 * the two columns stack, like `.og-split`. The guardian
 * `__tests__/detailLayout.test.ts` fails when a page writes its own
 * `'1fr NNNpx'` grid instead of using this component.
 *
 * The component only lays out: the two columns are its two children, in
 * reading order.
 *
 * `head` (26 Sep 2026): what sits above the main column only — the tabs of a
 * ticket. Inside the main column it pushed that column's first card down, and
 * the side column (the workflow history) no longer lined up with it. Above the
 * grid, as wide as the main column, both columns start at the same height.
 *
 * THE ROOM, NOT THE WINDOW (26 Sep 2026). The columns stacked under a 900px
 * WINDOW, which knows nothing of the 210px menu: at 918px the side column kept
 * its 340px and the main one was left 234px — the tabs cut, the fields of the
 * details clipped. The frame is a size container: under 800px of real room the
 * side column goes below the main one (see `.og-detail-frame` in index.css).
 */
import type { CSSProperties, ReactNode } from 'react'

export interface DetailLayoutProps {
  /** The two columns: main then side, or side then main with `sideFirst`. */
  children:   ReactNode
  /** Width of the fixed side column, in px. */
  sideWidth:  number
  /** The fixed column comes first: a list on the left, what it opens on the right. */
  sideFirst?: boolean
  /** Space between the columns, in px (default 24, from the class). */
  gap?:       number
  /** Above the main column only, so that both columns start level (the tabs of a ticket). */
  head?:      ReactNode
  style?:     CSSProperties
}

export function DetailLayout({ children, sideWidth, sideFirst = false, gap, style, head }: DetailLayoutProps) {
  const vars = {
    ['--og-detail-side' as string]: `${String(sideWidth)}px`,
    ...(gap === undefined ? {} : { ['--og-detail-gap' as string]: `${String(gap)}px` }),
  }
  const grid = (
    <div
      className={sideFirst ? 'og-detail og-detail-side-first' : 'og-detail'}
      data-testid="detail-layout"
      style={{ ...vars, ...(gap === undefined ? {} : { gap }), ...style }}
    >
      {children}
    </div>
  )
  return (
    <div className="og-detail-frame">
      {head !== undefined && (
        <div className={sideFirst ? 'og-detail-head og-detail-head-side-first' : 'og-detail-head'} data-testid="detail-layout-head" style={vars}>
          {head}
        </div>
      )}
      {grid}
    </div>
  )
}
