/**
 * Per i test: i permessi di un ruolo di fabbrica, da mettere nel contesto
 * (`GraphQLContext.permissions`). Solo @opengraphity/types: nessun modulo
 * dell'API, così non tocca i mock del file che lo usa.
 */
import { FACTORY_ROLE_PERMISSIONS, isUserRole, type Permission } from '@opengraphity/types'

export function perms(role: string): ReadonlySet<Permission> {
  return new Set(isUserRole(role) ? FACTORY_ROLE_PERMISSIONS[role] : [])
}
