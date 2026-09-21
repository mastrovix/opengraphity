/**
 * Chi invia e-mail controlla la chiave all'avvio; chi non ne invia no.
 *
 * `@opengraphity/notifications` non lancia più all'import (il worker ci era
 * finito in un ciclo di riavvii): il controllo in produzione è
 * `assertEmailConfigured()`. L'API invia (menzioni, osservatori, riepilogo
 * giornaliero) e deve chiamarlo prima di servire; il worker non invia e non
 * deve chiamarlo, altrimenti gli servirebbe un segreto che non usa.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

describe('la chiave e-mail all\'avvio', () => {
  it('index.ts la controlla prima di avviare il server', () => {
    const src = read('index.ts')
    const check = src.indexOf('assertEmailConfigured()')
    const server = src.indexOf('await startServer()')
    expect(check).toBeGreaterThan(-1)
    expect(server).toBeGreaterThan(-1)
    expect(check).toBeLessThan(server)
  })

  it('worker.ts non la controlla (non invia e-mail)', () => {
    expect(read('worker.ts')).not.toContain('assertEmailConfigured')
  })
})
