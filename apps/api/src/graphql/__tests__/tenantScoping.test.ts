/**
 * Lint statico: ogni MATCH su un nodo di dominio deve essere scopato per tenant.
 *
 * La revisione ITSM ha trovato ~30 pattern `(x:Label {id: $id})` senza
 * `tenant_id`, sparsi e sfuggiti a tutti; una regola meccanica è l'unico modo
 * per non ritrovarseli. Euristica: per ogni `MATCH (alias:Label {...})` (anche
 * OPTIONAL) con Label di dominio, la mappa proprietà o la riga successiva
 * (WHERE) devono contenere `tenant_id`. Un caso legittimo si marca con
 * `// tenant-ok` sulla riga precedente o sulla riga stessa.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')

// L'elenco vive in `domainLabels.ts`, condiviso con `tenantOnCreate.test.ts`.
import { DOMAIN_LABELS } from './domainLabels'

// Tutta l'API (Ondata 1 della revisione a tappeto). Fuori: script operativi
// (hanno guardie proprie: --tenant obbligatorio) e test.
const SCOPE = ['.']
const EXCLUDED_DIRS = new Set(['__tests__', 'scripts'])

function listFiles(p: string): string[] {
  const full = p.startsWith('/') ? p : join(apiSrc, p)
  if (statSync(full).isFile()) return [full]
  const out: string[] = []
  for (const f of readdirSync(full)) {
    const child = join(full, f)
    if (statSync(child).isDirectory()) {
      if (!EXCLUDED_DIRS.has(f)) out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

const MATCH_RE = new RegExp(`MATCH \\((\\w+):(${DOMAIN_LABELS.join('|')})\\s*\\{([^}]*)\\}`, 'g')

interface Offender { file: string; line: number; text: string }

/**
 * Un nodo la cui chiave viene INTERAMENTE da un alias già legato nella query
 * (`{instance_id: wi.id}`, `{definition_id: wd.id}`) è vincolato dal grafo, non
 * dall'input del chiamante: se `wi` è scopato, lo è anche lui. È la convenzione
 * che `lib/ciTypeUsage.ts:77-78` già annotava a mano; qui diventa la regola,
 * così i figli di un nodo scopato non chiedono un marcatore a testa.
 *
 * Vincolo stretto: nessun `$parametro` nella mappa (un parametro arriva dal
 * chiamante e va scopato) e ogni valore della forma `alias.proprieta`.
 */
const BOUND_VALUE_RE = /^\s*\w+\s*:\s*\w+\.\w+\s*$/
function keyedOnBoundAlias(props: string): boolean {
  if (props.includes('$')) return false
  const parts = props.split(',').filter((p) => p.trim())
  return parts.length > 0 && parts.every((p) => BOUND_VALUE_RE.test(p))
}

function scan(file: string): Offender[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    MATCH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MATCH_RE.exec(line)) !== null) {
      const props = m[3]!
      if (props.includes('tenant_id')) continue
      if (keyedOnBoundAlias(props)) continue
      const next = lines[i + 1] ?? ''
      const prev = lines[i - 1] ?? ''
      if (line.slice(m.index + m[0].length).includes('tenant_id')) continue // WHERE inline sulla stessa riga
      if (next.includes('tenant_id')) continue           // WHERE x.tenant_id = … sulla riga dopo
      if (line.includes('tenant-ok') || prev.includes('tenant-ok')) continue
      out.push({ file: relative(apiSrc, file), line: i + 1, text: line.trim() })
    }
  })
  return out
}

