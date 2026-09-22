/**
 * THE OUTBOUND URL GUARD — the one piece of SSRF protection shared by
 * apps/api, @opengraphity/workflow and @opengraphity/notifications.
 *
 * Every webhook, every Slack/Teams integration and every monitoring connector
 * in the product goes through here, with a URL a *customer administrator*
 * typed. If it lets `http://169.254.169.254/` through, a tenant can read the
 * cloud metadata service — credentials included — from inside our network.
 *
 * So the tests below are not about coverage: each one is an address family a
 * real attacker would try. The notations matter as much as the ranges —
 * `2130706433`, `0177.0.0.1`, `::ffff:127.0.0.1` and `2002:7f00:1::` are all
 * 127.0.0.1 wearing a different hat, and a guard that only knows the dotted
 * form is not a guard.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  assertSafeOutboundUrl, assertSafeOutboundUrlSync, isBlockedIpAddress,
  httpsRequiredByPolicy, loggableUrl, expandV6, UnsafeUrlError, type ResolvedAddress,
} from '../safeUrl.js'

const originalEnv = process.env['NODE_ENV']
afterEach(() => { process.env['NODE_ENV'] = originalEnv })

/** A public literal: no DNS needed, and it must always pass. */
const PUBLIC = 'https://93.184.216.34/hook'
/** Resolver stub: the hostname always resolves to these addresses. */
const resolvesTo = (...addresses: string[]) =>
  async (): Promise<ResolvedAddress[]> => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('isBlockedIpAddress — IPv4 ranges', () => {
  it.each([
    ['0.0.0.0',         'binds to every local interface'],
    ['10.0.0.1',        'private'],
    ['100.64.0.1',      'CGNAT / shared address space'],
    ['127.0.0.1',       'loopback'],
    ['169.254.169.254', 'link-local — the cloud metadata service'],
    ['172.16.0.1',      'private'],
    ['172.31.255.255',  'private, last address of the range'],
    ['192.0.0.1',       'IETF protocol assignments'],
    ['192.0.2.1',       'TEST-NET-1'],
    ['192.168.1.1',     'private'],
    ['198.18.0.1',      'benchmarking'],
    ['198.51.100.1',    'TEST-NET-2'],
    ['203.0.113.1',     'TEST-NET-3'],
    ['224.0.0.1',       'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('%s is blocked (%s)', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true)
  })

  it.each([
    ['93.184.216.34',  'a plain public address'],
    ['8.8.8.8',        'a public resolver'],
    ['172.15.0.1',     'just BELOW the private 172.16/12 block'],
    ['172.32.0.1',     'just ABOVE it'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.1',    'just above CGNAT'],
    ['192.0.1.1',      'between two blocked /24s'],
  ])('%s is allowed (%s)', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false)
  })

  it('anything that is not an IP literal is refused, never guessed', () => {
    // `isBlockedIpAddress` answers about LITERALS. A hostname must go through
    // DNS resolution instead — answering "not blocked" here would make a
    // caller skip that step.
    for (const notAnIp of ['example.com', '', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'not an ip']) {
      expect(isBlockedIpAddress(notAnIp)).toBe(true)
    }
  })
})

describe('isBlockedIpAddress — IPv6, including the v4 disguises', () => {
  it.each([
    ['::',                      'unspecified'],
    ['::1',                     'loopback'],
    ['fc00::1',                 'unique-local'],
    ['fd12:3456::1',            'unique-local, the fd half of fc00::/7'],
    ['fe80::1',                 'link-local'],
    ['ff02::1',                 'multicast'],
    ['::ffff:127.0.0.1',        'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254',  'IPv4-mapped metadata service'],
    ['::127.0.0.1',             'IPv4-compatible (deprecated) loopback'],
    ['64:ff9b::127.0.0.1',      'NAT64 wrapping loopback'],
    ['2002:7f00:1::',           '6to4 wrapping 127.0.0.1'],
  ])('%s is blocked (%s)', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true)
  })

  it.each([
    ['2001:4860:4860::8888', 'a public address'],
    ['::ffff:93.184.216.34', 'IPv4-mapped PUBLIC address: the wrapper is not the problem, the range is'],
    ['64:ff9b::93.184.216.34', 'NAT64 wrapping a public address'],
    ['2002:5db8:d822::',     '6to4 wrapping a public address'],
  ])('%s is allowed (%s)', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false)
  })

  it('a malformed IPv6 literal is REFUSED, not guessed at', () => {
    // These never reach `expandV6` through a URL (the parser rejects them
    // first), but the function is exported and called directly elsewhere:
    // an unparsable literal must fail closed.
    for (const bad of ['1::2::3', '::ffff:999.1.1.1', 'gggg::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9']) {
      expect(isBlockedIpAddress(bad)).toBe(true)
    }
  })
})

