/**
 * Le etichette per lingua di passi e transizioni (vedi `LocalizedLabels`).
 * Sul grafo stanno come JSON in `labels` (Neo4j non ha mappe annidate come
 * proprietà); qui la lettura, fail-loud su un valore corrotto.
 */
/** Etichette per lingua, `{ it: 'Nuovo' }`, accanto a un'etichetta di base. */
export type LocalizedLabels = Readonly<Record<string, string>>

export interface LocalizedLabel { language: string; label: string }

export function parseLocalizedLabels(raw: unknown, where: string): LocalizedLabel[] {
  if (raw == null || raw === '') return []
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch (e) {
      throw new Error(`${where}: labels is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${where}: labels must be an object { language: label }`)
  }
  return Object.entries(parsed as Record<string, unknown>).map(([language, label]) => {
    if (typeof label !== 'string' || label === '') throw new Error(`${where}: the ${language} label is not a non-empty string`)
    return { language, label }
  })
}

/** Per la scrittura: `null` quando non ci sono traduzioni. */
export function serializeLocalizedLabels(labels: LocalizedLabels | undefined): string | null {
  return labels && Object.keys(labels).length > 0 ? JSON.stringify(labels) : null
}

/** L'etichetta nella lingua chiesta, altrimenti quella di base. */
export function localizedLabel(base: string, labels: readonly LocalizedLabel[], language: string | null | undefined): string {
  return (language && labels.find((l) => l.language === language)?.label) || base
}
