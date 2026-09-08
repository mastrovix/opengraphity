import { makePdfRouter } from './pdfRouter.js'
import { buildProblemPdf, loadProblemDossier } from '../lib/problemPdf.js'

// GET /api/problems/:id/pdf
export const problemPdfRouter = makePdfRouter({
  path:     '/problems/:id/pdf',
  entity:   'Problem',
  loader:   loadProblemDossier,
  builder:  buildProblemPdf,
  filename: (d) => d.problem.number || d.problem.id,
})