describe('assertSafeOutboundUrlSync — scheme, credentials, host', () => {
  it('a public https URL passes and comes back parsed', () => {
    expect(assertSafeOutboundUrlSync(PUBLIC).hostname).toBe('93.184.216.34')
  })

  it('an empty or non-string URL is refused before anything else', () => {
    for (const empty of ['', '   ', null as never, undefined as never, 42 as never]) {
      expect(() => assertSafeOutboundUrlSync(empty)).toThrow('Outbound URL is empty')
    }
  })

  it('something that is not an absolute URL is refused naming what was passed', () => {
    expect(() => assertSafeOutboundUrlSync('/webhooks/incident')).toThrow(/not a valid absolute URL: \/webhooks\/incident/)
  })

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'javascript:alert(1)'])(
    '%s is refused: only http and https are allowed', (url) => {
      expect(() => assertSafeOutboundUrlSync(url)).toThrow(/is not allowed \(only http\/https\)/)
    })

  it('plain http is refused by default and allowed in development, and the message says which NODE_ENV decided', () => {
    process.env['NODE_ENV'] = 'production'
    expect(() => assertSafeOutboundUrlSync('http://93.184.216.34/x')).toThrow(/must use https \(NODE_ENV=production\)/)
    process.env['NODE_ENV'] = 'development'
    expect(assertSafeOutboundUrlSync('http://93.184.216.34/x').protocol).toBe('http:')
  })

  it('requireHttps passed explicitly wins over the environment, both ways', () => {
    // The policy point is one (`httpsRequiredByPolicy`), but a caller that
    // knows better — a test, a self-hosted integration — states it.
    process.env['NODE_ENV'] = 'development'
    expect(() => assertSafeOutboundUrlSync('http://93.184.216.34/x', { requireHttps: true })).toThrow(/must use https/)
    process.env['NODE_ENV'] = 'production'
    expect(assertSafeOutboundUrlSync('http://93.184.216.34/x', { requireHttps: false }).protocol).toBe('http:')
  })

  it('httpsRequiredByPolicy is false only in development', () => {
    process.env['NODE_ENV'] = 'development'
    expect(httpsRequiredByPolicy()).toBe(false)
    for (const env of ['production', 'test', undefined]) {
      if (env === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = env
      expect(httpsRequiredByPolicy()).toBe(true)
    }
  })

  it('credentials embedded in the URL are refused, and the message does not echo them', () => {
    // The message is logged: repeating `user:password@` there would move the
    // secret from the configuration into the log files.
    for (const url of ['https://user:pass@93.184.216.34/x', 'https://user@93.184.216.34/x']) {
      const err = (() => { try { assertSafeOutboundUrlSync(url) } catch (e) { return e as Error } })()!
      expect(err.message).toContain('must not embed credentials')
      expect(err.message).not.toContain('pass')
      expect(err.message).not.toContain('user')
    }
  })

  it('localhost and any *.localhost subdomain are refused without asking DNS', () => {
    for (const host of ['localhost', 'api.localhost', 'c-test.localhost']) {
      expect(() => assertSafeOutboundUrlSync(`https://${host}/x`)).toThrow(`Outbound URL host "${host}" is not allowed (loopback)`)
    }
  })

  it('the host is compared in lower case: LOCALHOST is localhost', () => {
    expect(() => assertSafeOutboundUrlSync('https://LOCALHOST/x')).toThrow(/is not allowed \(loopback\)/)
  })

  it.each([
    ['https://127.0.0.1/x',        'dotted loopback'],
    ['https://2130706433/x',       'decimal notation of 127.0.0.1'],
    ['https://0177.0.0.1/x',       'octal notation'],
    ['https://0x7f.1/x',           'hex shorthand'],
    ['https://169.254.169.254/x',  'the metadata service'],
    ['https://[::1]/x',            'bracketed IPv6 loopback'],
    ['https://[::ffff:127.0.0.1]/x', 'bracketed IPv4-mapped loopback'],
  ])('%s is blocked (%s)', (url) => {
    expect(() => assertSafeOutboundUrlSync(url)).toThrow(/private\/loopback\/link-local address — blocked \(SSRF\)/)
  })

  it('the error is an UnsafeUrlError carrying a stable code', () => {
    // apps/api catches it and wraps it into a GraphQL ValidationError: it
    // matches on the code, not on the message.
    const err = (() => { try { assertSafeOutboundUrlSync('https://127.0.0.1/x') } catch (e) { return e as UnsafeUrlError } })()!
    expect(err).toBeInstanceOf(UnsafeUrlError)
    expect(err.name).toBe('UnsafeUrlError')
    expect(err.code).toBe('UNSAFE_URL')
  })
})

