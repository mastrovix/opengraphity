/**
 * Collaboratori pesanti caricati al momento dell'uso, dichiarati una volta
 * (revisione, 3.1). I moduli della pipeline sono importati — attraverso le
 * facciate eventService/eventCorrelation — dal webhook in ingresso e dalla
 * console: il motore del workflow, incidentService (trigger, regole,
 * embedding) e la coda BullMQ non devono pesare su chi normalizza o elenca
 * gli eventi. Gli import dinamici non creano cicli statici: il worker
 * `eventCorrelateWorker` importa la facciata, la pipeline lo carica solo
 * quando accoda un job.
 */
export const engine    = async () => (await import('@opengraphity/workflow')).workflowEngine
export const incidents = () => import('../incidentService.js')
export const queue     = () => import('../../jobs/eventCorrelateWorker.js')
