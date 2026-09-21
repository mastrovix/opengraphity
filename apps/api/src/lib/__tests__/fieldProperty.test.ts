/**
 * Un campo che l'API espone con un nome e il grafo salva con un altro
 * (giro nel browser del 14 set 2026).
 *
 * L'incident espone `priority`, ma la priorità derivata si salva in `severity`
 * (lib/mappers.ts: `priority: props['severity']`). Filtri avanzati e widget
 * leggevano `i.priority`, che non esiste: «Priority = medium» dava zero
 * incident, e il widget raggruppava tutto sotto «N/A».
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAdvancedWhere } from '../filterBuilder.js'
import { FIELD_PROPERTY_ALIASES, propertyForField } from '../fieldProperty.js'

describe('propertyForField', () => {
  it('incident.priority vive in severity; gli altri campi restano in snake_case', () => {
    expect(propertyForField('Incident', 'priority')).toBe('severity')
    expect(propertyForField('Incident', 'createdAt')).toBe('created_at')
    expect(propertyForField('Problem', 'priority')).toBe('priority')
  })

  it('la tabella dice la stessa cosa del mapper dell\'incident', () => {
    const mappers = readFileSync(join(import.meta.dirname, '..', 'mappers.ts'), 'utf8')
    for (const [field, prop] of Object.entries(FIELD_PROPERTY_ALIASES['Incident'] ?? {})) {
      expect(mappers).toMatch(new RegExp(`${field}:\\s*props\\['${prop}'\\]`))
    }
  })
})

describe('buildAdvancedWhere con gli alias', () => {
  it('Priority = medium sugli incident filtra i.severity', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(JSON.stringify({ rules: [{ field: 'priority', operator: 'equals', value: 'medium', logic: 'AND' }] }),
      params, new Set(['priority']), 'i', {}, 'Incident')
    expect(where).toContain('i.severity = $af_0')
    expect(params).toEqual({ af_0: 'medium' })
  })
})
