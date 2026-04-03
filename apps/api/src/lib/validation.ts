import { ValidationError } from './errors.js'

export function validateStringLength(
  value: string | null | undefined,
  fieldName: string,
  min: number,
  max: number,
): void {
  if (value == null) return
  if (value.length < min) {
    throw new ValidationError(`${fieldName} must be at least ${min} characters`)
  }
  if (value.length > max) {
    throw new ValidationError(`${fieldName} must be at most ${max} characters`)
  }
}

export function validateCronExpression(cron: string | null | undefined): void {
  if (!cron) return
  // 5-field cron: min hour dom month dow
  // Each field: number, *, range, step, list
  const CRON_RE = /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/
  if (!CRON_RE.test(cron.trim())) {
    throw new ValidationError(`Invalid cron expression: "${cron}". Expected 5 fields (min hour dom month dow)`)
  }
}

export function validateUrl(url: string | null | undefined, fieldName = 'URL'): void {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError(`${fieldName} must use http or https protocol`)
    }
  } catch {
    throw new ValidationError(`${fieldName} is not a valid URL`)
  }
}

export function validateEmail(email: string | null | undefined): void {
  if (!email) return
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError(`"${email}" is not a valid email address`)
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
    )
  }
}
