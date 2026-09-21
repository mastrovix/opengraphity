/**
 * L'ACCESSO ALLA CONSOLE: realm FISSO, non dedotto dal sottodominio.
 *
 * È la differenza che conta rispetto a web e portale: là il realm è il tenant,
 * e si legge dall'host (`c-one.localhost` → realm `c-one`). Qui il realm è
 * quello di piattaforma, arriva dalla configurazione del build
 * (`VITE_PLATFORM_REALM`) e non dall'indirizzo — se lo si deducesse dall'host,
 * basterebbe aprire la console su un altro nome per chiedere a Keycloak un
 * token di un altro realm.
 *
 * Nessun default: senza `VITE_PLATFORM_REALM` o `VITE_KEYCLOAK_URL` l'avvio
 * fallisce con una frase leggibile, invece di mandare il browser su una pagina
 * di errore di Keycloak.
 */
import { createKeycloak } from '@opengraphity/web-core'

function requirePlatformRealm(): string {
  const realm = import.meta.env['VITE_PLATFORM_REALM'] as string | undefined
  if (!realm || realm.trim() === '') {
    throw new Error(
      'VITE_PLATFORM_REALM is not set: the console does not know which Keycloak realm its administrators live in. '
      + 'Set it at build time (see infra/.env.example).',
    )
  }
  return realm.trim()
}

const handle = createKeycloak({
  url:          import.meta.env['VITE_KEYCLOAK_URL'] as string | undefined,
  clientId:     import.meta.env['VITE_KEYCLOAK_CLIENT_ID'] as string | undefined,
  resolveRealm: requirePlatformRealm,
})

export const initKeycloak = handle.initKeycloak
export const getKeycloak  = handle.getKeycloak
export const keycloak     = handle.keycloak
