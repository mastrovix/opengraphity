/**
 * LA PORTA DEL PRODOTTO E QUELLA DEL WORKFLOW SONO LA STESSA (21 set 2026).
 *
 * `EVENTO_DISPATCH` sta nel codice, `repository_dispatch.types` sta nel file
 * del workflow, e niente li teneva insieme: chi rinomina l'uno non ha nessun
 * motivo di sapere dell'altro. Il giorno che succede, OpenGrafo manda il
 * dispatch, GitHub lo accetta con un 204 — e non parte niente. Nessun errore,
 * da nessuna parte: i Problem resterebbero in analisi per sempre e non ci
 * sarebbe una riga da cercare.
 *
 * Questo test lega le due parole.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENTO_DISPATCH } from '../autoanalisiGitHub.js'

const WORKFLOW = join(process.cwd(), '../../.github/workflows/autoanalisi.yml')

describe('il workflow dell\'Autoanalisi ascolta la porta che il prodotto usa', () => {
  const testo = readFileSync(WORKFLOW, 'utf8')

  it(`\`repository_dispatch\` dichiara il tipo "${EVENTO_DISPATCH}"`, () => {
    const blocco = /repository_dispatch:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(testo)
    expect(blocco, 'il workflow non ha più un trigger `repository_dispatch` con `types`').not.toBeNull()
    const tipi = blocco![1]!.split(',').map((t) => t.trim())
    expect(tipi).toContain(EVENTO_DISPATCH)
  })

  it('il job parte anche su `repository_dispatch`, non solo sull\'etichetta', () => {
    expect(testo).toMatch(/github\.event_name == 'repository_dispatch'/)
  })

  it('e sa da dove leggere il numero della issue quando arriva di lì', () => {
    expect(testo).toMatch(/github\.event\.client_payload\.issue/)
  })
})
