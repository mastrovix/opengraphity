/**
 * I validatori generici — e ognuno porta la sua CHIAVE.
 *
 * Questi messaggi sono quelli che un utente vede piu spesso di tutti: li
 * alzano le mutation di mezza API. Erano inglesi, che e giusto per i log e per
 * chi chiama l'API da fuori, e restavano inglesi anche a chi guarda
 * l'interfaccia in italiano. Ora il messaggio resta inglese (stabile) e la
 * chiave dice al client come scriverlo nella lingua di chi legge.
 */
import { ValidationError } from './errors.js'

export function validateStringLength(
  value: string | null | undefined,
  fieldName: string,
  min: number,
  max: number,
): void {
  if (value == null) return
  if (value.length < min) {
    throw new ValidationError(`${fieldName} must be at least ${min} characters`, { key: 'errors.validation.tooShort', params: { field: fieldName, min } })
  }
  if (value.length > max) {
    throw new ValidationError(`${fieldName} must be at most ${max} characters`, { key: 'errors.validation.tooLong', params: { field: fieldName, max } })
  }
}

export function validateCronExpression(cron: string | null | undefined): void {
  if (!cron) return
  // 5-field cron: min hour dom month dow
  // Each field: number, *, range, step, list
  const CRON_RE = /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/
  if (!CRON_RE.test(cron.trim())) {
    throw new ValidationError(`Invalid cron expression: "${cron}". Expected 5 fields (min hour dom month dow)`, { key: 'errors.validation.cron', params: { cron } })
  }
}

export function validateUrl(url: string | null | undefined, fieldName = 'URL'): void {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError(`${fieldName} must use http or https protocol`, { key: 'errors.validation.urlProtocol', params: { field: fieldName } })
    }
  } catch {
    throw new ValidationError(`${fieldName} is not a valid URL`, { key: 'errors.validation.url', params: { field: fieldName } })
  }
}

export function validateEmail(email: string | null | undefined): void {
  if (!email) return
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError(`"${email}" is not a valid email address`, { key: 'errors.validation.email', params: { email } })
  }
}

export function validateEnum<T extends string>(
  value: T | null | undefined,
  allowed: readonly T[],
  fieldName: string,
): void {
  if (value == null) return
  if (!allowed.includes(value)) {
    throw new ValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}. Got: "${value}"`,
      { key: 'errors.validation.enum', params: { field: fieldName, allowed: allowed.join(', '), value } },
    )
  }
}