describe('assertSafeOutboundUrl — DNS resolution', () => {
  it('a hostname resolving to public addresses passes', async () => {
    await expect(assertSafeOutboundUrl('https://hooks.example.com/x', { lookup: resolvesTo('93.184.216.34') })).resolves.toBeInstanceOf(URL)
  })

  it('a hostname resolving to a private address is blocked, and the message names the address', async () => {
    // This is DNS rebinding in its simplest form: a name the customer
    // controls, pointed at our own network.
    await expect(assertSafeOutboundUrl('https://evil.example.com/x', { lookup: resolvesTo('10.0.0.5') }))
      .rejects.toThrow('resolves to 10.0.0.5, a private/loopback/link-local address — blocked (SSRF)')
  })

  it('EVERY resolved address must pass, not just the first', async () => {
    // A name can answer with several A records; checking only the first
    // leaves the hole wide open for whoever controls the zone.
    await expect(assertSafeOutboundUrl('https://both.example.com/x', { lookup: resolvesTo('93.184.216.34', '169.254.169.254') }))
      .rejects.toThrow(/resolves to 169\.254\.169\.254/)
  })

  it('a hostname that does not resolve is an error, with the resolver reason', async () => {
    const lookup = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    await expect(assertSafeOutboundUrl('https://nowhere.example.com/x', { lookup }))
      .rejects.toThrow('does not resolve: getaddrinfo ENOTFOUND')
  })

  it('a resolver rejection that is not an Error is still readable', async () => {
    const lookup = async () => { throw 'resolver gone' }
    await expect(assertSafeOutboundUrl('https://nowhere.example.com/x', { lookup })).rejects.toThrow('does not resolve: resolver gone')
  })

  it('a hostname resolving to nothing is an error, not a silent pass', async () => {
    await expect(assertSafeOutboundUrl('https://empty.example.com/x', { lookup: resolvesTo() }))
      .rejects.toThrow('resolved to no addresses')
  })

  it('a literal IP skips DNS entirely: it was already validated', async () => {
    const lookup = async () => { throw new Error('the resolver must not be called') }
    await expect(assertSafeOutboundUrl(PUBLIC, { lookup })).resolves.toBeInstanceOf(URL)
    await expect(assertSafeOutboundUrl('https://[2001:4860:4860::8888]/x', { lookup })).resolves.toBeInstanceOf(URL)
  })

  it('the sync rules run FIRST: a blocked scheme never reaches the resolver', async () => {
    const lookup = async () => { throw new Error('the resolver must not be called') }
    await expect(assertSafeOutboundUrl('file:///etc/passwd', { lookup })).rejects.toThrow(/only http\/https/)
  })
})

describe('loggableUrl — what may end up in the logs', () => {
  it('keeps host and port and drops path, query and fragment', () => {
    // Slack and Teams carry the token IN THE PATH: logging the full URL would
    // publish a customer's webhook secret to anyone who can read the logs.
    expect(loggableUrl('https://hooks.slack.com/services/T000/B000/XXXXsecret')).toBe('hooks.slack.com')
    expect(loggableUrl('https://example.com:8443/a/b?token=abc#frag')).toBe('example.com:8443')
  })

  it('an unparsable URL yields a placeholder instead of throwing inside a log line', () => {
    expect(loggableUrl('not a url')).toBe('<invalid-url>')
  })
})

/**
 * THE IPv6 PARSER, DIRECTLY.
 *
 * Through `isBlockedIpAddress` this function only ever sees literals
 * `net.isIP` already accepted, so its rejection paths — the ones that decide
 * whether a malformed address fails open or closed — were never exercised.
 * They must all fail CLOSED: `isBlockedV6` reads a `null` as "refuse", and an
 * expansion that quietly returned a wrong group array would hand a blocked
 * range a way through.
 */
describe('expandV6 — the rejection paths of the address parser', () => {
  it('expands the forms that are valid', () => {
    expect(expandV6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandV6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
    expect(expandV6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(expandV6('fe80::')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 0])
  })

  it('an embedded IPv4 tail becomes the last two groups', () => {
    expect(expandV6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(expandV6('64:ff9b::93.184.216.34')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x5db8, 0xd822])
  })

  it.each([
    ['1::2::3',            'two "::" — the expansion would be ambiguous'],
    ['1:2:3:4:5:6:7',      'seven groups and no "::" to fill the gap'],
    ['1:2:3:4:5:6:7:8:9',  'nine groups'],
    ['1:2:3:4:5:6:7:8::',  '"::" with nothing left to expand'],
    ['gggg::1',            'a group that is not hexadecimal'],
    ['12345::1',           'a group longer than four hex digits'],
    ['::ffff:999.1.1.1',   'an IPv4 tail with a byte over 255'],
    ['::ffff:1.2.3',       'an IPv4 tail with too few parts'],
    ['::ffff:1.2.3.4.5',   'an IPv4 tail with too many parts'],
    ['::ffff:1.2.3.0x4',   'an IPv4 tail part that is not decimal'],
  ])('%s is refused (%s)', (bad) => {
    expect(expandV6(bad)).toBeNull()
    // …and refusing it means the address is treated as blocked, never as safe.
    expect(isBlockedIpAddress(bad)).toBe(true)
  })
})

describe('assertSafeOutboundUrl — the real resolver', () => {
  it('with no lookup override it goes through DNS, and a name that cannot resolve says so', async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it never resolves: this
    // exercises the default resolver without depending on anybody's zone.
    await expect(assertSafeOutboundUrl('https://opengraphity-does-not-exist.invalid/x'))
      .rejects.toThrow(/does not resolve:/)
  })
})
