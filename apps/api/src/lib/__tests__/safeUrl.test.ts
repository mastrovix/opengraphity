/**
 * SSRF guard contract (packages/events/src/safeUrl.ts via lib/safeUrl.ts).
 * Table of good/bad URLs incl. odd notations the WHATWG parser canonicalises.
 */
import { describe, it, expect } from 'vitest'
import { assertSafeOutboundUrl, assertSafeOutboundUrlSync } from '../safeUrl.js'
import { ValidationError } from '../errors.js'
import { isBlockedIpAddress, loggableUrl } from '@opengraphity/events'

const DEV = { requireHttps: false }

describe('assertSafeOutboundUrlSync — accepted', () => {
  it.each([
    'https://hooks.slack.com/services/T000/B000/xxx',
    'https://example.com:8443/path?x=1',
    'https://8.8.8.8/dns',
    'https://[2001:4860:4860::8888]/v6',
    'https://1.1.1.1',
  ])('accepts %s', (url) => {
    expect(assertSafeOutboundUrlSync(url).href).toBe(new URL(url).href)
  })

  it('accepts plain http when https is not required (development)', () => {
    expect(assertSafeOutboundUrlSync('http://example.com/hook', DEV).protocol).toBe('http:')
  })
})

describe('assertSafeOutboundUrlSync — rejected', () => {
  it.each([
    ['', /empty/],
    ['not a url', /not a valid absolute URL/],
    ['ftp://example.com/x', /scheme "ftp:"/],
    ['file:///etc/passwd', /scheme "file:"/],
    ['javascript:alert(1)', /scheme/],
    ['http://example.com/x', /must use https/],                 // https required by default (NODE_ENV=test)
    ['https://user:pw@example.com/x', /credentials/],
    ['https://localhost/x', /loopback/],
    ['https://LOCALHOST:8080/x', /loopback/],
    ['https://api.localhost/x', /loopback/],
    ['https://127.0.0.1/x', /SSRF/],
    ['https://127.1/x', /SSRF/],                                 // shorthand → 127.0.0.1
    ['https://2130706433/x', /SSRF/],                            // decimal → 127.0.0.1
    ['https://0x7f000001/x', /SSRF/],                            // hex → 127.0.0.1
    ['https://0177.0.0.1/x', /SSRF/],                            // octal → 127.0.0.1
    ['https://0.0.0.0/x', /SSRF/],
    ['https://10.0.0.5/x', /SSRF/],
    ['https://172.16.0.1/x', /SSRF/],
    ['https://172.31.255.255/x', /SSRF/],
    ['https://192.168.1.1/x', /SSRF/],
    ['https://169.254.169.254/latest/meta-data', /SSRF/],
    ['https://100.64.0.1/x', /SSRF/],                            // CGNAT
    ['https://100.127.255.254/x', /SSRF/],
    ['https://224.0.0.1/x', /SSRF/],                             // multicast
    ['https://255.255.255.255/x', /SSRF/],
    ['https://[::1]/x', /SSRF/],
    ['https://[::]/x', /SSRF/],
    ['https://[fc00::1]/x', /SSRF/],
    ['https://[fd12:3456::1]/x', /SSRF/],
    ['https://[fe80::1]/x', /SSRF/],
    ['https://[::ffff:127.0.0.1]/x', /SSRF/],                    // IPv4-mapped
    ['https://[::ffff:7f00:1]/x', /SSRF/],
    ['https://[::ffff:10.0.0.1]/x', /SSRF/],
    ['https://[64:ff9b::a00:1]/x', /SSRF/],                      // NAT64 → 10.0.0.1
    ['https://[2002:7f00:1::1]/x', /SSRF/],                      // 6to4 → 127.0.0.1
  ])('rejects %s', (url, msg) => {
    expect(() => assertSafeOutboundUrlSync(url)).toThrow(ValidationError)
    expect(() => assertSafeOutboundUrlSync(url)).toThrow(msg)
  })

  it('does not accept 172.32.x (outside 172.16/12)', () => {
    expect(assertSafeOutboundUrlSync('https://172.32.0.1/x').hostname).toBe('172.32.0.1')
  })
})

describe('assertSafeOutboundUrl — DNS resolution', () => {
  it('accepts a host resolving only to public addresses', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]
    const u = await assertSafeOutboundUrl('https://example.com/hook', { lookup })
    expect(u.hostname).toBe('example.com')
  })

  it('rejects when ANY resolved address is private (DNS rebinding / split horizon)', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]
    await expect(assertSafeOutboundUrl('https://evil.example/hook', { lookup })).rejects.toThrow(/resolves to 10\.0\.0\.7/)
    await expect(assertSafeOutboundUrl('https://evil.example/hook', { lookup })).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an IPv4-mapped IPv6 answer', async () => {
    const lookup = async () => [{ address: '::ffff:169.254.169.254', family: 6 }]
    await expect(assertSafeOutboundUrl('https://meta.example/', { lookup })).rejects.toThrow(/SSRF/)
  })

  it('rejects a host that does not resolve (fail-loud, not a fetch ENOTFOUND later)', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND') }
    await expect(assertSafeOutboundUrl('https://nope.invalid/', { lookup })).rejects.toThrow(/does not resolve/)
  })

  it('rejects an empty resolution', async () => {
    await expect(assertSafeOutboundUrl('https://empty.example/', { lookup: async () => [] })).rejects.toThrow(/no addresses/)
  })

  it('does not call DNS for IP literals', async () => {
    let called = false
    const lookup = async () => { called = true; return [] }
    await assertSafeOutboundUrl('https://8.8.8.8/', { lookup })
    expect(called).toBe(false)
  })

  it('runs the sync rules first (private literal never reaches DNS)', async () => {
    let called = false
    const lookup = async () => { called = true; return [] }
    await expect(assertSafeOutboundUrl('https://192.168.0.1/', { lookup })).rejects.toThrow(/SSRF/)
    expect(called).toBe(false)
  })
})

describe('isBlockedIpAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.1.1'])('blocks %s', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true)
  })
  it.each(['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false)
  })
  it('treats a non-IP string as blocked (never guess)', () => {
    expect(isBlockedIpAddress('example.com')).toBe(true)
  })
})

describe('loggableUrl', () => {
  it('keeps only host[:port] — Slack/Teams tokens live in the path', () => {
    expect(loggableUrl('https://hooks.slack.com/services/T0/B0/SECRET')).toBe('hooks.slack.com')
    expect(loggableUrl('https://h.example:8443/x?token=1')).toBe('h.example:8443')
    expect(loggableUrl('garbage')).toBe('<invalid-url>')
  })
})
