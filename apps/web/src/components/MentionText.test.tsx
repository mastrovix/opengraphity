/**
 * MentionText turns the stored mention markup `@[Name](userId)` of a comment
 * into a readable badge. If it regresses, every comment with a mention shows
 * the raw markup (brackets and user ids) to the reader, or silently drops the
 * words around the mention.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MentionText } from './MentionText'

describe('MentionText', () => {
  it('renders plain text untouched when there is no mention', () => {
    const { container } = render(<MentionText text="just a note" />)
    expect(container.textContent).toBe('just a note')
  })

  it('replaces each mention with a badge showing the name, keeping the text around it', () => {
    const { container } = render(<MentionText text="hi @[Ann Lee](u-1) and @[Bob](u-2)!" />)
    // The reader sees names, never the markup or the user id.
    expect(container.textContent).toBe('hi Ann Lee and Bob!')
    // The id stays reachable on hover: it is what disambiguates two people with the same name.
    expect(screen.getByText('Ann Lee')).toHaveAttribute('title', 'u-1')
    expect(screen.getByText('Bob')).toHaveAttribute('title', 'u-2')
  })

  it('handles a mention at the very start and end, and renders the same text twice in a row', () => {
    // The regex is global and module-level: without resetting lastIndex the
    // second render would start mid-string and lose the first mention.
    const { container, rerender } = render(<MentionText text="@[Ann](u-1)" />)
    expect(container.textContent).toBe('Ann')
    rerender(<MentionText text="@[Ann](u-1)" />)
    expect(container.textContent).toBe('Ann')
    expect(screen.getByText('Ann')).toHaveAttribute('title', 'u-1')
  })

  it('leaves malformed markup as plain text', () => {
    const { container } = render(<MentionText text="@[Ann] (u-1)" />)
    expect(container.textContent).toBe('@[Ann] (u-1)')
  })
})
