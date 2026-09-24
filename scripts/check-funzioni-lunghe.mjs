/**
 * QUANTO C'È DA TENERE IN TESTA PER RIVEDERE UNA FUNZIONE (22 set 2026).
 *
 * ## Il problema, misurato
 * `apps/api` è 122.796 righe in 652 file di prodotto (83.954 di sole
 * istruzioni: il 32% del file è commento, ed è una buona notizia). Non è un
 * difetto — è la soglia oltre cui una revisione a occhio, la mia compresa,
 * smette di essere affidabile. La prossima volta che qualcosa va storto lì
 * sarà in un pezzo che nessuno legge per intero da mesi.
 *
 * La lunghezza del FILE però non è la misura giusta: i file grossi di questo
 * repository hanno sei-undici intestazioni di sezione e si navigano bene, e
 * `vocabolarioDeiLog.ts` — il più lungo di tutti con 3.114 righe — è
 * generato. Quello che si legge per intero, o non si legge affatto, è la
 * FUNZIONE.
 *
 * ## La misura, e perché si usa un parser vero
 * Le ISTRUZIONI di una funzione, contate ricorsivamente sull'AST di
 * TypeScript. Non le righe: il testo dentro un template (SDL, Cypher) è dato,
 * non logica, e contarlo faceva sembrare `buildBaseSDL` la funzione più
 * complessa del prodotto mentre è un elenco di campi.
 *
 * E non con una regex. Ci ho provato: diceva che `mapConflict` aveva 447
 * istruzioni, e sono venti — il regex non trovava la fine della funzione e
 * tirava dentro tutto quello che seguiva. Un guardiano che misura male è
 * peggio di nessun guardiano, perché il primo numero sbagliato insegna a non
 * credergli. Con l'AST le funzioni sopra la soglia sono 102, non 164.
 *
 * ## Il typescript che serve sta ALLA RADICE
 * TypeScript 7 non espone più l'API del compilatore in JavaScript: da
 * `apps/api`, dove vive la 7, `ts.createSourceFile` non esiste. Questo
 * controllo gira dalla radice, dove sta la 6.0.3 che il lint usa — la stessa
 * convivenza spiegata in `pnpm-workspace.yaml`. È anche il motivo per cui
 * questo è uno script e non un test di vitest.
 *
 * ## La regola
 * Una funzione NUOVA non supera `TETTO`. Una funzione già lunga sta
 * nell'elenco qui sotto col suo numero di oggi e può solo RIMPICCIOLIRE.
 * Quando rimpicciolisce, lo script lo dice e invita ad aggiornare il numero:
 * il terreno guadagnato si tiene.
 *
 * Non è un invito a spezzare per spezzare. Una funzione lunga ma lineare si
 * legge meglio di cinque funzioni che si rimbalzano lo stato. Serve a
 * impedire che il numero cresca senza che nessuno lo decida.
 *
 * Uso: node scripts/check-funzioni-lunghe.mjs [--verbose]
 */
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RADICE = process.cwd()
const verbose = process.argv.includes('--verbose')

/** Oltre questo, una funzione nuova va spezzata o dichiarata qui sotto. */
const TETTO = 60

/**
 * Le funzioni ANONIME non stanno nell'elenco: la loro unica chiave sarebbe la
 * riga, e la riga si sposta al primo commento aggiunto sopra — un guardiano
 * che diventa rosso perché qualcuno ha scritto un commento insegna a
 * spegnerlo. Si contano e basta: anche il loro numero non può crescere.
 */
const ANONIME_MASSIME = 9

/*
 * LE LUNGHE DI OGGI, generate il 22 set 2026. Il numero è quante istruzioni
 * aveva quel giorno: può scendere, mai salire.
 */
