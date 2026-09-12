/**
 * D-13 — i ruoli veri vivono in UN posto solo: `USER_ROLES`
 * (`packages/types/src/user.ts`), la lista che `assertRole` applica al login.
 *
 * Prima gli script e le regole di notifica offrivano anche `user` e `manager`,
 * che l'autenticazione non conosce: `onboard-tenant --admin-role manager`
 * creava un primo amministratore che al primo login veniva rifiutato, e
 * `add-user` aveva `default: 'user'`, cioè creava di serie utenti che non
 * riescono a entrare. `authorization.ts` teneva una seconda lista letterale
 * identica, libera di divergere.
 *
 * Questo è un lint statico come `aiModel.test.ts` e `tenantScoping.test.ts`:
 * legge i sorgenti degli script (che si eseguono all'import, quindi non si
 * possono importare) e confronta le liste vere.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { USER_ROLES, NOTIFICATION_TARGETS, NOTIFICATION_ROLE_TARGETS } from '@opengraphity/types'
import { ROLES } from '../authorization.js'

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const read = (p: string) => readFileSync(`${SRC}${p}`, 'utf8')
/** Sorgente senza commenti: la storia di `user`/`manager` è scritta nei commenti, ed è giusto che resti. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('un solo elenco di ruoli', () => {
  it('la policy RBAC usa la lista condivisa, non una copia', () => {
    expect(ROLES).toBe(USER_ROLES)
    expect([...ROLES]).toEqual(['admin', 'operator', 'viewer', 'end_user'])
  })

  it('l\'autenticazione applica la stessa lista (assertRole → ROLES = USER_ROLES)', () => {
    const src = read('auth/resolveAuth.ts')
    expect(src).toContain('export const ROLES = USER_ROLES')
  })

  it('add-user e onboard-tenant prendono i ruoli ammessi dalla lista condivisa', () => {
    for (const file of ['scripts/add-user.ts', 'scripts/onboard-tenant.ts']) {
      const src = read(file)
      expect(code(src), file).toMatch(/const ALLOWED_ROLES = USER_ROLES/)
      expect(code(src), file).not.toMatch(/'manager'|'user'/)
    }
  })

  it('add-user non ha più un ruolo predefinito (ne serviva uno valido, non uno qualsiasi)', () => {
    const src = code(read('scripts/add-user.ts'))
    expect(src).toMatch(/'role':\s*\{ type: 'string' \}/)
    expect(src).not.toMatch(/'role':\s*\{ type: 'string', default:/)
  })
})

describe('i destinatari delle notifiche per ruolo coincidono con i ruoli veri (D-23 + D-13)', () => {
  it('un bersaglio per ogni ruolo, nessuno in più', () => {
    expect([...NOTIFICATION_ROLE_TARGETS]).toEqual(USER_ROLES.map((r) => `role:${r}`))
    expect(NOTIFICATION_TARGETS).not.toContain('role:manager')
  })

  it('la tendina del web offre esattamente il vocabolario condiviso', () => {
    const src = code(readFileSync(fileURLToPath(new URL('../../../../web/src/pages/settings/NotificationRuleList.tsx', import.meta.url)), 'utf8'))
    // I valori non sono scritti a mano nel web: la lista arriva da
    // NOTIFICATION_TARGETS e qui c'è solo l'etichetta di ognuno (un bersaglio
    // senza etichetta fa fallire il caricamento del modulo).
    expect(src).toContain('NOTIFICATION_TARGETS.map')
    for (const target of NOTIFICATION_TARGETS) expect(src, target).toContain(`'${target}':`)
    expect(src).not.toContain('role:manager')
  })
})
