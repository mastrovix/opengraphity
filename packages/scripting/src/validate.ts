export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Patterns forbidden in user scripts.
 * isolated-vm already prevents access to Node.js globals at runtime,
 * but static rejection provides early feedback and prevents script storage.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bprocess\s*\./,
    reason:  'Access to "process" is not allowed',
  },
  {
    pattern: /\brequire\s*\(/,
    reason:  'require() is not available in the sandbox',
  },
  {
    pattern: /\bimport\s*\(/,
    reason:  'Dynamic import() is not allowed in scripts',
  },
  {
    pattern: /\bimport\s+/,
    reason:  'Static import statements are not allowed in scripts',
  },
  {
    pattern: /\beval\s*\(/,
    reason:  'eval() is not allowed in scripts',
  },
  {
    pattern: /\bnew\s+Function\s*\(/,
    reason:  'new Function() is not allowed in scripts',
  },
  {
    pattern: /\b__dirname\b|\b__filename\b/,
    reason:  '__dirname and __filename are not available in the sandbox',
  },
  {
    pattern: /\bglobalThis\s*\./,
    reason:  'Direct access to globalThis is not allowed',
  },
  {
    pattern: /while\s*\(\s*true\s*\)|for\s*\(\s*;;\s*\)/,
    reason:  'Infinite loops are not allowed (use the timeout instead)',
  },
]

/** Maximum script length in characters. */
const MAX_SCRIPT_LENGTH = 50_000

/**
 * Statically validates a user script before storing or executing it.
 * This is a best-effort check — the sandbox enforces the real security
 * boundary at runtime.
 */
export function validateScript(code: string): ValidationResult {
  const errors: string[] = []

  if (!code.trim()) {
    errors.push('Script must not be empty')
    return { valid: false, errors }
  }

  if (code.length > MAX_SCRIPT_LENGTH) {
    errors.push(`Script exceeds maximum length of ${MAX_SCRIPT_LENGTH} characters`)
  }

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(reason)
    }
  }

  return { valid: errors.length === 0, errors }
}