const NOTE = new Map([
  /*
   * Il generatore del tenant di prova (22 set 2026). Ognuna di queste funzioni
   * racconta UNA storia dall'inizio alla fine — la vita di una change dalla
   * valutazione alla chiusura, la pianificazione di un CMDB intero, il giro di
   * verifica su tutto quello che è stato scritto — e ogni passo dipende dallo
   * stato lasciato dal precedente: l'istante dell'ultimo evento, il passo dove
   * si trova il ticket, chi l'ha in mano. Spezzarle significherebbe passare
   * dieci variabili mutabili fra cinque funzioni che si richiamano in fila:
   * più righe, e una storia che non si legge più dall'alto in basso.
   * Restano intere, e possono solo rimpicciolire.
   */
  ['apps/api/src/lib/testData/demoTenant/changes.ts#simulateChange', 238], // 24 Sep 2026: who starts a task holds it, as the product does (G30)
  // La pipeline del motore in cinque passi (certificati, incident che nascono,
  // agganci, silenziati, warning) che condividono lo stato di cosa è aperto su
  // quale CI in quale istante: spezzarla vorrebbe dire passare quello stato
  // fra cinque funzioni. Le due chiuse interne (decide, bearIncident) sono la
  // pipeline stessa, e si leggono accanto a chi le usa.
  ['apps/api/src/lib/testData/demoTenant/cmdb.ts#planCMDB', 226], // 24 Sep 2026: an application's primary business application, word-bounded database names (G34); the chains' rules, their steps moved out; a capability's status drawn before its enablers (one in service when it is)
  ['apps/api/src/lib/testData/demoTenant/incidents.ts#simulateIncident', 88],
  ['apps/api/src/lib/testData/demoTenant/problems.ts#simulateProblem', 71],
  ['apps/web/src/pages/settings/catalogForm/FormBuilderPanel.tsx#FormBuilderPanel', 188],
  ['apps/api/src/services/ticketImportService.ts#importTickets', 193],
  ['apps/web/src/components/ReportSectionBuilder.tsx#ReportSectionBuilder', 204],
  ['apps/web/src/pages/reports/ReportsPage.tsx#ReportsPage', 184],
  // 23 Sep 2026, review wave 6: +3, every action offered only with the permission the API asks.
  ['apps/web/src/pages/incidents/IncidentDetailPage.tsx#IncidentDetailPage', 146],
  ['apps/web/src/pages/settings/EnumDesignerPage.tsx#EnumEditor', 186], // 24 Sep 2026: unsaved values guarded, the icon of a value (G40, G45); the icon control is its own component
  ['apps/web/src/components/topology/TopologyGraph.tsx#TopologyGraph', 164],
  // 23 Sep 2026, review wave 6: +3, report.write / report.schedule decide the controls; channels from reportDeliveryChannels.
  ['apps/web/src/pages/reports/useCustomReports.ts#useCustomReports', 131],
  // 23 Sep 2026, review wave 6: +13, the tenant's field rules on creation, and the SLA check with the catalog item's category and team.
  ['apps/web/src/pages/requests/CreateServiceRequestPage.tsx#CreateServiceRequestPage', 186], // 24 Sep 2026: the person the request is for (G27)
  ['apps/api/src/lib/catalogForm.ts#resolveFormWrites', 166],
  // 23 Sep 2026, review wave 6: +4, regenerating a token or an API key asks first, naming the row.
  ['apps/web/src/pages/admin/IntegrationsPage.tsx#IntegrationsPage', 158],
  // 23 Sep 2026, review wave 6: +2, every action offered only with the permission the API asks.
  ['apps/web/src/pages/problems/ProblemDetailPage.tsx#ProblemDetailPage', 134], // 24 Sep 2026: the known-error move opens its own dialog (G22), which lives in KnownErrorDialog.tsx
  ['apps/web/src/pages/ci/CIDetailPage.tsx#CIDetailPage', 149],
  ['apps/web/src/pages/settings/CITypeDesignerPage.tsx#CITypeDesignerPage', 152], // 24 Sep 2026: the statuses a CI type leaves out (G36)
  // 23 Sep 2026, review wave 6: +2, the CI chains are recalculated for the whole tenant when a type's families change.
  ['apps/api/src/graphql/resolvers/ciTypeMetamodel.ts#buildMetamodelMutations', 150], // 24 Sep 2026: the statuses a CI type leaves out are checked on every write (G36)
  // 23 Sep 2026, review wave 6: +1, transitions, CIs and links offered only with the permission the API asks.
  ['apps/web/src/pages/changes/ChangeDetailPage.tsx#ChangeDetailPage', 148],
  ['apps/api/src/lib/formDesignProposal.ts#validaProposta', 144],
  // 23 Sep 2026, review wave 6: +1, a refused plan save stays unsaved, and its rejection is caught.
  ['apps/web/src/pages/tasks/TaskViewPage.tsx#TaskViewPage', 106],
  ['apps/api/src/rest/attachments.ts#handleUpload', 137],
  ['apps/web/src/pages/incidents/CreateIncidentPage.tsx#CreateIncidentPage', 112],
  ['apps/api/src/lib/actionExecutor.ts#executeSingleAction', 124],
  ['apps/web/src/pages/monitoring/serviceMapLayout.ts#layoutServiceMap', 123],
  ['apps/web/src/pages/analysis/WhatIfPage.tsx#WhatIfPage', 95],
  // 23 Sep 2026: +5, the delay of a timed wait is edited here (it could not be set anywhere).
  // 23 Sep 2026, review wave 6: +1, a notification switched on without its title blocks the save and says why.
  ['apps/web/src/pages/workflow/WorkflowStepPanel.tsx#WorkflowStepPanel', 125],
  ['apps/api/src/lib/reportDesignProposal.ts#validaPropostaReport', 118],
  ['packages/workflow/src/actions.ts#runAction', 109],
  ['apps/web/src/pages/monitoring/ServiceMapCanvas.tsx#ServiceMapCanvas', 115],
  ['apps/web/src/pages/settings/catalogForm/FormBuilderPanel.tsx#useTrascinamento', 115],
  ['apps/api/src/scripts/seed-demo-incidents.ts#main', 113],
  ['apps/web/src/pages/admin/KBAdminPage.tsx#KBAdminPage', 110], // 24 Sep 2026: who an article is for, Staff or Everyone (owner's decision of 24 Sep 2026)
  ['packages/workflow/src/engine.ts#transition', 95],
  ['apps/web/src/pages/dashboard/useDashboard.ts#useDashboard', 103],
  ['apps/portal/src/pages/ServiceCatalogPage.tsx#ServiceCatalogPage', 111],
  ['apps/api/src/lib/filterBuilder.ts#buildAdvancedWhere', 108],
  ['apps/api/src/services/ticketImportService.ts#importKBArticles', 113], // 24 Sep 2026: the audience column of an imported article (owner's decision of 24 Sep 2026)
  ['apps/web/src/pages/changes/CreateChangePage.tsx#CreateChangePage', 105],
  // 23 Sep 2026: +6, every field now goes through the property aliases (Incident.priority is `severity`): one lookup per clause.
  ['apps/api/src/lib/reportQueryBuilder.ts#buildReportQuery', 110],
  ['apps/web/src/pages/events/EventsPage.tsx#EventsPage', 103],
  // 23 Sep 2026: +1, the customer's CI type names (useCILabels) for the CI rows.
  ['apps/web/src/components/layout/GlobalSearch.tsx#GlobalSearch', 103],
  // 23 Sep 2026, review wave 6: +2, the owner and support groups are picked by team type (TeamPicker), as on the CI page.
  ['apps/web/src/components/CIDynamicForm.tsx#CIDynamicForm', 102],
  ['apps/web/src/pages/monitoring/NewSourceWizard.tsx#NewSourceWizard', 100],
  ['apps/web/src/pages/settings/catalogForm/FormBuilderPanel.tsx#afferra', 100],
  ['apps/web/src/pages/workflow/useWorkflowDesigner.ts#useWorkflowDesigner', 95],
  // 23 Sep 2026, review wave 6: +6, a save in flight cannot be sent twice.
  ['apps/web/src/pages/admin/QuestionAdminPage.tsx#QuestionAdminPage', 103],
  // 23 Sep 2026, review wave 6: +1, «New» and the bulk actions only with incident.write.
  ['apps/web/src/pages/incidents/IncidentListPage.tsx#IncidentListPage', 93],
  ['apps/web/src/pages/monitoring/ServiceDetailPage.tsx#ServiceDetailPage', 88],
  ['apps/web/src/pages/anomaly/AnomalyPage.tsx#AnomalyPage', 86],
  ['apps/web/src/pages/monitoring/CIHealthPage.tsx#CIHealthPage', 83],
  // 23 Sep 2026, review wave 6: +10, the tenant's field rules on creation (useCreationFieldRules), as the server enforces them.
  ['apps/web/src/pages/problems/CreateProblemPage.tsx#CreateProblemPage', 78],
  ['apps/portal/src/pages/TicketNewPage.tsx#TicketNewPage', 83],
  // 23 Sep 2026, review wave 6: +1, the customer's names for types, relations, state and environment (useGraphLabels).
  ['apps/web/src/components/CIGraph.tsx#CIGraph', 83],
  ['apps/web/src/pages/monitoring/GenericMapper.tsx#GenericMapper', 74],
  ['apps/api/src/graphql/resolvers/itilTypeResolvers.ts#buildITILMutations', 79],
  ['apps/web/src/pages/monitoring/ServiceComponentsTable.tsx#ServiceComponentsTable', 79],
  ['apps/web/src/pages/monitoring/UpdateServiceMapDialog.tsx#UpdateServiceMapDialog', 79],
  ['apps/web/src/pages/assistant/AssistantPage.tsx#AssistantPage', 77],
  // 23 Sep 2026, review wave 6: +1, edit, transitions and assignment only with request.write.
  ['apps/web/src/pages/requests/ServiceRequestDetailPage.tsx#ServiceRequestDetailPage', 68],
  ['apps/api/src/graphql/resolvers/enumType.ts#updateEnumType', 80], // 24 Sep 2026: the icons of the values (G40)
  ['apps/web/src/pages/monitoring/EditSourcePage.tsx#EditSourcePage', 76],
  ['apps/api/src/scripts/seed-ci-relations.ts#seed', 75],
  ['apps/web/src/hooks/useNotifications.ts#useNotifications', 73],
  ['apps/web/src/pages/settings/useITILTypeDesigner.ts#useITILTypeDesigner', 74],
  ['apps/web/src/pages/settings/EventPolicyPage.tsx#EventPolicyPage', 62],
  ['apps/web/src/pages/teams/TeamDetailPage.tsx#TeamDetailPage', 79], // 24 Sep 2026: members searched among who can take tickets, the Change Manager confirmed (G37)
  ['apps/api/src/graphql/resolvers/dynamic-ci.ts#buildDynamicCIResolvers', 69],
  ['apps/api/src/graphql/resolvers/whatif.ts#whatIfAnalysis', 69],
  ['apps/web/src/components/MentionInput.tsx#MentionInput', 71], // 24 Sep 2026: the name shown apart from the mention's markup (G16)
  ['apps/web/src/pages/admin/SLAPoliciesPage.tsx#SLAPoliciesPage', 69],
  ['apps/web/src/pages/monitoring/ServicesPage.tsx#ServicesPage', 69],
  ['apps/api/src/services/serviceImpact/engine.ts#evaluateServiceMap', 68],
  ['apps/web/src/pages/admin/BusinessRulesPage.tsx#BusinessRulesPage', 67],
  ['apps/web/src/pages/dashboard/useWidgetConfig.ts#useWidgetConfig', 61],
  ['apps/api/src/anomaly/ruleConfig.ts#assertAnomalyRuleSettings', 72], // 24 Sep 2026: the severity outside production is validated (G33)
  ['apps/api/src/lib/reportDesignProposal.ts#filtriValidi', 66],
  ['apps/api/src/scripts/seed-relations.ts#seed', 65],
  // 23 Sep 2026: +3, the initial step must survive a save and a timed wait keeps a valid delay.
  ['apps/api/src/graphql/resolvers/workflowMutations.ts#saveWorkflowChanges', 67],
  ['apps/api/src/lib/reportQueryBuilder.ts#validateReportSection', 63],
  ['packages/web-core/src/tokenRefresh.ts#createTokenRefresh', 63],
  ['apps/api/src/lib/reportValueLabels.ts#loadReportValueLabeler', 62],
  ['apps/web/src/pages/proposals/ProposalsPage.tsx#ProposalsPage', 65], // 24 Sep 2026: the proposals decided are told apart (G44)
  ['apps/web/src/pages/settings/useSyncPage.ts#useSyncPage', 62],
  ['apps/api/src/telemetry.ts#initTelemetry', 61],
])