describe('tenant scoping sui MATCH di dominio (tutta l\'API)', () => {
  const files = SCOPE.flatMap(listFiles)
  it('perimetro non vuoto', () => { expect(files.length).toBeGreaterThan(100) })
  it('la chiave presa da un alias già legato non chiede il tenant, un parametro sì', () => {
    expect(keyedOnBoundAlias('instance_id: wi.id')).toBe(true)
    expect(keyedOnBoundAlias('definition_id: wi.definition_id, name: wi.current_step')).toBe(true)
    expect(keyedOnBoundAlias('id: $id')).toBe(false)
    expect(keyedOnBoundAlias('id: wi.id, name: $stepName')).toBe(false)
    expect(keyedOnBoundAlias('')).toBe(false)
  })
  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scan(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})

/**
 * Stessa regola per i MERGE (Ondata 4): un `MERGE (x:Label {…})` senza
 * tenant_id nella chiave di match può agganciare (o creare) un nodo di un
 * altro tenant. La mappa proprietà può essere multi-riga (es. anomalyEngine),
 * quindi qui si scansiona il contenuto intero e non riga per riga. Sono
 * ammessi, come per i MATCH, `tenant_id` sulla riga di chiusura della mappa o
 * su quella successiva (tipicamente `ON CREATE SET x.tenant_id = $tenantId`,
 * usato dai task della change keyed su `change_key` = uuid della change) e il
 * marcatore `// tenant-ok`.
 */
const MERGE_RE = new RegExp(`MERGE \\((\\w+):(${DOMAIN_LABELS.join('|')})\\s*\\{([^}]*)\\}`, 'g')

function scanMergeContent(content: string, displayName: string): Offender[] {
  const lines = content.split('\n')
  const out: Offender[] = []
  MERGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MERGE_RE.exec(content)) !== null) {
    if (m[3]!.includes('tenant_id')) continue
    const startLine = content.slice(0, m.index).split('\n').length - 1        // 0-based
    const endLine = startLine + m[0].split('\n').length - 1
    const endCol = content.slice(0, m.index + m[0].length).split('\n').pop()!.length
    if ((lines[endLine] ?? '').slice(endCol).includes('tenant_id')) continue  // WHERE/SET inline dopo la mappa
    if ((lines[endLine + 1] ?? '').includes('tenant_id')) continue           // ON CREATE SET x.tenant_id = … sulla riga dopo
    const startText = lines[startLine] ?? ''
    if (startText.includes('tenant-ok') || (lines[startLine - 1] ?? '').includes('tenant-ok')) continue
    out.push({ file: displayName, line: startLine + 1, text: startText.trim() })
  }
  return out
}

const scanMerge = (file: string) => scanMergeContent(readFileSync(file, 'utf8'), relative(apiSrc, file))

/**
 * Terzo punto cieco, dichiarato da D-18: le due regex sopra esigono la **mappa
 * di proprietà** `{…}`, quindi un `MATCH (e:EnumTypeDefinition)` nudo — il
 * pattern che tutte le fughe del metamodello usavano — non le fa scattare
 * affatto. Qui si copre il caso nudo.
 *
 * Perimetro della regola, scelto per non fare rumore su casi che il tenant
 * scoping non riguarda:
 * - solo il nodo di **ancoraggio** (subito dopo `MATCH (`): il bersaglio di un
 *   attraversamento (`(t)-[:HAS_FIELD]->(f:CIFieldDefinition)`) non è
 *   un'ancora e la regex non lo vede;
 * - solo il pattern **isolato**: se dopo la parentesi comincia una relazione
 *   (`MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)`) il nodo è vincolato
 *   dall'attraversamento verso un nodo già scopato, che è una classe di
 *   rischio diversa;
 * - il `tenant_id` si cerca nel **blocco WHERE** che segue (non solo sulla riga
 *   dopo), perché un WHERE multi-riga è la norma.
 *
 * Un WHERE **interpolato** (`WHERE ${conditions.join(' AND ')}`) non è
 * verificabile staticamente: è esattamente il posto dove un filtro mancante si
 * nasconde, quindi NON passa da sé — va marcato `// tenant-ok` dicendo da dove
 * arriva il filtro.
 */
