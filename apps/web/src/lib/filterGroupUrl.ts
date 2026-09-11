/**
 * Gruppo del costruttore di filtri (FilterBuilder) dentro e fuori dall'URL.
 *
 * Le liste che mandano il gruppo al server lo serializzano già con
 * `JSON.stringify(group)` (`filters: String` di `allCIs`, `auditLog`,
 * `inboundWebhooks`…). Nell'URL lo stesso JSON è scomodo da leggere e pieno di
 * caratteri da codificare: qui viaggia in base64url dentro `?f=`, così un
 * collegamento condiviso porta con sé anche il filtro avanzato (D·1.7, C-15).
 *
 * Fail-loud: un `?f=` illeggibile (troncato dall'incollaggio, scritto a mano,
 * di una versione più vecchia) NON viene ignorato in silenzio — mostrerebbe
 * più righe di quante il collegamento prometteva. `decodeFilterGroup`
 * distingue i tre casi: assente (`null`), valido (il gruppo), rotto
 * (`'invalid'`), e la pagina lo dice.
 */
import type { FilterGroup, FilterOperator, FilterRule } from '@/components/FilterBuilder'

/** Il parametro dell'URL, corto perché sta nella barra degli indirizzi accanto agli altri filtri. */
export const FILTER_GROUP_PARAM = 'f'

/**
 * Tutti gli operatori del costruttore. È un `Record` e non un `Set` perché il
 * compilatore obbliga a completarlo quando `FilterOperator` cresce: un
 * operatore nuovo e dimenticato qui renderebbe illeggibili i link che lo usano.
 */
const OPERATORS: Record<FilterOperator, true> = {
  contains: true, starts_with: true, ends_with: true, equals: true, not_equals: true,
  is_empty: true, is_not_empty: true,
  after: true, before: true, between: true, today: true, last_7_days: true, last_30_days: true,
  in: true, not_in: true,
}

const isOperator = (v: unknown): v is FilterOperator => typeof v === 'string' && Object.hasOwn(OPERATORS, v)

function isRule(v: unknown): v is FilterRule {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'] === '') return false
  if (typeof r['field'] !== 'string' || r['field'] === '') return false
  if (!isOperator(r['operator'])) return false
  if (r['logic'] !== 'AND' && r['logic'] !== 'OR') return false
  if (r['value2'] !== undefined && typeof r['value2'] !== 'string') return false
  const value = r['value']
  if (value === null || typeof value === 'string') return true
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}

// ── base64url: l'URL non deve portare `+`, `/` né `=` da ricodificare ────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Il gruppo come valore di `?f=`; null quando non c'è nulla da mettere nell'URL. */
export function encodeFilterGroup(group: FilterGroup | null): string | null {
  if (group === null || group.rules.length === 0) return null
  return toBase64Url(JSON.stringify(group))
}

/**
 * Il gruppo letto da `?f=`. `null` = parametro assente (nessun filtro
 * avanzato); `'invalid'` = presente ma illeggibile, e chi chiama DEVE dirlo:
 * non è la stessa cosa di «nessun filtro».
 */
export function decodeFilterGroup(raw: string | null): FilterGroup | null | 'invalid' {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(raw))
  } catch {
    return 'invalid'
  }
  if (parsed === null || typeof parsed !== 'object') return 'invalid'
  const rules = (parsed as Record<string, unknown>)['rules']
  if (!Array.isArray(rules) || rules.length === 0 || !rules.every(isRule)) return 'invalid'
  return { rules }
}
