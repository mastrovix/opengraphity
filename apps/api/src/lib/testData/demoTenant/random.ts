/**
 * THE DEMO TENANT'S RANDOMNESS, REPRODUCIBLE (23 Sep 2026).
 *
 * A demo tenant is generated from a seed: the same seed gives the same people,
 * the same CMDB and the same ticket histories, so a defect seen in a demo can
 * be generated again and looked at. `Math.random()` cannot do that, and
 * neither can `uuid` v4, which reads the system's entropy.
 *
 * Every stage of the generator takes its own stream with `fork(label)`: adding
 * a field to the users does not shift every random number the incidents draw
 * afterwards, which would silently turn a small change into a different tenant.
 */

/** cyrb128: a 128-bit hash of a string, the four words that seed sfc32. */
function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(readonly seed: string) {
    ;[this.a, this.b, this.c, this.d] = hash128(seed)
  }

  /** A new, independent stream: the same (seed, label) always gives the same one. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`)
  }

  /** sfc32: uniform in [0, 1). */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0
    const t = (this.a + this.b) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.d = (this.d + 1) | 0
    const r = (t + this.d) | 0
    this.c = (this.c + r) | 0
    return (r >>> 0) / 4294967296
  }

  /** An integer in [min, max], both included. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Rng.int: invalid range [${String(min)}, ${String(max)}]`)
    }
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** A number in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list')
    return items[Math.floor(this.next() * items.length)]!
  }

  /** One value, with the probability of its weight among all weights. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0)
    if (!(total > 0)) throw new Error('Rng.weighted: the weights must add up to more than 0')
    let x = this.next() * total
    for (const [value, weight] of entries) {
      x -= weight
      if (x < 0) return value
    }
    return entries[entries.length - 1]![0]
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }

  /** `count` distinct items (all of them when the list is shorter). */
  sample<T>(items: readonly T[], count: number): T[] {
    if (count >= items.length) return this.shuffle(items)
    const picked = new Set<number>()
    while (picked.size < count) picked.add(Math.floor(this.next() * items.length))
    return [...picked].map((i) => items[i]!)
  }

  /**
   * A positive duration with a long tail, like the time people take: most
   * tickets close in hours, a few take weeks. Log-normal around `median`.
   */
  logNormal(median: number, spread: number): number {
    // Box-Muller: a standard normal from two uniforms.
    const u1 = Math.max(this.next(), Number.EPSILON)
    const u2 = this.next()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return median * Math.exp(spread * z)
  }

  /** A version 4 UUID drawn from this stream, so it is reproducible too. */
  uuid(): string {
    const hex: string[] = []
    for (let i = 0; i < 16; i++) hex.push(Math.floor(this.next() * 256).toString(16).padStart(2, '0'))
    hex[6] = ((parseInt(hex[6]!, 16) & 0x0f) | 0x40).toString(16).padStart(2, '0')
    hex[8] = ((parseInt(hex[8]!, 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
    const h = hex.join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  /** Exactly round(n × share) `true`s among n, in random order: a share that holds at any size. */
  exactFlags(n: number, share: number): boolean[] {
    const k = Math.round(n * share)
    return this.shuffle(Array.from({ length: n }, (_, i) => i < k))
  }
}