const BARE_MATCH_RE = new RegExp(`MATCH \\((\\w+):(${DOMAIN_LABELS.join('|')})\\s*\\)(?![-<])`, 'g')
// Fine del blocco WHERE: la clausola Cypher successiva, o la fine del template.
const CLAUSE_END_RE = /\b(RETURN|WITH|MATCH|MERGE|CREATE|SET|DELETE|DETACH|CALL|UNWIND|ORDER BY|SKIP|LIMIT|FOREACH)\b/

function scanBareContent(content: string, displayName: string): Offender[] {
  const lines = content.split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    BARE_MATCH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BARE_MATCH_RE.exec(line)) !== null) {
      if (line.slice(m.index + m[0].length).includes('tenant_id')) continue
      if (line.includes('tenant-ok') || (lines[i - 1] ?? '').includes('tenant-ok')) continue
      let scoped = false
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? ''
        if (l.includes('tenant_id')) { scoped = true; break }
        if (CLAUSE_END_RE.test(l)) break
        if (l.includes('`')) break                        // fine del template literal
      }
      if (scoped) continue
      out.push({ file: displayName, line: i + 1, text: line.trim() })
    }
  })
  return out
}

const scanBare = (file: string) => scanBareContent(readFileSync(file, 'utf8'), relative(apiSrc, file))

describe('tenant scoping sui MATCH nudi di dominio, senza mappa di proprietà', () => {
  const files = SCOPE.flatMap(listFiles)

  it('l\'euristica vede il nudo, ignora attraversamenti e bersagli, e non si fida dell\'interpolazione', () => {
    const sample = [
      'MATCH (e:EnumTypeDefinition)',                                  // ok: WHERE multi-riga
      "WHERE e.active = true",
      "  AND (e.tenant_id = $tenantId OR e.tenant_id = 'system')",
      'RETURN e',
      'MATCH (wd:WorkflowDefinition {tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)',
      'OPTIONAL MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)',     // ok: attraversamento
      'OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)',        // ok: bersaglio, non ancora
      '// tenant-ok: metrica di processo',
      'MATCH (w:InboundWebhook)',                                      // ok: marcatore
      'MATCH (a:Anomaly)',                                             // VIOLAZIONE: nessun filtro
      'RETURN a',
      'MATCH (i:Incident)',                                            // VIOLAZIONE: WHERE interpolato
      'WHERE ${conditions.join(\' AND \')}',
      'RETURN i',
    ].join('\n')
    expect(scanBareContent(sample, 'sample.ts')).toEqual([
      { file: 'sample.ts', line: 10, text: 'MATCH (a:Anomaly)' },
      { file: 'sample.ts', line: 12, text: 'MATCH (i:Incident)' },
    ])
  })

  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scanBare(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})

describe('tenant scoping sui MERGE di dominio (tutta l\'API)', () => {
  const files = SCOPE.flatMap(listFiles)

  it('l\'euristica accetta chiave/riga-dopo/multi-riga/marcatore e segnala il resto', () => {
    const sample = [
      "MERGE (u:User {email: $email, tenant_id: $tenantId})",         // ok: nella chiave
      "MERGE (t:AssessmentTask {change_key: $changeId + '-owner'})",  // ok: riga successiva
      "  ON CREATE SET t.id = randomUUID(), t.tenant_id = $tenantId",
      "MERGE (a:Anomaly {",                                            // ok: mappa multi-riga
      "  tenant_id: $tenantId, fingerprint: $fp",
      "})",
      "// tenant-ok",
      "MERGE (k:ApiKey {id: $id})",                                    // ok: marcatore
      "MERGE (x:Incident {id: $id})",                                  // VIOLAZIONE
      "RETURN x",
      "MERGE (y:Problem {",                                            // VIOLAZIONE multi-riga
      "  id: $id",
      "})",
    ].join('\n')
    expect(scanMergeContent(sample, 'sample.ts')).toEqual([
      { file: 'sample.ts', line: 9, text: 'MERGE (x:Incident {id: $id})' },
      { file: 'sample.ts', line: 11, text: 'MERGE (y:Problem {' },
    ])
  })

  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scanMerge(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})
