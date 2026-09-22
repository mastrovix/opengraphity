/**
 * The generic validators behind half the API's mutations.
 *
 * These are the error messages users meet most often, and each one carries an
 * i18n key the client uses to render it in the reader's language. If a
 * validator stops rejecting bad input, junk (a 5-field cron that is not a cron,
 * a javascript: URL) lands in the graph; if it throws the wrong key, the user
 * sees a misleading message ("not a valid URL" for a URL that is merely ftp).
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  validateStringLength,
  validateCronExpression,
  validateUrl,
  validateEmail,
  validateEnum,
} from '../validation.js'
import { ValidationError } from '../errors.js'

/** Runs fn and returns the thrown ValidationError (fails if none is thrown). */
function caught(fn: () => void): GraphQLError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    return e as GraphQLError
  }
  throw new Error('expected a ValidationError')
}

describe('validateStringLength', () => {
  it('treats null and undefined as "not provided", not as too short', () => {
    expect(() => validateStringLength(null, 'title', 3, 10)).not.toThrow()
    expect(() => validateStringLength(undefined, 'title', 3, 10)).not.toThrow()
  })

  it('accepts both inclusive bounds', () => {
    expect(() => validateStringLength('abc', 'title', 3, 5)).not.toThrow()
    expect(() => validateStringLength('abcde', 'title', 3, 5)).not.toThrow()
  })

  it('rejects a value below min with the tooShort key and the field name', () => {
    const e = caught(() => validateStringLength('ab', 'title', 3, 5))
    expect(e.message).toBe('title must be at least 3 characters')
    expect(e.extensions).toEqual({
      code: 'BAD_USER_INPUT',
      i18n: { key: 'errors.validation.tooShort', params: { field: 'title', min: 3 } },
    })
  })

  it('rejects a value above max with the tooLong key', () => {
    const e = caught(() => validateStringLength('abcdef', 'title', 3, 5))
    expect(e.message).toBe('title must be at most 5 characters')
    expect(e.extensions?.i18n).toEqual({ key: 'errors.validation.tooLong', params: { field: 'title', max: 5 } })
  })
})

describe('validateCronExpression', () => {
  it('skips an empty schedule (the field is optional)', () => {
    expect(() => validateCronExpression(null)).not.toThrow()
    expect(() => validateCronExpression(undefined)).not.toThrow()
    expect(() => validateCronExpression('')).not.toThrow()
  })

  it.each(['* * * * *', '*/5 0-6 1,15 * 1-5', '  0 3 * * 0  '])('accepts %j', (cron) => {
    expect(() => validateCronExpression(cron)).not.toThrow()
  })

  it.each(['* * * *', '* * * * * *', 'every day', '0 3 * * MON'])('rejects %j with the cron key', (cron) => {
    const e = caught(() => validateCronExpression(cron))
    expect(e.extensions?.i18n).toEqual({ key: 'errors.validation.cron', params: { cron } })
  })
})

describe('validateUrl', () => {
  it('skips an empty value', () => {
    expect(() => validateUrl(null)).not.toThrow()
    expect(() => validateUrl('')).not.toThrow()
  })

  it('accepts http and https', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow()
    expect(() => validateUrl('https://example.com/path?q=1')).not.toThrow()
  })

  it('rejects a malformed URL with the url key and the default field name', () => {
    const e = caught(() => validateUrl('not a url'))
    expect(e.message).toBe('URL is not a valid URL')
    expect(e.extensions?.i18n).toEqual({ key: 'errors.validation.url', params: { field: 'URL' } })
  })

  // Regression: the protocol error used to be thrown inside the try and then
  // swallowed by the catch, so a well-formed ftp:// or javascript: URL was
  // reported as malformed and the urlProtocol key never reached the client.
  it.each(['ftp://example.com', 'javascript:alert(1)'])('rejects %j with the urlProtocol key, not "invalid URL"', (url) => {
    const e = caught(() => validateUrl(url, 'Webhook'))
    expect(e.message).toBe('Webhook must use http or https protocol')
    expect(e.extensions?.i18n).toEqual({ key: 'errors.validation.urlProtocol', params: { field: 'Webhook' } })
  })
})

describe('validateEmail', () => {
  it('skips an empty value', () => {
    expect(() => validateEmail(undefined)).not.toThrow()
  })

  it('accepts a plain address', () => {
    expect(() => validateEmail('mario.rossi@example.it')).not.toThrow()
  })

  it.each(['mario', 'mario@', 'mario@example', 'ma rio@example.it'])('rejects %j with the email key', (email) => {
    const e = caught(() => validateEmail(email))
    expect(e.extensions?.i18n).toEqual({ key: 'errors.validation.email', params: { email } })
  })
})

describe('validateEnum', () => {
  const ALLOWED = ['low', 'medium', 'high'] as const

  it('skips null/undefined', () => {
    expect(() => validateEnum(null, ALLOWED, 'priority')).not.toThrow()
    expect(() => validateEnum(undefined, ALLOWED, 'priority')).not.toThrow()
  })

  it('accepts a listed value', () => {
    expect(() => validateEnum('medium', ALLOWED, 'priority')).not.toThrow()
  })

  it('rejects an unlisted value and tells the client which values are allowed', () => {
    const e = caught(() => validateEnum('urgent' as 'low', ALLOWED, 'priority'))
    expect(e.message).toBe('priority must be one of: low, medium, high. Got: "urgent"')
    expect(e.extensions?.i18n).toEqual({
      key: 'errors.validation.enum',
      params: { field: 'priority', allowed: 'low, medium, high', value: 'urgent' },
    })
  })
})
