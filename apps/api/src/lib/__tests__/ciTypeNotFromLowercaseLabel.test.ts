/**
 * Giro UI del 15 set 2026 · U-23. Il pannello «CI impattati» della change
 * rispondeva «The type of this CI cannot be told ("businessapplication")»: il
 * tipo del CI era ricavato con `label.toLowerCase()`, e «BusinessApplication»
 * non è «business_application». Rompeva ogni tipo a più parole, compresi quelli
 * che il cliente crea nel disegnatore. Il tipo di un CI si ricava dalla sua
 * etichetta con `ciTypeFromLabels` (metamodello del tenant), mai abbassando le
 * maiuscole.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sources(p, out); continue }
    if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('il tipo di un CI non si ricava abbassando le maiuscole dell\'etichetta', () => {
  it('nessun `[\'type\'] = … Label.toLowerCase()` nei sorgenti', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/\['type'\]\s*=.*[lL]abel\??\.toLowerCase\(\)/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  /**
   * Secondo giro UI del 15 set 2026 · V-3: lo stesso difetto viveva DENTRO il
   * Cypher (`toLower(head(labels(ci)))`) nelle attività della change e nelle
   * regole delle anomalie, dove il controllo qui sopra non guardava.
   */
  it('nessun `toLower(head(… labels(…)))` nel Cypher (i commenti non contano)', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*(\*|\/\/).*$/, '')
        if (/toLower\(\s*head\(\s*\[?\s*\w+\s+IN\s+labels\(|toLower\(\s*head\(\s*labels\(/.test(code)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
