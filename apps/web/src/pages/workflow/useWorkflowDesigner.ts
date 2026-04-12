import { useEffect, useState, useCallback } from 'react'
import { useNodesState, useEdgesState, MarkerType } from '@xyflow/react'
import type { Node, Edge } from '@xyflow/react'
import type {
  WorkflowDefinition,
  WorkflowKey,
  StepNodeData,
  EdgeNodeData,
  PendingTransitionChange,
  WFStep,
  WFTransition,
} from './workflow-types'
import {
  INCIDENT_POSITIONS,
  STANDARD_POSITIONS,
  NORMAL_POSITIONS,
  EMERGENCY_POSITIONS,
  INCIDENT_HANDLES,
  STANDARD_HANDLES,
  NORMAL_HANDLES,
  EMERGENCY_HANDLES,
  INCIDENT_BACK,
  CHANGE_BACK,
  TRIGGER_COLOR,
} from './WorkflowCanvas'
import { colors, lookupOrError } from '@/lib/tokens'

const ACCENT_COLOR = colors.brand

export function defToWorkflowKey(def: WorkflowDefinition | null): WorkflowKey {
  if (!def) return 'incident'
  if (def.entityType === 'incident') return 'incident'
  const n = def.name.toLowerCase()
  if (n.includes('standard'))  return 'standard'
  if (n.includes('normal'))    return 'normal'
  if (n.includes('emergency')) return 'emergency'
  return 'standard'
}

export function useWorkflowDesigner(def: WorkflowDefinition | null) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hasChanges,         setHasChanges]         = useState(false)
  const [pendingChanges,     setPendingChanges]     = useState<PendingTransitionChange[]>([])
  const [pendingStepChanges, setPendingStepChanges] = useState<{ stepName: string; label: string; enterActions: string | null; exitActions: string | null }[]>([])

  const selectedWorkflow = defToWorkflowKey(def)

  // ── Build nodes / edges from definition ──────────────────────────────────────
  useEffect(() => {
    if (!def) return

    const positions = selectedWorkflow === 'incident' ? INCIDENT_POSITIONS
      : selectedWorkflow === 'standard' ? STANDARD_POSITIONS
      : selectedWorkflow === 'normal'   ? NORMAL_POSITIONS
      : EMERGENCY_POSITIONS

    const edgeHandles = selectedWorkflow === 'incident' ? INCIDENT_HANDLES
      : selectedWorkflow === 'standard' ? STANDARD_HANDLES
      : selectedWorkflow === 'normal'   ? NORMAL_HANDLES
      : EMERGENCY_HANDLES

    const backTransitions = selectedWorkflow === 'incident' ? INCIDENT_BACK : CHANGE_BACK

    const accentColor = ACCENT_COLOR

    const stepById: Record<string, string> = {}
    def.steps.forEach((s) => { stepById[s.name] = s.id })

    const newNodes: Node[] = def.steps.map((step, index) => ({
      id:       step.id,
      type:     'workflowStep',
      position: positions[step.name] ?? { x: index * 220, y: 200 },
      data:     { step, accentColor } satisfies StepNodeData,
    }))

    const newEdges: Edge[] = def.transitions.map((tr) => {
      const edgeColor  = lookupOrError(TRIGGER_COLOR, tr.trigger, 'TRIGGER_COLOR', '#ef4444')
      const baseKey    = `${tr.fromStepName}→${tr.toStepName}`
      const triggerKey = `${tr.fromStepName}→${tr.toStepName}→${tr.trigger}`
      const isBack     = backTransitions.has(baseKey)
      const handles    = edgeHandles[triggerKey] ?? edgeHandles[baseKey] ?? { sourceHandle: 'src-right', targetHandle: 'tgt-left' }

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
        labelBgStyle:        { fill: '#ffffff', fillOpacity: 1, stroke: edgeColor, strokeWidth: 1 },
        labelBgPadding:      [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        data:                { transition: tr, color: edgeColor } satisfies EdgeNodeData,
      }
    })

    setNodes(newNodes)
    setEdges(newEdges)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
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

  const handleSaveStepLocally = useCallback((change: { stepName: string; label: string; enterActions: string | null; exitActions: string | null }) => {
    setPendingStepChanges((prev) => {
      const idx = prev.findIndex((c) => c.stepName === change.stepName)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = change
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
    setHasChanges(false)
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
