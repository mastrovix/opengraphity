/**
 * L'ACCESSO ALLA CONSOLE DI PIATTAFORMA (17 set 2026, decisione del
 * proprietario: realm dedicato).
 *
 * La console crea, rinomina, sospende e cancella i TENANT: è la superficie più
 * potente del prodotto, e l'unica che non appartiene a nessun tenant. Per
 * questo non passa da `resolveAuth`: quel cammino mappa realm → tenant e cerca
 * l'utente DENTRO quel tenant (`findUserInTenant`), cioè presuppone proprio la
 * cosa che qui non esiste.
 *
 * ## Il confine sta nell'IDENTITÀ, non in un controllo
 * Un amministratore di `c-test` non può arrivare a `c-one` perché il suo token
 * è emesso dal realm `c-test`, e qui si accetta **solo** il realm di
 * piattaforma. Non è un permesso che si può dimenticare di verificare: è un
 * emittente diverso. Era la ragione della scelta fra le tre offerte.
 *
 * ## Due sbarre, non una
 *  1. il token deve venire dal realm di piattaforma (`PLATFORM_REALM`);
 *  2. la richiesta deve arrivare sull'host della console
 *     (`PLATFORM_CONSOLE_HOST`), confrontato per INTERO.
 *
 * Servono entrambe, e in entrambi i versi: un token di piattaforma presentato
 * a `c-one.localhost` si rifiuta, e un token di tenant presentato alla console
 * si rifiuta. Con una sbarra sola, chi ottenesse un token di piattaforma
 * potrebbe usarlo su qualunque host, e il confronto host↔realm che protegge i
 * tenant (`resolveAuth`) non lo vedrebbe nemmeno.
 *
 * ## Senza configurazione la console NON ESISTE
 * `PLATFORM_REALM` e `PLATFORM_CONSOLE_HOST` non hanno default: se mancano,
 * ogni richiesta è rifiutata. Un default avrebbe fatto esistere la console su
 * ogni installazione, anche dove nessuno l'ha voluta.
 */
import type express from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../lib/config.js'
import { logger } from '../lib/logger.js'
import { verifyKeycloakToken } from './keycloak.js'
import { extractRealmFromIssuer } from './resolveAuth.js'

const log = logger.child({ module: 'platform-auth' })

/** Chi sta operando sulla console: un'identità senza tenant. */
export interface PlatformActor {
  email: string
  /** Il `sub` del token: l'identificatore stabile dell'utente in Keycloak. */
  subject: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** L'attore di piattaforma: presente solo dopo `platformAuthMiddleware`. */
      platformActor?: PlatformActor
    }
  }
}

/** L'host della richiesta, come lo vede nginx (che impone `X-Forwarded-Host`). */
function hostOf(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-host']
  const raw = Array.isArray(forwarded) ? (forwarded[0] ?? '') : (forwarded ?? req.headers['host'] ?? '')
  // Una catena di proxy può accodare più valori: conta il primo, quello che il
  // client ha davvero chiesto. E la porta non fa parte dell'host.
  return String(raw).split(',')[0]!.trim().split(':')[0]!.toLowerCase()
}

class PlatformDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformDenied'
  }
}

/**
 * Riconosce l'attore di piattaforma, o rifiuta. Non dice MAI quale delle due
 * sbarre ha fermato la richiesta: a chi prova a indovinare non si regala la
 * mappa. Il motivo vero sta nei log.
 */
export async function resolvePlatformActor(req: express.Request): Promise<PlatformActor> {
  const realmAtteso = config.platformRealm
  const hostAtteso  = config.platformHost?.toLowerCase()
  if (!realmAtteso || !hostAtteso) {
    log.warn('console request with PLATFORM_REALM or PLATFORM_CONSOLE_HOST unset: rejected')
    throw new PlatformDenied('Unauthorized')
  }

  const host = hostOf(req)
  if (host !== hostAtteso) {
    log.warn({ host, hostAtteso }, 'platform request on a host that is not the console host: rejected')
    throw new PlatformDenied('Unauthorized')
  }

  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (token === '') throw new PlatformDenied('Unauthorized')

  let decoded: jwt.JwtPayload
  try {
    decoded = await verifyKeycloakToken(token)
  } catch (err) {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'invalid platform token')
    throw new PlatformDenied('Unauthorized')
  }

  const realm = extractRealmFromIssuer(String(decoded.iss ?? ''))
  if (realm !== realmAtteso) {
    log.warn({ realm, realmAtteso }, 'token issued by a realm that is not the platform realm: rejected')
    throw new PlatformDenied('Unauthorized')
  }

  const email = typeof decoded['email'] === 'string' ? decoded['email'] : ''
  const subject = typeof decoded.sub === 'string' ? decoded.sub : ''
  if (email === '' || subject === '') {
    log.warn('platform token without email or sub: rejected')
    throw new PlatformDenied('Unauthorized')
  }

  return { email, subject }
}

/** Il middleware: mette `req.platformActor` o risponde 401. */
export function platformAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  void resolvePlatformActor(req)
    .then((actor) => {
      req.platformActor = actor
      next()
    })
    .catch(() => {
      // Sempre 401 e sempre la stessa frase: la ragione sta nei log, non nella
      // risposta.
      res.status(401).json({ error: 'Unauthorized' })
    })
}
