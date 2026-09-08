import { makePdfRouter } from './pdfRouter.js'
import { buildChangePdf, loadChangeDossier } from '../lib/changePdf.js'

// GET /api/changes/:id/pdf
export const changePdfRouter = makePdfRouter({
  path:     '/changes/:id/pdf',
  entity:   'Change',
  loader:   loadChangeDossier,
  builder:  buildChangePdf,
  filename: (d) => d.change.code || d.change.id,
})
