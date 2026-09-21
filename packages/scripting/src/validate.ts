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
/**
 * Il codice senza COMMENTI e senza STRINGHE (revisione totale · E-34).
 *
 * I controlli sono espressioni regolari sul testo, quindi uno script con il
 * commento «// import rules from the CMDB» veniva rifiutato come «Static
 * import statements are not allowed», e lo stesso valeva per una stringa che
 * conteneva «process.» o «eval(». Qui commenti e stringhe diventano spazi —
 * la lunghezza non cambia, quindi i messaggi restano sensati — e i controlli
 * guardano solo il codice vero. La sicurezza vera è la sandbox: questo è un
 * aiuto in scrittura, e deve smettere di dare falsi allarmi.
 */
export function codeWithoutCommentsAndStrings(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const two = code.slice(i, i + 2)
    if (two === '//') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (two === '/*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      out += code.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    const ch = code[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < code.length && code[j] !== ch) {
        if (code[j] === '\\') j += 1
        j += 1
      }
      const stop = Math.min(j + 1, code.length)
      out += code.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function validateScript(code: string): ValidationResult {
  const errors: string[] = []

  if (!code.trim()) {
    errors.push('Script must not be empty')
    return { valid: false, errors }
  }

  if (code.length > MAX_SCRIPT_LENGTH) {
    errors.push(`Script exceeds maximum length of ${MAX_SCRIPT_LENGTH} characters`)
  }

  // E-34: i pattern guardano il codice, non i commenti né le stringhe.
  const stripped = codeWithoutCommentsAndStrings(code)
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) {
      errors.push(reason)
    }
  }

  return { valid: errors.length === 0, errors }
}
