import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CI_ICON_PATHS, BROKEN_ICON_KEY, BROKEN_ICON_PATHS, BROKEN_ICON_COLOR,
  isBrokenIconKey, iconPathsOrError, normalizeTypeName, buildTypeIconMap, iconKeyForType,
} from './ciIconPaths'

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('registro icone', () => {
  it('ogni icona è una lista di nodi SVG con tag e attributi', () => {
    for (const [key, nodes] of Object.entries(CI_ICON_PATHS)) {
      expect(nodes.length, key).toBeGreaterThan(0)
      for (const [tag, attrs] of nodes) {
        expect(['path', 'circle', 'ellipse', 'rect', 'line']).toContain(tag)
        expect(Object.keys(attrs).length).toBeGreaterThan(0)
      }
    }
  })
  it('la chiave riservata __broken__ non è nel registro', () => {
    expect(isBrokenIconKey(BROKEN_ICON_KEY)).toBe(true)
    expect(isBrokenIconKey('box')).toBe(false)
    expect(CI_ICON_PATHS).not.toHaveProperty(BROKEN_ICON_KEY)
    expect(BROKEN_ICON_COLOR).toBe('var(--color-danger)')
  })
})

describe('iconPathsOrError', () => {
  it('chiave nota → i path del registro, nessun log', () => {
    expect(iconPathsOrError('database')).toBe(CI_ICON_PATHS['database'])
    expect(iconPathsOrError('hard-drive')).toBe(CI_ICON_PATHS['hard-drive'])
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('chiave sconosciuta → "?" rosso + console.error (mai "box")', () => {
    expect(iconPathsOrError('rocket')).toBe(BROKEN_ICON_PATHS)
    expect(iconPathsOrError('rocket')).not.toBe(CI_ICON_PATHS['box'])
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON_PATHS] valore sconosciuto: "rocket"')
  })
  it('la chiave riservata __broken__ ritorna il "?" senza loggare (già segnalato a monte)', () => {
    expect(iconPathsOrError(BROKEN_ICON_KEY)).toBe(BROKEN_ICON_PATHS)
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('normalizeTypeName', () => {
  it.each([
    ['DatabaseInstance', 'databaseinstance'],
    ['database_instance', 'databaseinstance'],
    ['Database Instance', 'databaseinstance'],
    ['SSL Certificate', 'sslcertificate'],
    ['server', 'server'],
  ])('"%s" → "%s"', (input, out) => {
    expect(normalizeTypeName(input)).toBe(out)
  })
})

describe('buildTypeIconMap / iconKeyForType', () => {
  const map = buildTypeIconMap([
    { name: 'server', icon: 'server' },
    { name: 'Database Instance', icon: 'database' },
    { name: 'no_icon', icon: null },
    { name: 'empty_icon', icon: '' },
    { name: 'undefined_icon' },
  ])

  it('un tipo senza icon NON eredita "box": resta assente dalla mappa', () => {
    expect([...map.keys()].sort()).toEqual(['databaseinstance', 'server'])
    expect(map.get('databaseinstance')).toBe('database')
  })

  it('lookup con qualunque variante del nome tipo', () => {
    expect(iconKeyForType(map, 'DATABASE_INSTANCE')).toBe('database')
    expect(iconKeyForType(map, 'Server')).toBe('server')
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('tipo assente → BROKEN_ICON_KEY + console.error con il tipo', () => {
    expect(iconKeyForType(map, 'no_icon')).toBe(BROKEN_ICON_KEY)
    expect(iconKeyForType(map, 'unknown_type')).toBe(BROKEN_ICON_KEY)
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON] tipo CI senza icona nel metamodello: "no_icon"')
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON] tipo CI senza icona nel metamodello: "unknown_type"')
  })
})
