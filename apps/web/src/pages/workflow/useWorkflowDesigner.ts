import { useEffect, useState, useCallback, useRef } from 'react'
import { useNodesState, useEdgesState, MarkerType } from '@xyflow/react'
import type { Node, Edge, OnNodesChange } from '@xyflow/react'
import type {
  WorkflowDefinition,
  WorkflowKey,
  StepNodeData,
  EdgeNodeData,
  PendingTransitionChange,
  WFStep,
  WFTransition,
} from './workflow-types'
import { DISPOSIZIONI, TRIGGER_COLOR } from './WorkflowCanvas'
import { colors, lookupOrError } from '@/lib/tokens'

const ACCENT_COLOR = colors.brand

/**
 * Quale disposizione della tela usare. È una scelta COSMETICA (dove nasce un
 * passo, da quale lato esce una freccia), non una regola di dominio.
 *
 * B-25: la scelta si faceva annusando il NOME della definizione
 * (`name.includes('standard' | 'normal' | 'emergency')`), residuo di quando si
 * pensava a una definizione per tipo di change. Nessuna definizione spedita si
 * chiama così — quindi quei tre rami non si sono mai accesi — ma un cliente che
 * chiamasse la sua definizione «Emergenza normale» si vedeva cambiare la
 * disposizione senza capire perché. Decide il tipo di entità, che non si
 * rinomina.
 *
 * CHIUSO il 22 set 2026: allora restava aperto che le tabelle non-incident
 * nominassero passi inesistenti, quindi la tela di change, richieste, problem e
 * KB cadeva sempre sulla fila automatica. Ora ogni workflow seminato ha la sua
 * disposizione, e `disposizioniDellaTela.test.ts` pretende che combaci coi
 * passi veri. Tutto il resto — i workflow che il cliente si disegna — prende
 * `none`, che è la fila automatica DICHIARATA, non un buco.
 */
export function defToWorkflowKey(def: WorkflowDefinition | null): WorkflowKey {
  if (!def) return 'incident'
  const chiave = def.entityType as WorkflowKey
  return chiave in DISPOSIZIONI && chiave !== 'none' ? chiave : 'none'
}

export interface PendingStepChange {
  stepName:     string
  label:        string
  enterActions: string | null
  exitActions:  string | null
  isInitial?:   boolean
  isTerminal?:  boolean
  isOpen?:      boolean
  category?:    string | null
  /** Scopo del passo: assente = non cambia, '' = tolto, altrimenti uno di WORKFLOW_STEP_PURPOSES. */
  purpose?:     string | null
  /** Scadenza del passo: assente = non cambia, '' = tolta, altrimenti il JSON. */
  deadline?:    string | null
}

