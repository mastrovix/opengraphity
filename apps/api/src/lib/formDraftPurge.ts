/**
 * LE BOZZE MAI RECLAMATE (moduli del catalogo, ondata 2).
 *
 * Un campo allegato si compila prima che la richiesta esista: i file vanno su
 * una bozza (`entity_type = 'form_draft'`) e alla creazione passano al ticket.
 * Se chi compilava chiude la pagina, quei file restano — su disco e nel grafo —
 * e nessun altro passerà da lì. Questa passata li cancella dopo un giorno.
 *
 * L'ordine conta: prima il file, poi il nodo. Al contrario, un errore sul disco
 * lascerebbe un file che nessuno sa più di avere; così un file che non si
 * cancella lascia il suo nodo, la passata di domani riprova, e il log lo dice.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { FORM_DRAFT_ENTITY_TYPE } from '@opengraphity/types'
import { logger } from './logger.js'

const log = logger.child({ module: 'form-draft-purge' })

export interface FormDraftPurgeResult {
  /** Nodi :Attachment cancellati. */
  nodes: number
  /** File rimossi dal disco. */
  files: number
  /** File che non si sono potuti rimuovere: il nodo resta, si riprova domani. */
  filesFailed: number
}

export async function purgeFormDrafts(olderThanIso: string): Promise<FormDraftPurgeResult> {
  const session = getSession(undefined, 'WRITE')
  try {
    /*
      La passata è della PIATTAFORMA, non di un tenant: le bozze sono
      effimere, la scadenza è la stessa per tutti e nessuno le guarda mai. Per
      questo la ricerca attraversa i tenant — come il backup notturno. I nodi
      cancellati sono solo quelli selezionati QUI, quindi non c'è modo di
      toccare il dato di un'organizzazione che non sia scaduto. tenant-ok
    */
    const candidati = await runQuery<{ id: string; storagePath: string | null; tenantId: string }>(session, `
      MATCH (a:Attachment {entity_type: $draftType})  // tenant-ok: passata di piattaforma, vedi sopra
      WHERE a.uploaded_at < $olderThan
      RETURN a.id AS id, a.storage_path AS storagePath, a.tenant_id AS tenantId
      LIMIT 5000`, { draftType: FORM_DRAFT_ENTITY_TYPE, olderThan: olderThanIso })

    let files = 0
    let filesFailed = 0
    const daCancellare: string[] = []
    const { unlink } = await import('node:fs/promises')
    for (const c of candidati) {
      if (!c.storagePath) { daCancellare.push(c.id); continue }
      try {
        await unlink(c.storagePath)
        files++
        daCancellare.push(c.id)
      } catch (err) {
        const codice = (err as { code?: string }).code
        if (codice === 'ENOENT') {
          // Il file non c'è già: il nodo è la cosa da togliere.
          daCancellare.push(c.id)
          continue
        }
        filesFailed++
        log.warn({ err, id: c.id, tenantId: c.tenantId }, 'Form draft file not deleted: the node is kept and the next pass retries')
      }
    }

    let nodes = 0
    if (daCancellare.length > 0) {
      // Gli id vengono dalla selezione qui sopra, già scaduta e già filtrata. tenant-ok
      const rows = await runQuery<{ n: number }>(session, `
        MATCH (a:Attachment {entity_type: $draftType})  // tenant-ok: gli id vengono dalla selezione qui sopra
        WHERE a.id IN $ids
        DETACH DELETE a
        RETURN count(a) AS n`, { draftType: FORM_DRAFT_ENTITY_TYPE, ids: daCancellare })
      nodes = Number(rows[0]?.n ?? 0)
    }
    return { nodes, files, filesFailed }
  } finally {
    await session.close()
  }
}
