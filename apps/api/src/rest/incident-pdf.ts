import { makePdfRouter } from './pdfRouter.js'
import { buildIncidentPdf, loadIncidentDossier } from '../lib/incidentPdf.js'

// GET /api/incidents/:id/pdf
export const incidentPdfRouter = makePdfRouter({
  path:     '/incidents/:id/pdf',
  entity:   'Incident',
  loader:   loadIncidentDossier,
  builder:  buildIncidentPdf,
  filename: (d) => d.incident.number || d.incident.id,
})
