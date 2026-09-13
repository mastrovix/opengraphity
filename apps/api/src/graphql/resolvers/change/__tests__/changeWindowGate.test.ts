/**
 * IL LINT DEL VARCO (terza revisione · C1).
 *
 * Il varco della finestra di rilascio era scritto bene in UN posto e
 * `autoTransitions.ts` non lo conosceva. Contando i chiamanti di
 * `workflowEngine.transition` sono venuti fuori **quattordici** cammini, non
 * tre: cinque potevano far transire un'istanza di change e nessuno dei due
 * revisori ne aveva visti più di due.
 *
 * Questo test non prova un comportamento: pretende che ogni cammino che
 * transisce dichiari come sta al varco. Chi ne aggiunge un sedicesimo deve
 * scegliere fra collegarlo o metterlo qui con una PROVA — non con una frase.
 * L'elenco di esenzioni della seconda revisione era giustificato da
 * un'affermazione che il codice smentiva (`domainMatrixSeed.ts` «chiamato solo
 * dagli script»), quindi qui ogni esenzione porta un predicato che si esegue:
 * se la ragione smette di essere vera, il test cade.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('../../../../', import.meta.url)))

/** Chiama il motore per far transire un'istanza. */
const TRANSITIONS = /\b(?:workflowEngine|engine)\.transition\s*\(/

/** Ha il varco: importa una delle funzioni di `windowGate.ts` (anche con import differito). */
const HAS_GATE = /windowGate\.js/

interface Exemption {
  /** Perché questo cammino non può portare una change nella finestra di rilascio. */
  reason: string
  /** La prova, eseguita sul testo del file: se diventa falsa, l'esenzione decade. */
  proof: (src: string) => boolean
}

const mentionsChange = (src: string): boolean => /:Change\b|Change \{|'change'/.test(src)

const EXEMPT: Record<string, Exemption> = {
  'graphql/resolvers/change/approvalGate.ts': {
    reason: 'Transisce verso il passo di scopo `scheduled` SOLO dentro `if (await areAllApprovalsSatisfied(...))`, '
      + 'che è la stessa regola del varco: quando arriva l\'ultima approvazione la change esce da sola.',
    proof: (s) => s.includes('areAllApprovalsSatisfied'),
  },
  'graphql/resolvers/change/helpers.ts': {
    reason: 'Avanza solo le change di tipo PRE-APPROVATO, che è la condizione `open` del varco. '
      + 'Qui c\'era il letterale `=== \'standard\'`: la terza revisione l\'ha sostituito con il dato del cliente.',
    proof: (s) => s.includes('isPreApprovedChangeType'),
  },
  'graphql/resolvers/workflowMutations.ts': {
    reason: 'La mutation generica RIFIUTA a voce alta le istanze di change e le manda a executeChangeTransition.',
    proof: (s) => s.includes('Le change si transizionano con executeChangeTransition'),
  },
  'graphql/resolvers/approval.ts': {
    reason: 'Solo articoli della Knowledge Base: il tipo di entità è il letterale `kb_article` in entrambe le transizioni.',
    proof: (s) => s.includes("'kb_article'") && !mentionsChange(s),
  },
  'graphql/resolvers/portal.ts':    { reason: 'Solo incident.',         proof: (s) => !mentionsChange(s) },
  'graphql/resolvers/problem.ts':   { reason: 'Solo incident e problem.', proof: (s) => !mentionsChange(s) },
  'services/incidentService.ts':    { reason: 'Solo incident.',         proof: (s) => !mentionsChange(s) },
  'services/requestService.ts':     { reason: 'Solo service request.',  proof: (s) => !mentionsChange(s) },
  'scripts/revert-problem.ts':      { reason: 'Script una-volta, solo problem.', proof: (s) => !mentionsChange(s) },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      walk(full, out)
    } else if (name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const callers = walk(SRC)
  .filter((f) => TRANSITIONS.test(readFileSync(f, 'utf8')))
  .map((f) => relative(SRC, f).split('\\').join('/'))
  .filter((f) => f !== 'graphql/resolvers/change/windowGate.ts')
  .sort()

describe('il varco della finestra di rilascio è su OGNI cammino che transisce', () => {
  it('trova i cammini (se questo numero cambia, qualcuno ne ha aggiunto o togliuto uno)', () => {
    // Non è un numero magico da aggiornare a occhio: serve a far notare che
    // l'insieme è cambiato, così chi legge va a vedere quale.
    expect(callers.length).toBeGreaterThanOrEqual(13)
    expect(callers).toContain('graphql/resolvers/change/autoTransitions.ts')
    expect(callers).toContain('jobs/workflowJobWorker.ts')
    expect(callers).toContain('lib/actionExecutor.ts')
    expect(callers).toContain('consumers/escalationConsumer.ts')
  })

  it.each(['graphql/resolvers/change/autoTransitions.ts',
           'graphql/resolvers/change/changeMutations.ts',
           'jobs/workflowJobWorker.ts',
           'lib/actionExecutor.ts',
           'consumers/escalationConsumer.ts'])('%s chiama il varco', (rel) => {
    expect(HAS_GATE.test(readFileSync(join(SRC, rel), 'utf8'))).toBe(true)
  })

  it('ogni cammino o chiama il varco, o è esente CON UNA PROVA che regge', () => {
    const senzaVarco: string[] = []
    const provaCaduta: string[] = []

    for (const rel of callers) {
      const src = readFileSync(join(SRC, rel), 'utf8')
      if (HAS_GATE.test(src)) continue
      const ex = EXEMPT[rel]
      if (!ex) { senzaVarco.push(rel); continue }
      if (!ex.proof(src)) provaCaduta.push(`${rel} — l'esenzione diceva: ${ex.reason}`)
    }

    expect(senzaVarco, `Questi cammini fanno transire un'istanza senza passare dal varco della finestra di `
      + `rilascio. Se possono toccare una change, chiama automaticTransitionAllowed / `
      + `assertChangeWindowGate; se non possono, aggiungili a EXEMPT con una prova eseguibile.`,
    ).toEqual([])

    expect(provaCaduta, 'La ragione dell\'esenzione non è più vera nel codice: rileggila.').toEqual([])
  })

  it('nessuna esenzione è rimasta appesa a un file che non transisce più', () => {
    // Un\'esenzione orfana è un permesso che nessuno ha più chiesto: va tolta,
    // altrimenti copre un cammino futuro che nessuno ha esaminato.
    expect(Object.keys(EXEMPT).filter((rel) => !callers.includes(rel))).toEqual([])
  })
})
