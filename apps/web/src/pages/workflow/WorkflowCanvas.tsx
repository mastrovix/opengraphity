import { useTranslation } from 'react-i18next'
import { createContext, memo, useCallback, useContext, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  getSmoothStepPath,
  BaseEdge,
  EdgeLabelRenderer,
  ConnectionMode,
} from '@xyflow/react'
import type { NodeProps, EdgeProps, Node, Edge, OnNodesChange, OnEdgesChange } from '@xyflow/react'
import { Pencil, Settings2 } from 'lucide-react'
import { colors, lookupOrError, palette } from '@/lib/tokens'
import type { StepNodeData, EdgeNodeData, WorkflowDefinition, WorkflowKey } from './workflow-types'

// ── LE DISPOSIZIONI DELLA TELA ────────────────────────────────────────────────
//
// Dove sta ogni passo e da quale lato esce ogni freccia, per i workflow che
// OpenGrafo semina. È cosmetica: il dominio non dipende da queste tabelle, e un
// workflow che non c'è (disegnato dal cliente, o un tipo di entità nuovo) prende
// la fila automatica e gli archi destra→sinistra.
//
// ## Perché sono state riscritte (22 set 2026)
// Le tabelle di prima — `STANDARD_*`, `NORMAL_*`, `EMERGENCY_*` — nominavano i
// passi di quando si pensava a UNA DEFINIZIONE PER TIPO DI CHANGE:
// `draft → assessment → cab_approval → validation → completed → failed`. Quella
// forma non esiste più da nessuna parte. La definizione «Change RFC Process»
// spedita oggi ha `assessment → approval → scheduled → deployment → review →
// closed`: zero chiavi in comune. Quindi la tela delle change — e quella delle
// richieste di servizio, dei problem, degli articoli KB — non usava NESSUNA
// disposizione su misura: cadeva sempre sulla fila automatica.
//
// Il commento in `useWorkflowDesigner.ts` sosteneva il contrario («sono le
// disposizioni scritte per i passi che quella definizione ha davvero»). Era
// falso, ed è la ragione per cui il difetto è sopravvissuto a una revisione.
//
// ## La prova
// `disposizioniDellaTela.test.ts` (apps/api) legge QUESTO file e le definizioni
// seminate, e pretende che combacino in tutte e due i versi: nessuna chiave che
// nomini un passo o una transizione inesistente, e nessun passo o transizione
// senza la sua riga. Un rinominare un passo nel seed fa cadere il test.

// ── Incident ──────────────────────────────────────────────────────────────────
// Due definizioni: quella base e quella di sicurezza, che infila
// `security_review` fra `assigned` e `in_progress`. La deviazione sta sopra la
// fila, come l'escalation.

export const INCIDENT_POSITIONS: Record<string, { x: number; y: number }> = {
  new:             { x: 0,    y: 280 },
  assigned:        { x: 280,  y: 280 },
  security_review: { x: 420,  y: 0   },
  in_progress:     { x: 560,  y: 280 },
  escalated:       { x: 840,  y: 0   },
  pending:         { x: 560,  y: 560 },
  resolved:        { x: 1120, y: 280 },
  closed:          { x: 1400, y: 280 },
}

