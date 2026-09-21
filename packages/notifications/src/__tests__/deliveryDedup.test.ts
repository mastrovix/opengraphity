/**
 * Revisione totale · E-3: il job delle notifiche viene ritentato 4 volte e il
 * dispatcher consegnava in-app, poi i canali, poi le e-mail. Se un canale a
 * valle lanciava, ogni tentativo rifaceva le consegne già andate a buon fine:
 * quattro notifiche in-app identiche nel pannello e quattro e-mail uguali.
 * La deduplica di `BaseConsumer` non aiuta: marca l'evento solo dopo il
 * successo di TUTTI i canali.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()
const exists = vi.fn(async (k: string) => (store.has(k) ? 1 : 0))
const set = vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' })
vi.mock('ioredis', () => ({ Redis: class { exists = exists; set = set; on() { return this } } }))
vi.mock('@opengraphity/events', () => ({ getRedisConnection: () => ({ host: 'localhost', port: 6379 }) }))

const { deliverOnce, alreadyDelivered, markDelivered, resetDeliveryDedup } = await import('../deliveryDedup.js')

beforeEach(() => { store.clear(); resetDeliveryDedup(); exists.mockClear(); set.mockClear() })

describe('deliverOnce', () => {
  it('la prima volta consegna e marca; la seconda no', async () => {
    const deliver = vi.fn()
    expect(await deliverOnce('ev-1', 'in_app', deliver)).toBe(true)
    expect(await deliverOnce('ev-1', 'in_app', deliver)).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('canali diversi dello stesso evento sono indipendenti: il ritentativo riprende dal canale fallito', async () => {
    const inApp = vi.fn()
    const email = vi.fn().mockRejectedValueOnce(new Error('Resend giù'))

    // Primo tentativo: in-app va, l'e-mail lancia → il job fallisce.
    await deliverOnce('ev-1', 'in_app', inApp)
    await expect(deliverOnce('ev-1', 'email', email)).rejects.toThrow('Resend giù')

    // Secondo tentativo: in-app NON si ripete, l'e-mail sì.
    expect(await deliverOnce('ev-1', 'in_app', inApp)).toBe(false)
    expect(await deliverOnce('ev-1', 'email', email)).toBe(true)
    expect(inApp).toHaveBeenCalledTimes(1)
    expect(email).toHaveBeenCalledTimes(2)
  })

  it('un canale che lancia non viene marcato', async () => {
    await expect(deliverOnce('ev-2', 'email', () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await alreadyDelivered('ev-2', 'email')).toBe(false)
  })

  it('senza id dell\'evento non si deduplica (e non si finge di farlo)', async () => {
    const deliver = vi.fn()
    expect(await deliverOnce(undefined, 'in_app', deliver)).toBe(true)
    expect(await deliverOnce(undefined, 'in_app', deliver)).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('il marcatore va su Redis con una scadenza, chiave per evento e canale', async () => {
    await markDelivered('ev-3', 'channels')
    expect(set).toHaveBeenCalledWith('notif:delivered:ev-3:channels', '1', 'EX', 24 * 3600)
  })

  it('Redis che lancia non blocca la consegna: resta il marcatore in memoria del processo', async () => {
    exists.mockRejectedValueOnce(new Error('redis down'))
    set.mockRejectedValueOnce(new Error('redis down'))
    const deliver = vi.fn()
    expect(await deliverOnce('ev-4', 'in_app', deliver)).toBe(true)
    expect(await deliverOnce('ev-4', 'in_app', deliver)).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