function sorgenti(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'dist', '__tests__', 'test'].includes(n)) continue
      sorgenti(p, out)
    } else if (/\.tsx?$/.test(n) && !n.includes('.test.')) out.push(p)
  }
  return out
}

const files = ['apps/api/src', 'apps/web/src', 'apps/portal/src', 'apps/console/src', 'packages']
  .flatMap((b) => sorgenti(join(RADICE, b)))

const trovate = []
let anonime = 0
for (const f of files) {
  const testo = readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, testo, ts.ScriptTarget.ES2022, true,
    f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visita = (n) => {
    const corpo = (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
      || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) ? n.body : null
    if (corpo && ts.isBlock(corpo)) {
      let istruzioni = 0
      const conta = (x) => { if (ts.isStatement(x) && !ts.isBlock(x)) istruzioni++; x.forEachChild(conta) }
      corpo.forEachChild(conta)
      if (istruzioni > TETTO) {
        const nome = (n.name && ts.isIdentifier(n.name) ? n.name.text : null)
          ?? (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null)
          ?? (ts.isPropertyAssignment(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null)
        const riga = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
        if (nome === null) anonime++
        else trovate.push({ chiave: `${relative(RADICE, f)}#${nome}`, istruzioni, riga })
      }
    }
    n.forEachChild(visita)
  }
  visita(sf)
}

const nuove = [], cresciute = [], scese = []
for (const t of trovate) {
  const nota = NOTE.get(t.chiave)
  if (nota === undefined) { nuove.push(t); continue }
  if (t.istruzioni > nota) cresciute.push({ ...t, nota })
  else if (t.istruzioni < nota) scese.push({ ...t, nota })
}
const viste = new Set(trovate.map((t) => t.chiave))
const sparite = [...NOTE.keys()].filter((k) => !viste.has(k))

if (verbose) for (const t of trovate.sort((a, b) => b.istruzioni - a.istruzioni)) {
  console.log(`  ${String(t.istruzioni).padStart(4)}  ${t.chiave}:${t.riga}`)
}

let rosso = false
if (nuove.length > 0) {
  rosso = true
  console.error(`check-funzioni-lunghe: ${nuove.length} funzioni NUOVE sopra le ${TETTO} istruzioni:`)
  for (const t of nuove.sort((a, b) => b.istruzioni - a.istruzioni)) {
    console.error(`  ${String(t.istruzioni).padStart(4)}  ${t.chiave} (riga ${t.riga})`)
  }
  console.error('\nSpezzala, oppure mettila nell\'elenco di scripts/check-funzioni-lunghe.mjs dicendo perché resta intera.')
}
if (cresciute.length > 0) {
  rosso = true
  console.error(`\ncheck-funzioni-lunghe: ${cresciute.length} funzioni sono CRESCIUTE oltre il loro numero:`)
  for (const t of cresciute) console.error(`  ${t.chiave}: era ${t.nota}, ora ${t.istruzioni} (riga ${t.riga})`)
  console.error('\nIl terreno si guadagna, non si perde: o si torna sotto, o si dichiara il numero nuovo con una ragione.')
}
if (sparite.length > 0) {
  rosso = true
  console.error(`\ncheck-funzioni-lunghe: ${sparite.length} voci dell'elenco non esistono più nei sorgenti:`)
  for (const k of sparite) console.error(`  ${k}`)
  console.error('\nToglile: un elenco che nomina cose che non ci sono più smette di dire la verità.')
}
if (anonime > ANONIME_MASSIME) {
  rosso = true
  console.error(`\ncheck-funzioni-lunghe: le funzioni ANONIME sopra le ${TETTO} istruzioni sono ${anonime}, il tetto è ${ANONIME_MASSIME}.`)
  console.error('Dai un nome a quella nuova (così entra nell\'elenco e si può seguire) oppure spezzala.')
}
if (rosso) process.exit(1)

console.log(
  `check-funzioni-lunghe: ${trovate.length} funzioni con nome sopra le ${TETTO} istruzioni`
  + ` (tetto di ognuna rispettato), ${anonime} anonime su un massimo di ${ANONIME_MASSIME}.`,
)
if (scese.length > 0) {
  console.log(`  ${scese.length} sono RIMPICCIOLITE: aggiorna il numero nell'elenco per tenere il terreno.`)
  for (const t of scese) console.log(`    ${t.chiave}: era ${t.nota}, ora ${t.istruzioni}`)
}