export function useWorkflowDesigner(def: WorkflowDefinition | null) {
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hasChanges,         setHasChanges]         = useState(false)
  const [pendingChanges,     setPendingChanges]     = useState<PendingTransitionChange[]>([])
  const [pendingStepChanges, setPendingStepChanges] = useState<PendingStepChange[]>([])

  // Modifiche locali non ancora salvate, lette al rebuild (refetch dopo
  // add/remove di step o transizioni) per non farle sparire dal canvas pur
  // restando in coda per il Salva. Ref e non dep dell'effetto: un rebuild a
  // ogni "Salva localmente" chiuderebbe il pannello e resetterebbe la selezione.
  const pendingStepRef = useRef<PendingStepChange[]>([])
  const pendingTrRef   = useRef<PendingTransitionChange[]>([])
  const draggedPosRef  = useRef<Record<string, { x: number; y: number }>>({})
  pendingStepRef.current = pendingStepChanges
  pendingTrRef.current   = pendingChanges

  const selectedWorkflow = defToWorkflowKey(def)

  // Il solo drag di un nodo è una modifica da salvare (le posizioni vanno in
  // saveWorkflowChanges.positions): prima non abilitava "Salva".
  const onNodesChange: OnNodesChange<Node> = useCallback((changes) => {
    onNodesChangeBase(changes)
    for (const c of changes) {
      if (c.type === 'position' && !c.dragging && c.position) {
        draggedPosRef.current[c.id] = { x: c.position.x, y: c.position.y }
        setHasChanges(true)
      }
    }
  }, [onNodesChangeBase])

  /** Dopo un salvataggio riuscito: le modifiche sono ora nel `def` refetchato. */
  const clearLocalChanges = useCallback(() => {
    setPendingChanges([])
    setPendingStepChanges([])
    draggedPosRef.current = {}
    setHasChanges(false)
  }, [])

  // ── Build nodes / edges from definition ──────────────────────────────────────
  useEffect(() => {
    if (!def) return

    const { positions, handles: edgeHandles, back: backTransitions } = DISPOSIZIONI[selectedWorkflow]

    const accentColor = ACCENT_COLOR

    const stepById: Record<string, string> = {}
    def.steps.forEach((s) => { stepById[s.name] = s.id })

    const pendingStepByName = new Map(pendingStepRef.current.map((c) => [c.stepName, c]))
    const pendingTrById     = new Map(pendingTrRef.current.map((c) => [c.transitionId, c]))

    const newNodes: Node[] = def.steps.map((step, index) => {
      // Sorgente del layout, in ordine: drag non ancora salvato → posizione
      // salvata sul server → tabella curata del workflow seed → fila di default.
      const dragged = draggedPosRef.current[step.id]
      const saved   = (step.positionX != null && step.positionY != null)
        ? { x: step.positionX, y: step.positionY }
        : null
      const position = dragged ?? saved ?? positions[step.name] ?? { x: index * 220, y: 200 }
      const pending  = pendingStepByName.get(step.name)
      const mergedStep: WFStep = pending
        ? { ...step, label: pending.label, enterActions: pending.enterActions, exitActions: pending.exitActions,
            isInitial: pending.isInitial, isTerminal: pending.isTerminal, isOpen: pending.isOpen,
            category: pending.category, purpose: pending.purpose ?? null,
            deadline: pending.deadline === undefined ? step.deadline : (pending.deadline || null) }
        : step
      return {
        id:       step.id,
        type:     'workflowStep',
        position,
        data:     { step: mergedStep, accentColor } satisfies StepNodeData,
      }
    })

    const newEdges: Edge[] = def.transitions.map((serverTr) => {
      const pending = pendingTrById.get(serverTr.id)
      const tr: WFTransition = pending ? { ...serverTr, ...pending } : serverTr
      const edgeColor  = lookupOrError(TRIGGER_COLOR, tr.trigger, 'TRIGGER_COLOR', 'var(--color-danger)')
      const baseKey    = `${tr.fromStepName}→${tr.toStepName}`
      const triggerKey = `${tr.fromStepName}→${tr.toStepName}→${tr.trigger}`
      const isBack     = backTransitions.has(baseKey)
      // Prefer handles stored on the transition (user-drawn edges); fall back to
      // the curated layout tables for the seed workflows, then a default.
      const stored     = (tr.sourceHandle && tr.targetHandle)
        ? { sourceHandle: tr.sourceHandle, targetHandle: tr.targetHandle }
        : null
      const handles    = stored ?? edgeHandles[triggerKey] ?? edgeHandles[baseKey] ?? { sourceHandle: 'src-right', targetHandle: 'tgt-left' }

      if (isBack) {
        return {
          id:           tr.id,
          source:       stepById[tr.fromStepName] ?? tr.fromStepName,
          target:       stepById[tr.toStepName]   ?? tr.toStepName,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type:         'workflowEdge',
          animated:     true,
          style:        { stroke: edgeColor, strokeWidth: 1.5, strokeDasharray: '6,3' },
          markerEnd:    { type: MarkerType.ArrowClosed, width: 14, height: 14, color: edgeColor },
          data:         { transition: { ...tr, label: '' }, color: edgeColor } satisfies EdgeNodeData,
        }
      }

      return {
        id:                  tr.id,
        source:              stepById[tr.fromStepName] ?? tr.fromStepName,
        target:              stepById[tr.toStepName]   ?? tr.toStepName,
        sourceHandle:        handles.sourceHandle,
        targetHandle:        handles.targetHandle,
        type:                'workflowEdge',
        animated:            false,
        style:               { stroke: edgeColor, strokeWidth: 2 },
        markerEnd:           { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor },
        labelStyle:          { fontSize: 'var(--font-size-body)', fontWeight: 500, fill: 'var(--color-slate)' },
        labelBgStyle:        { fill: colors.white, fillOpacity: 1, stroke: edgeColor, strokeWidth: 1 },
        labelBgPadding:      [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        data:                { transition: tr, color: edgeColor } satisfies EdgeNodeData,
      }
    })

    setNodes(newNodes)
    setEdges(newEdges)
    // La selezione sopravvive al refetch se l'elemento esiste ancora (es. dopo
    // aver disegnato una transizione l'utente vuole impostarne il trigger).
    setSelectedNodeId((prev) => prev && newNodes.some((n) => n.id === prev) ? prev : null)
    setSelectedEdgeId((prev) => prev && newEdges.some((e) => e.id === prev) ? prev : null)
  }, [def, selectedWorkflow, setNodes, setEdges])

  // ── Click handlers ────────────────────────────────────────────────────────────
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    setSelectedEdgeId(null)
    setEdges((es) => es.map((e) => ({ ...e, selected: false })))
  }, [setEdges])

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id)
    setSelectedNodeId(null)
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))
  }, [setNodes])

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
  }, [])

  const handleSaveLocally = useCallback((change: PendingTransitionChange) => {
    setPendingChanges((prev) => {
      const idx = prev.findIndex((c) => c.transitionId === change.transitionId)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = change
        return updated
      }
      return [...prev, change]
    })
    setHasChanges(true)
  }, [])

  const handleSaveStepLocally = useCallback((change: PendingStepChange) => {
    setPendingStepChanges((prev) => {
      const idx = prev.findIndex((c) => c.stepName === change.stepName)
      if (idx >= 0) {
        const updated = [...prev]
        // Unione, non sostituzione: un campo che il pannello manda solo quando
        // CAMBIA (la scadenza) non deve sparire al secondo salvataggio locale.
        updated[idx] = { ...prev[idx], ...change }
        return updated
      }
      return [...prev, change]
    })
    setHasChanges(true)
  }, [])

  // ── Selected data ─────────────────────────────────────────────────────────────
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null
  const selectedStep = selectedNode ? (selectedNode.data as StepNodeData).step : null
  const selectedTr   = selectedEdge ? (selectedEdge.data as EdgeNodeData).transition : null

  // ── Save callbacks ────────────────────────────────────────────────────────────
  function onStepSaved(updated: Partial<WFStep>) {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selectedNodeId
          ? { ...n, data: { step: { ...(n.data as StepNodeData).step, ...updated }, accentColor: ACCENT_COLOR } }
          : n,
      ),
    )
  }

  function onEdgeSaved(updated: Partial<WFTransition>) {
    setEdges((es) =>
      es.map((e) =>
        e.id === selectedEdgeId
          ? { ...e, data: { ...(e.data as EdgeNodeData), transition: { ...(e.data as EdgeNodeData).transition, ...updated } } }
          : e,
      ),
    )
  }

  const handleReconnect = useCallback((
    oldEdge: Edge,
    newConnection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  ) => {
    setEdges((eds) =>
      eds.map((e) =>
        e.id === oldEdge.id
          ? {
              ...e,
              source:       newConnection.source,
              target:       newConnection.target,
              sourceHandle: newConnection.sourceHandle ?? e.sourceHandle,
              targetHandle: newConnection.targetHandle ?? e.targetHandle,
            }
          : e,
      ),
    )
  }, [setEdges])

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    selectedNodeId,
    selectedEdgeId,
    setSelectedNodeId,
    setSelectedEdgeId,
    selectedStep,
    selectedTr,
    hasChanges,
    pendingChanges,
    selectedWorkflow,
    setHasChanges,
    setPendingChanges,
    clearLocalChanges,
    handleNodeClick,
    handleEdgeClick,
    handlePaneClick,
    handleSaveLocally,
    handleSaveStepLocally,
    handleReconnect,
    onStepSaved,
    onEdgeSaved,
    pendingStepChanges,
    setPendingStepChanges,
  }
}
