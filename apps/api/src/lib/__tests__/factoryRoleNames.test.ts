/**
 * I nomi dei ruoli di fabbrica stanno in due posti: il web li traduce dalla
 * chiave (`roles.*`), l'API li usa per rifiutare un ruolo del cliente con lo
 * stesso nome (secondo giro UI del 15 set 2026 · V-16). Devono coincidere.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { USER_ROLES } from '@opengraphity/types'
import { systemTextIn, type SystemTextKey } from '../systemText.js'

const locale = (l: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../web/src/i18n/locales/${l}.json`), 'utf8')) as { roles: Record<string, string> }

describe('nomi dei ruoli di fabbrica: API e web uguali', () => {
  it.each(['en', 'it'] as const)('%s', (l) => {
    const web = locale(l).roles
    for (const key of USER_ROLES) expect(systemTextIn(l, `role.factory.${key}` as SystemTextKey)).toBe(web[key])
  })
})
