import { describe, it, expect } from 'vitest'
import { setupTopology } from '../topology.js'

/**
 * `setupTopology` is deliberately empty: BullMQ creates a queue on first use,
 * so there is no exchange/binding declaration to make any more (RabbitMQ is
 * gone). The function stays because boot code calls it, and because the day a
 * topology IS needed this is where it goes.
 *
 * The test pins the contract boot relies on: it resolves, and it does not
 * throw. A `setupTopology` that started throwing would take the API down at
 * startup for something nobody looks at.
 */
describe('setupTopology', () => {
  it('resolves without doing anything — BullMQ needs no declared topology', async () => {
    await expect(setupTopology()).resolves.toBeUndefined()
  })
})
