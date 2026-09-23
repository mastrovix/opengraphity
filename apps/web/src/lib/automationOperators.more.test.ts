/**
 * THE EVENTS OF AN AUTOMATION, AS A SENTENCE AND AS A MENU ENTRY.
 *
 * The preview says «When an Incident is created…» (a participle) and the
 * dropdown says «Created» (a menu entry): two sets of keys for the same
 * events, in one place, so that the trigger page and the business-rule page
 * cannot show them differently again. Every key must exist in the English
 * resources, and an event the client does not know is shown marked, and
 * reported — never dressed as another event.
 */
import { describe, it, expect, vi } from 'vitest'
import i18n from '@/i18n/i18n'
import { eventParticipleKey, eventOptionKey, EVENT_PARTICIPLE_KEYS, EVENT_OPTION_KEYS } from './automationOperators'

describe('eventParticipleKey and eventOptionKey', () => {
  it('every event has a sentence and a menu entry, both translated', () => {
    for (const event of Object.keys(EVENT_OPTION_KEYS)) {
      expect(i18n.exists(eventParticipleKey(event), { lng: 'en' })).toBe(true)
      expect(i18n.exists(eventOptionKey(event), { lng: 'en' })).toBe(true)
    }
    expect(Object.keys(EVENT_PARTICIPLE_KEYS).sort()).toEqual(Object.keys(EVENT_OPTION_KEYS).sort())
  })

  it('a timer reads as «created» in the sentence (it fires at creation) but as its own entry in the menu', () => {
    expect(eventParticipleKey('on_timer')).toBe(eventParticipleKey('on_create'))
    expect(eventOptionKey('on_timer')).not.toBe(eventOptionKey('on_create'))
  })

  it('an event the client does not know is marked and reported', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(eventParticipleKey('on_merge')).toBe('?on_merge')
    expect(eventOptionKey('on_merge')).toBe('?on_merge')
    expect(error).toHaveBeenCalledWith('[EVENT_PARTICIPLE_KEYS] unknown value: "on_merge"')
    expect(error).toHaveBeenCalledWith('[EVENT_OPTION_KEYS] unknown value: "on_merge"')
  })
})
