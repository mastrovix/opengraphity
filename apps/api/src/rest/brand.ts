/**
 * Il logo dell'organizzazione (verifica «Cosa resta cablato», ondata 6).
 *
 *   POST   /api/brand/logo              admin, multipart `file` (PNG o SVG ≤ 1 MB)
 *   DELETE /api/brand/logo              admin
 *   GET    /api/brand/:tenantId/logo    pubblico: lo leggono anche le e-mail
 *
 * Il GET è senza sessione di proposito: un client di posta non ne ha una, e un
 * logo è pubblico per natura. Si serve con una CSP che non esegue niente (un SVG
 * aperto da solo non può lanciare script) e con la risorsa aperta alle altre
 * origini, altrimenti una webmail non la mostrerebbe.
 */
import Busboy from 'busboy'
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { BRAND_LOGO_MAX_BYTES } from '@opengraphity/types'
import { authMiddleware } from '../middleware/auth.js'
import { ValidationError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { runRoute, sendFile } from './routeSafety.js'
import { audit } from '../lib/audit.js'
import { removeTenantLogo, setTenantLogo, tenantLogoFile } from '../lib/brand.js'
import type { GraphQLContext } from '../context.js'
import { parametro } from './parametroDiRotta.js'

const router: ExpressRouter = Router()

function adminContext(req: Request, res: Response): GraphQLContext | null {
  const { tenantId, userId, email, role, permissions } = req.user!
  if (!permissions.has('config.organization')) {
    res.status(403).json({ error: 'Changing the logo needs the Organization permission' })
    return null
  }
  return { tenantId, userId, userEmail: email, role: role as GraphQLContext['role'], permissions }
}

router.post('/brand/logo', authMiddleware, (req, res) => {
  const ctx = adminContext(req, res)
  if (!ctx) return
  if (!(req.headers['content-type'] ?? '').includes('multipart/form-data')) {
    res.status(400).json({ error: 'Expected multipart/form-data with a "file" field' })
    return
  }
  const busboy = Busboy({ headers: req.headers, limits: { fileSize: BRAND_LOGO_MAX_BYTES, files: 1 } })
  const chunks: Buffer[] = []
  let tooLarge = false
  let received = false
  busboy.on('file', (field: string, stream: NodeJS.ReadableStream) => {
    // Defect fixed (22 Sep 2026): the file stream had no 'error' listener. On a
    // truncated body busboy destroys the open file stream with "Unexpected end
    // of form"; with no listener that is an uncaught exception, i.e. one cut
    // upload took down the whole API process. The 400 is answered by the
    // busboy 'error' handler below, so here the error only needs a listener.
    stream.on('error', () => undefined)
    if (field !== 'file') { stream.resume(); return }
    received = true
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('limit', () => { tooLarge = true })
  })
  busboy.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'Malformed multipart body' }) })
  busboy.on('finish', () => {
    runRoute(res, '[brand]', async () => {
      if (res.headersSent) return
      if (!received) { res.status(400).json({ error: 'No file uploaded' }); return }
      if (tooLarge) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', key: 'errors.brand.logoSize', message: 'The logo is larger than 1 MB.' } }); return }
      try {
        const brand = await setTenantLogo(ctx.tenantId, Buffer.concat(chunks))
        void audit(ctx, 'tenant.brand.logo_updated', 'Tenant', ctx.tenantId, { mimeType: brand.logo?.mimeType ?? null })
        res.status(201).json({ ok: true })
      } catch (err) {
        if (err instanceof ValidationError) {
          const i18n = err.extensions['i18n'] as { key?: string } | undefined
          res.status(400).json({ error: { code: 'VALIDATION_ERROR', key: i18n?.key ?? null, message: err.message } })
          return
        }
        logger.error({ err, tenantId: ctx.tenantId }, '[brand] logo upload failed')
        res.status(500).json({ error: 'Failed to store the logo' })
      }
    })
  })
  req.pipe(busboy)
})

router.delete('/brand/logo', authMiddleware, (req, res) => {
  const ctx = adminContext(req, res)
  if (!ctx) return
  runRoute(res, '[brand]', async () => {
    try {
      await removeTenantLogo(ctx.tenantId)
      void audit(ctx, 'tenant.brand.logo_removed', 'Tenant', ctx.tenantId)
      res.json({ ok: true })
    } catch (err) {
      logger.error({ err, tenantId: ctx.tenantId }, '[brand] logo removal failed')
      res.status(500).json({ error: 'Failed to remove the logo' })
    }
  })
})

router.get('/brand/:tenantId/logo', (req: Request, res: Response) => {
  runRoute(res, '[brand]', async () => {
    const tenantId = String(parametro(req, 'tenantId'))
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) { res.status(404).end(); return }
    try {
      const file = await tenantLogoFile(tenantId)
      if (!file) { res.status(404).end(); return }
      res.setHeader('Content-Type', file.mimeType)
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      sendFile(res, file.path, '[brand] logo')
    } catch (err) {
      // Un tenant inesistente non si distingue da uno senza logo.
      logger.debug({ err, tenantId }, '[brand] logo not served')
      if (!res.headersSent) res.status(404).end()
    }
  })
})

export { router as brandRouter }
