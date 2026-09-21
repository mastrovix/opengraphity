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
import { USER_ROLES, NOTIFICATION_TARGETS, NOTIFICATION_BASE_TARGETS, NOTIFICATION_ROLE_TARGETS } from '@opengraphity/types'
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

  it('add-user accetta i ruoli dell\'organizzazione, letti dal grafo prima di toccare Keycloak (ondata 7)', () => {
    const src = code(read('scripts/add-user.ts'))
    expect(src).toMatch(/MATCH \(r:Role \{tenant_id: \$tenantId\}\)/)
    expect(src.indexOf('await assertTenantRole(a)')).toBeLessThan(src.indexOf('await kc.getAdminToken()'))
    expect(src).not.toMatch(/'manager'|'user'/)
  })

  it('onboard-tenant: il primo admin ha un ruolo di fabbrica che gestisce persone e ruoli', () => {
    const src = code(read('scripts/onboard-tenant.ts'))
    expect(src).toMatch(/const ALLOWED_ROLES = USER_ROLES\.filter\(\(r\) => FACTORY_ROLE_PERMISSIONS\[r\]\.includes\(USERS_ADMIN_PERMISSION\)\)/)
    expect(src).not.toMatch(/'manager'|'user'/)
  })

  it('nessuno dei due copia il ruolo in Keycloak (ondata 7: il ruolo si legge solo dal grafo)', () => {
    for (const file of ['scripts/add-user.ts', 'scripts/onboard-tenant.ts']) {
      const src = code(read(file))
      expect(src, file).not.toMatch(/assignRealmRole\(|\/roles`|realm-role-mapper/)
    }
  })

  it('add-user non ha più un ruolo predefinito (ne serviva uno valido, non uno qualsiasi)', () => {
    const src = code(read('scripts/add-user.ts'))
    expect(src).toMatch(/'role':\s*\{ type: 'string' \}/)
    expect(src).not.toMatch(/'role':\s*\{ type: 'string', default:/)
  })
})

describe('i destinatari delle notifiche per ruolo sono i ruoli dell\'organizzazione (D-23 + D-13, ondata 7)', () => {
  it('i ruoli di fabbrica hanno ognuno il suo bersaglio, e nessun ruolo inventato', () => {
    expect([...NOTIFICATION_ROLE_TARGETS]).toEqual(USER_ROLES.map((r) => `role:${r}`))
    expect(NOTIFICATION_TARGETS).not.toContain('role:manager')
  })

  it('la tendina del web offre i bersagli fissi del vocabolario e un bersaglio per ogni ruolo caricato', () => {
    const src = code(readFileSync(fileURLToPath(new URL('../../../../web/src/pages/settings/NotificationRuleList.tsx', import.meta.url)), 'utf8'))
    // I valori non sono scritti a mano nel web: i fissi arrivano da
    // NOTIFICATION_BASE_TARGETS (qui c'è solo l'etichetta di ognuno), i ruoli
    // dai ruoli dell'organizzazione (`useRoles`), mai da una lista.
    expect(src).toContain('NOTIFICATION_BASE_TARGETS.map')
    for (const target of NOTIFICATION_BASE_TARGETS) expect(src, target).toContain(`'${target}':`)
    expect(src).toContain('roles.map((r) => ({ value: roleNotificationTarget(r.key)')
    expect(src).not.toContain('role:manager')
    expect(src).not.toMatch(/'role:(admin|operator|viewer|end_user)'/)
  })
})
