/** The share on the CMDB Health cards: something found never reads 0%. */
import { describe, it, expect } from 'vitest'
import { sharePercent } from './sharePercent'

describe('sharePercent', () => {
  it('one decimal, in the product\'s language', () => {
    expect(sharePercent(271, 3000, 'en')).toBe('9')
    expect(sharePercent(1094, 1238, 'en')).toBe('88.4')
    expect(sharePercent(1094, 1238, 'it')).toBe('88,4')
  })

  it('something found that rounds to nothing reads «< 0.1», not 0', () => {
    expect(sharePercent(7, 21179, 'en')).toBe('< 0.1')
    expect(sharePercent(7, 21179, 'it')).toBe('< 0,1')
    expect(sharePercent(0, 21179, 'en')).toBe('0')
  })

  it('nothing looked at is 0, not a division by zero', () => {
    expect(sharePercent(0, 0, 'en')).toBe('0')
  })
})
