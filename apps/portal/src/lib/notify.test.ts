import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifyError, notifyInfo } from './notify'

const host = () => document.getElementById('portal-error-host')
const banners = () => Array.from(host()?.children ?? []) as HTMLElement[]

let now = 1_000_000
beforeEach(() => {
  vi.useFakeTimers({ now })
  now += 60_000   // ogni test parte oltre la finestra di dedupe del precedente
})
afterEach(() => { vi.useRealTimers(); host()?.remove() })

describe('notifyError / notifyInfo', () => {
  it('crea l\'host una volta sola e un banner role=alert con il testo', () => {
    notifyError('Connection error')
    expect(host()).not.toBeNull()
    expect(banners()).toHaveLength(1)
    expect(banners()[0]).toHaveAttribute('role', 'alert')
    expect(banners()[0]).toHaveTextContent('Connection error')
    notifyError('Another')
    expect(document.querySelectorAll('#portal-error-host')).toHaveLength(1)
    expect(banners()).toHaveLength(2)
  })

  it('notifyInfo usa role=status', () => {
    notifyInfo('Session restored')
    expect(banners()[0]).toHaveAttribute('role', 'status')
  })

  it('lo stesso messaggio entro 5s è deduplicato; dopo la finestra riappare', () => {
    notifyError('Burst')
    notifyError('Burst')
    notifyError('Burst')
    expect(banners()).toHaveLength(1)
    vi.advanceTimersByTime(5_001)
    notifyError('Burst')
    expect(banners()).toHaveLength(2)
  })

  it('error e info con lo stesso testo NON si deduplicano a vicenda', () => {
    notifyError('Same')
    notifyInfo('Same')
    expect(banners()).toHaveLength(2)
  })

  it('il banner scompare da solo dopo 8s e al click', () => {
    notifyError('Auto')
    expect(banners()).toHaveLength(1)
    vi.advanceTimersByTime(8_000)
    expect(banners()).toHaveLength(0)

    notifyError('Clickable')
    banners()[0]!.click()
    expect(banners()).toHaveLength(0)
  })
})
