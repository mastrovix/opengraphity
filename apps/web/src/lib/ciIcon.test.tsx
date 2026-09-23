/**
 * The icon of a CI type in the lists. An icon key comes from the data (the API
 * accepts any string on createCIType/updateCIType): a key the registry does
 * not have is drawn as the red «?», never as another icon and never as a crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { CIIcon } from './ciIcon'
import { BROKEN_ICON_COLOR } from './ciIconPaths'

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

const strokeOf = (icon: string) => render(<CIIcon icon={icon} />).container.querySelector('svg')!.getAttribute('stroke')

describe('CIIcon', () => {
  it('a known icon is drawn in the colour it is given', () => {
    expect(strokeOf('database')).toBe('currentColor')
  })

  it('an unknown icon is the red «?»', () => {
    expect(strokeOf('rocket')).toBe(BROKEN_ICON_COLOR)
  })

  // 23 Sep 2026: `icon in CI_ICON_PATHS` was true for what every object
  // inherits, and the lookup returned Object's function: the list crashed.
  it.each(['constructor', 'toString', '__proto__'])('a key every object inherits (%s) is the red «?», not a crash', (icon) => {
    expect(strokeOf(icon)).toBe(BROKEN_ICON_COLOR)
  })
})