export const INCIDENT_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'new→assigned':                     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'assigned→in_progress':             { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'assigned→security_review':         { sourceHandle: 'src-top',    targetHandle: 'tgt-left'   },
  'security_review→in_progress':      { sourceHandle: 'src-right',  targetHandle: 'tgt-top'    },
  'security_review→assigned':         { sourceHandle: 'src-left',   targetHandle: 'tgt-top'    },
  'resolved→closed':                  { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'in_progress→escalated→manual':     { sourceHandle: 'src-top',    targetHandle: 'tgt-left'   },
  'in_progress→escalated→sla_breach': { sourceHandle: 'src-top',    targetHandle: 'tgt-bottom' },
  'escalated→in_progress':            { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'escalated→resolved':               { sourceHandle: 'src-right',  targetHandle: 'tgt-top'    },
  'in_progress→pending':              { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'pending→in_progress':              { sourceHandle: 'src-top',    targetHandle: 'tgt-bottom' },
  'in_progress→resolved':             { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'resolved→in_progress':             { sourceHandle: 'src-left',   targetHandle: 'tgt-right'  },
}

export const INCIDENT_BACK = new Set([
  'pending→in_progress', 'escalated→in_progress', 'resolved→in_progress', 'security_review→assigned',
])

// ── Change RFC Process ────────────────────────────────────────────────────────
// Una fila sola: il rigetto è l'unico arco che torna indietro, e passa sotto.

export const CHANGE_POSITIONS: Record<string, { x: number; y: number }> = {
  assessment: { x: 0,    y: 280 },
  approval:   { x: 280,  y: 280 },
  scheduled:  { x: 560,  y: 280 },
  deployment: { x: 840,  y: 280 },
  review:     { x: 1120, y: 280 },
  closed:     { x: 1400, y: 280 },
}

export const CHANGE_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'assessment→approval':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'approval→scheduled':   { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'approval→assessment':  { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
  'scheduled→deployment': { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'deployment→review':    { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'review→closed':        { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
}

export const CHANGE_BACK = new Set(['approval→assessment'])

// ── Service Request Fulfillment ───────────────────────────────────────────────
// «Prendi in carico» scavalca l'approvazione: passa sopra. Il rifiuto è
// terminale, sta sotto e non torna.

export const SERVICE_REQUEST_POSITIONS: Record<string, { x: number; y: number }> = {
  submitted:   { x: 0,    y: 280 },
  approval:    { x: 280,  y: 280 },
  in_progress: { x: 560,  y: 280 },
  fulfilled:   { x: 840,  y: 280 },
  closed:      { x: 1120, y: 280 },
  // Non sotto `approval`: la' c'e' la legenda (vedi `PROBLEM_POSITIONS`).
  rejected:    { x: 560,  y: 560 },
}

export const SERVICE_REQUEST_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'submitted→approval':    { sourceHandle: 'src-right',  targetHandle: 'tgt-left'  },
  'submitted→in_progress': { sourceHandle: 'src-top',    targetHandle: 'tgt-top'   },
  'approval→in_progress':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left'  },
  'approval→rejected':     { sourceHandle: 'src-bottom', targetHandle: 'tgt-left'  },
  'in_progress→fulfilled': { sourceHandle: 'src-right',  targetHandle: 'tgt-left'  },
  'fulfilled→closed':      { sourceHandle: 'src-right',  targetHandle: 'tgt-left'  },
}

export const SERVICE_REQUEST_BACK = new Set<string>([])

// ── Problem Management ────────────────────────────────────────────────────────
// `under_investigation` è il perno: quasi tutto ci torna. Le vie di ritorno
// passano sotto la fila, l'analisi posticipata e il rigetto stanno sulla riga
// di sotto.

export const PROBLEM_POSITIONS: Record<string, { x: number; y: number }> = {
  new:                 { x: 0,    y: 280 },
  under_investigation: { x: 280,  y: 280 },
  known_error:         { x: 560,  y: 280 },
  change_requested:    { x: 840,  y: 280 },
  change_in_progress:  { x: 1120, y: 280 },
  resolved:            { x: 1400, y: 280 },
  closed:              { x: 1680, y: 280 },
  // Non sotto `new` e `under_investigation`: l'angolo in basso a sinistra della
  // tela e' occupato dalla LEGENDA, che e' un pannello fisso sullo schermo e
  // non si sposta con la vista. Un passo messo li' resta nascosto finche' non
  // si trascina la tela — visto aprendo il disegnatore, non deducibile dalle
  // coordinate.
  deferred:            { x: 560,  y: 560 },
  rejected:            { x: 840,  y: 560 },
}

export const PROBLEM_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'new→under_investigation':                 { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'under_investigation→known_error':         { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'under_investigation→change_requested':    { sourceHandle: 'src-top',    targetHandle: 'tgt-top'    },
  'under_investigation→rejected':            { sourceHandle: 'src-bottom', targetHandle: 'tgt-left'   },
  'under_investigation→deferred':            { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'deferred→under_investigation':            { sourceHandle: 'src-top',    targetHandle: 'tgt-bottom' },
  'known_error→change_requested':            { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'known_error→resolved':                    { sourceHandle: 'src-top',    targetHandle: 'tgt-top'    },
  'change_requested→change_in_progress':     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'change_requested→under_investigation':    { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
  'change_in_progress→resolved':             { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'change_in_progress→under_investigation':  { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
  'resolved→closed':                         { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'resolved→under_investigation':            { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
}

export const PROBLEM_BACK = new Set([
  'deferred→under_investigation', 'change_requested→under_investigation',
  'change_in_progress→under_investigation', 'resolved→under_investigation',
])

// ── KB Article Lifecycle ──────────────────────────────────────────────────────
// Tre ritorni alla bozza (dalla revisione, dal pubblicato, dall'archiviato) e
// una scorciatoia bozza→archiviato che passa sopra.

export const KB_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:          { x: 0,   y: 280 },
  pending_review: { x: 280, y: 280 },
  published:      { x: 560, y: 280 },
  archived:       { x: 840, y: 280 },
}

export const KB_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→pending_review':     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'draft→archived':           { sourceHandle: 'src-top',    targetHandle: 'tgt-top'    },
  'pending_review→published': { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'pending_review→draft':     { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
  'published→archived':       { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'published→draft':          { sourceHandle: 'src-bottom', targetHandle: 'tgt-bottom' },
  'archived→draft':           { sourceHandle: 'src-bottom', targetHandle: 'tgt-left'   },
}

export const KB_BACK = new Set(['pending_review→draft', 'published→draft', 'archived→draft'])

// ── La tabella unica ──────────────────────────────────────────────────────────

export interface Disposizione {
  positions: Record<string, { x: number; y: number }>
  handles:   Record<string, { sourceHandle: string; targetHandle: string }>
  back:      Set<string>
}

/**
 * `none` è la scelta esplicita per tutto ciò che OpenGrafo non semina: fila
 * automatica, archi destra→sinistra, nessun arco all'indietro. Vuota di
 * proposito — non è un buco, è il caso normale di un workflow che il cliente si
 * è disegnato da solo.
 */
export const DISPOSIZIONI: Record<WorkflowKey, Disposizione> = {
  incident:        { positions: INCIDENT_POSITIONS,        handles: INCIDENT_HANDLES,        back: INCIDENT_BACK },
  change:          { positions: CHANGE_POSITIONS,          handles: CHANGE_HANDLES,          back: CHANGE_BACK },
  service_request: { positions: SERVICE_REQUEST_POSITIONS, handles: SERVICE_REQUEST_HANDLES, back: SERVICE_REQUEST_BACK },
  problem:         { positions: PROBLEM_POSITIONS,         handles: PROBLEM_HANDLES,         back: PROBLEM_BACK },
  kb_article:      { positions: KB_POSITIONS,              handles: KB_HANDLES,              back: KB_BACK },
  none:            { positions: {},                        handles: {},                      back: new Set<string>() },
}

// ── Step node visual ──────────────────────────────────────────────────────────

export const STEP_BG: Record<string, string> = {
  start:          palette.success.bg,
  end:            palette.neutral.surface1,
  standard:       colors.white,
  parallel_fork:  palette.info.bg,
  parallel_join:  palette.success.bg,
  timer_wait:     palette.orange.bg,
  sub_workflow:   palette.purple.bg,
}

export const TRIGGER_COLOR: Record<string, string> = {
  manual:     colors.trigger.manual,
  automatic:  colors.trigger.automatic,
  sla_breach: colors.trigger.slaBreach,
  timer:      colors.trigger.timer,
}

const ACCENT_COLOR = colors.brand

// ── Custom Node ───────────────────────────────────────────────────────────────

const WorkflowStepNode = memo(function WorkflowStepNode({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const { step, accentColor } = data as StepNodeData
  const bg = lookupOrError(STEP_BG, step.type, 'STEP_BG', 'var(--color-danger)')

  /*
   * IL RISALTO STA NEL CSS, NON IN UNO STATO REACT (21 set 2026).
   *
   * Qui c'era `onMouseEnter`/`onMouseLeave` che accendevano `hovered`, e da
   * `hovered` dipendevano il colore del bordo e la matita in alto a destra.
   * Chi arriva su questo riquadro col tasto Tab non ha un puntatore: quel
   * risalto non lo vedeva mai. Ora `.og-wf-node` in `index.css` risponde sia
   * a `:hover` sia al fuoco del nodo di React Flow, e il colore d'accento
   * passa come variabile perche' lo decide il nodo, non il foglio di stile.
   */
  return (
    <div
      className={selected ? 'og-wf-node is-selected' : 'og-wf-node'}
      style={{
        width:           160,
        minHeight:       80,
        padding:         12,
        borderRadius:    10,
        borderWidth:     2,
        borderStyle:     'solid',
        backgroundColor: bg,
        boxShadow:       selected ? '0 0 0 3px var(--color-brand-a20)' : '0 2px 8px var(--color-black-a08)',
        position:        'relative',
        transition:      'box-shadow 0.15s, border-color 0.15s',
        cursor:          'default',
        ['--og-wf-accent' as string]: accentColor,
      } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Top}    id="tgt-top"    style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Bottom} id="tgt-bottom" style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Left}   id="tgt-left"   style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Right}  id="tgt-right"  style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />

      <div style={{
        display:         'inline-block',
        fontSize:        9,
        fontWeight:      700,
        letterSpacing:   '0.07em',
        textTransform:   'uppercase',
        color:           accentColor,
        backgroundColor: step.type === 'standard' ? 'var(--color-brand-a08)' : 'var(--color-brand-a13)',
        padding:         '1px 6px',
        borderRadius:    4,
        marginBottom:    6,
      }}>
        {/*
          * I tipi speciali si dicono nella lingua del cliente: erano
          * letterali inglesi («FORK», «SUB»). I tre che il motore NON esegue
          * restano disegnabili a schermo — un'installazione che li ha salvati
          * deve poterli leggere — ma dall'ondata 10 non si aggiungono più.
          */}
        {step.type === 'start'         ? 'START'
        : step.type === 'end'           ? 'END'
        : step.type === 'parallel_fork' ? `⑂ ${t('workflow.stepType.parallel_fork')}`
        : step.type === 'parallel_join' ? `⑂ ${t('workflow.stepType.parallel_join')}`
        : step.type === 'timer_wait'    ? `⏱ ${t('workflow.stepType.timer_wait')}`
        : step.type === 'sub_workflow'  ? `⊞ ${t('workflow.stepType.sub_workflow')}`
        : step.name.replace(/_/g, ' ')}
      </div>

      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)', lineHeight: 1.3, marginBottom: 4 }}>
        {step.label}
      </div>

      <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
        {step.name}
      </div>

      <div className="og-wf-edit-hint" style={{ position: 'absolute', top: 6, right: 6, color: accentColor, opacity: 0.7 }}>
        <Pencil size={12} />
      </div>

      <Handle type="source" position={Position.Top}    id="src-top"    style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Bottom} id="src-bottom" style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Left}   id="src-left"   style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Right}  id="src-right"  style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
    </div>
  )
})

/*
 * COME L'ETICHETTA DI UNA TRANSIZIONE APRE LA TRANSIZIONE (21 set 2026).
 *
 * `WorkflowEdge` sta fuori dal componente (e deve starci: `edgeTypes` va
 * definito una volta sola, se no React Flow ridisegna tutto a ogni render),
 * quindi non puo' chiudere sulla `onEdgeClick` che arriva come prop. Il
 * contesto e' il modo di passargliela senza rimetterla dentro.
 *
 * Serve perche' l'etichetta e' disegnata da `EdgeLabelRenderer`, che la
 * porta FUORI dall'SVG: un clic li' sopra non arriva mai all'arco, e quindi
 * `onEdgeClick` non scattava. Il `cursor: pointer` e l'ingranaggio
 * promettevano un'azione che non c'era.
 */
const ApriTransizione = createContext<((id: string, e: React.MouseEvent) => void) | null>(null)

// ── Custom Edge ───────────────────────────────────────────────────────────────

const WorkflowEdge = memo(function WorkflowEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected, animated, markerEnd,
}: EdgeProps) {
  const { t } = useTranslation()
  const { transition, color } = (data ?? {}) as EdgeNodeData
  const [hovered, setHovered] = useState(false)
  const apriTransizione = useContext(ApriTransizione)

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  })

  const strokeColor = color ?? 'var(--color-slate)'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke:          strokeColor,
          strokeWidth:     selected || hovered ? 2.5 : 1.5,
          strokeDasharray: animated ? '6 3' : undefined,
          opacity:         selected || hovered ? 1 : 0.7,
          transition:      'stroke-width 0.15s, opacity 0.15s',
        }}
      />

      <EdgeLabelRenderer>
        {/*
          * Un BOTTONE, non un div: si raggiunge col Tab, si attiva con Invio e
          * lo stesso risalto che dava il mouse lo da' adesso anche il fuoco
          * (`onFocus`/`onBlur` accanto a `onMouseEnter`/`onMouseLeave`, perche'
          * da qui dipende anche lo spessore dell'arco, che sta in un altro
          * pezzo di DOM e il CSS non lo raggiunge).
          */}
        <button
          type="button"
          className={selected ? 'og-wf-edge-label is-selected' : 'og-wf-edge-label'}
          aria-label={t('pages.workflow.openTransition', { name: transition?.label ?? '' })}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          /*
            * `stopPropagation`: il clic non deve arrivare anche al riquadro
            * sotto. L'etichetta e' disegnata in un portale dentro il
            * contenitore di React Flow, e lasciarlo risalire significherebbe
            * aprire il pannello e richiuderlo subito con un `onPaneClick`.
            */
          onClick={(e) => { e.stopPropagation(); apriTransizione?.(id, e) }}
          style={{
            position:      'absolute',
            transform:     `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            ['--og-wf-edge-color' as string]: strokeColor,
          } as React.CSSProperties}
        >
          {transition?.label ?? ''}
          {(hovered || selected) && <Settings2 size={10} />}
        </button>
      </EdgeLabelRenderer>
    </>
  )
})

// ── nodeTypes / edgeTypes — defined outside component to avoid re-renders ──────

export const nodeTypes = { workflowStep: WorkflowStepNode }
export const edgeTypes  = { workflowEdge: WorkflowEdge }

// ── WorkflowCanvas Component ──────────────────────────────────────────────────

interface WorkflowCanvasProps {
  nodes:          Node[]
  edges:          Edge[]
  onNodesChange:  OnNodesChange
  onEdgesChange:  OnEdgesChange
  onNodeClick:    (e: React.MouseEvent, node: Node) => void
  onEdgeClick:    (e: React.MouseEvent, edge: Edge) => void
  onPaneClick:    () => void
  onReconnect:    (oldEdge: Edge, newConnection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => void
  onConnect?:     (connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => void
  loading:        boolean
  def:            WorkflowDefinition | null
  children?:      React.ReactNode
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onReconnect,
  onConnect,
  loading,
  def,
  children,
}: WorkflowCanvasProps) {
  const { t } = useTranslation()
  const accentColor = ACCENT_COLOR

  /*
   * L'etichetta di un arco e' fuori dall'SVG (vedi `ApriTransizione`): il suo
   * clic va rimandato a mano alla stessa `onEdgeClick` dell'arco.
   *
   * GLI ARCHI PASSANO DA UN REF, non dalle dipendenze (revisione del 21 set
   * 2026). Con `[edges, onEdgeClick]` questa funzione cambiava identita' a
   * ogni render del disegnatore — `edges` e' un array nuovo ogni volta — e
   * con lei il valore del contesto: un componente che legge un contesto si
   * ridisegna quando quel valore cambia ANCHE se e' `memo`, quindi ogni
   * spostamento di un nodo ridisegnava tutte le etichette. Il ref tiene gli
   * archi aggiornati senza toccare l'identita' della funzione.
   */
  const archiRef = useRef(edges)
  archiRef.current = edges
  const apriTransizione = useCallback((id: string, e: React.MouseEvent) => {
    const arco = archiRef.current.find((x) => x.id === id)
    if (arco) onEdgeClick(e, arco)
  }, [onEdgeClick])

  return (
    <ApriTransizione.Provider value={apriTransizione}>
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', width: '100%', height: 'calc(var(--vh-app) - 120px)' }}>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
          {t('pages.workflow.loading')}
        </div>
      ) : !def ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
          {t('pages.workflow.noneForTenant')}
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="light"
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={2}
          edgesFocusable={true}
          edgesReconnectable={true}
          connectionLineStyle={{ stroke: accentColor, strokeWidth: 2 }}
          isValidConnection={() => true}
          connectionMode={ConnectionMode.Loose}
          onReconnect={onReconnect}
          onConnect={onConnect}
        >
          <Background color={colors.border} gap={20} size={1} />
          <Controls position="bottom-left" style={{ marginBottom: 80 }} />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const step = (n.data as StepNodeData | undefined)?.step
              return lookupOrError(STEP_BG, step?.type ?? 'standard', 'STEP_BG', 'var(--color-danger)')
            }}
            style={{ border: '1px solid var(--color-border)', borderRadius: 8 }}
          />
        </ReactFlow>
      )}

      {children}

      {/* Legend */}
      {def && (
        <div style={{
          position:        'absolute',
          bottom:          80,
          left:            16,
          zIndex:          10,
          backgroundColor: colors.white,
          border:          '1px solid var(--color-border)',
          borderRadius:    8,
          padding:         '10px 14px',
          display:         'flex',
          flexDirection:   'column',
          gap:             6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: colors.brand }} />
            <span style={{ fontSize: 'var(--font-size-body)', color: colors.slate }}>{t('workflow.legend.node')}</span>
          </div>
          {[
            { color: colors.trigger.manual,     labelKey: 'workflow.legend.manual' },
            { color: colors.trigger.automatic,  labelKey: 'workflow.legend.automatic' },
            { color: colors.trigger.slaBreach,  labelKey: 'workflow.legend.slaBreach' },
            { color: colors.trigger.timer,      labelKey: 'workflow.legend.timer' },
          ].map(({ color, labelKey }) => (
            <div key={labelKey} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 20, height: 2, backgroundColor: color, borderRadius: 1 }} />
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t(labelKey)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
    </ApriTransizione.Provider>
  )
}
