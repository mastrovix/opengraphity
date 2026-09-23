/**
 * A VALUE WITHOUT A LABEL, SHOWN THE WAY A PERSON WROTE IT (D29, tour of 23 Sep 2026).
 *
 * When a vocabulary value has no label in the Dictionary, the product shows
 * the value itself — and five copies of the same rule turned it into Title
 * Case: `in_progress` → «In Progress», which is fine, but also «Pick up at the
 * IT desk» → «Pick Up At The IT Desk», which is not. A customer who writes a
 * value as a sentence has already chosen how it reads.
 *
 * The rule, in one place for web, portal and the catalog form:
 *  - a value that contains spaces is shown AS IT IS;
 *  - a machine key — lowercase snake_case, or UPPER_SNAKE with at least one
 *    underscore (a relation type: `HOSTED_ON`) — becomes a sentence:
 *    `in_progress` → «In progress», `HOSTED_ON` → «Hosted on»;
 *  - anything else (`DatabaseInstance`, `IT`, `e-mail`) is shown as it is:
 *    guessing where the words start would be inventing.
 *
 * The Dictionary label, when there is one, always wins: this is only what is
 * shown when there is none.
 */

const LOWER_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const UPPER_KEY = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/

export function humanizeValue(value: string): string {
  if (/\s/.test(value)) return value
  if (!LOWER_KEY.test(value) && !UPPER_KEY.test(value)) return value
  const words = value.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The label of an option that came from the API (`FormField.options`, the
 * columns of a table field). The API's own fallback follows the rule above
 * (`humanizeValue` in apps/api/src/lib/enumValueLabels.ts), so a label that
 * arrives is shown as it is; an option without one is the value, humanized.
 */
export function optionLabel(value: string, label: string | null | undefined): string {
  if (label === null || label === undefined || label === '') return humanizeValue(value)
  return label
}
