import { useMemo, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { SAVE_WORKFLOW_CHANGES, ADD_WORKFLOW_TRANSITION, REMOVE_WORKFLOW_TRANSITION } from '@/graphql/mutations'
import type { WorkflowDefinition } from './workflow-types'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowToolbar } from './WorkflowToolbar'
import { WorkflowStepPanel } from './WorkflowStepPanel'
import { WorkflowTransitionPanel } from './WorkflowTransitionPanel'
import { useWorkflowDesigner, defToWorkflowKey } from './useWorkflowDesigner'

export function WorkflowDesignerPage() {
  const { id } = useParams<{ id: string }>()

  const { data, loading, refetch } = useQuery<{ workflowDefinitionById: WorkflowDefinition | null }>(
    GET_WORKFLOW_DEFINITION_BY_ID,
    { variables: { id }, skip: !id },
  )

  const def              = data?.workflowDefinitionById ?? null
  const selectedWorkflow = defToWorkflowKey(def)

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    selectedStep,
    selectedTr,
    setSelectedNodeId,
    setSelectedEdgeId,
    hasChanges,
    pendingChanges,
    pendingStepChanges,
    setHasChanges,
    setPendingChanges,
    setPendingStepChanges,
    handleNodeClick,
    handleEdgeClick,
    handlePaneClick,
    handleSaveLocally,
    handleSaveStepLocally,
    handleReconnect,
    onStepSaved,
    onEdgeSaved,
  } = useWorkflowDesigner(def)

  const [saveWorkflowChanges] = useMutation<{ saveWorkflowChanges: { id: string; name: string; version: number } }>(SAVE_WORKFLOW_CHANGES, {
    onError: (e) => toast.error(e.message),
  })

  const [addTransition] = useMutation(ADD_WORKFLOW_TRANSITION, { onError: (e) => toast.error(e.message) })
  const [removeTransition] = useMutation(REMOVE_WORKFLOW_TRANSITION, { onError: (e) => toast.error(e.message) })

  // React Flow node ids are step ids; the create mutation takes step names.
  const idToName = useMemo(() => {
    const m: Record<string, string> = {}
    def?.steps.forEach((s) => { m[s.id] = s.name })
    return m
  }, [def])

  // Draw a new arrow → create the transition (trigger defaults to 'manual';
  // edit it to sla_breach/etc. in the panel, then Save). Reload to render it.
  const handleConnect = useCallback(async (c: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
    if (!def) return
    const fromStepName = idToName[c.source]
    const toStepName   = idToName[c.target]
    if (!fromStepName || !toStepName) { toast.error('Step non riconosciuto'); return }
    try {
      await addTransition({ variables: {
        definitionId: def.id, fromStepName, toStepName,
        trigger: 'manual', label: '',
        sourceHandle: c.sourceHandle ?? null, targetHandle: c.targetHandle ?? null,
      } })
      toast.success('Transizione creata — impostane il trigger nel pannello')
      await refetch()
    } catch { /* onError handles toast */ }
  }, [def, idToName, addTransition, refetch])

  const handleDeleteTransition = useCallback(async (transitionId: string) => {
    if (!def) return
    try {
      await removeTransition({ variables: { definitionId: def.id, transitionId } })
      setSelectedEdgeId(null)
      toast.success('Transizione eliminata')
      await refetch()
    } catch { /* onError handles toast */ }
  }, [def, removeTransition, refetch, setSelectedEdgeId])

  const handleSave = async () => {
    if (!def) return
    const positions = nodes.map((n) => ({
      stepId:    n.id,
      positionX: n.position.x,
      positionY: n.position.y,
    }))
    const result = await saveWorkflowChanges({
      variables: {
        definitionId: def.id,
        transitions:  pendingChanges,
        positions,
        steps:        pendingStepChanges,
      },
    })
    const newVersion = result.data?.saveWorkflowChanges?.version ?? (def.version + 1)
    setPendingChanges([])
    setPendingStepChanges([])
    setHasChanges(false)
    toast.success(`Workflow salvato — v${newVersion}`)
    refetch()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <WorkflowToolbar
        def={def}
        selectedWorkflow={selectedWorkflow}
        hasChanges={hasChanges}
        pendingCount={pendingChanges.length + pendingStepChanges.length}
        onSave={handleSave}
        onRefetch={refetch}
      />

      {def?.entityType === 'change' && (
        <div style={{
          padding: '10px 24px',
          backgroundColor: '#fef9c3',
          borderBottom: '1px solid #fde68a',
          fontSize: 'var(--font-size-body)',
          color: '#713f12',
        }}>
          Gli step di questo workflow sono fissi. Puoi personalizzare label, azioni e condizioni.
        </div>
      )}

      <WorkflowCanvas
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onReconnect={handleReconnect}
        onConnect={handleConnect}
        loading={loading}
        def={def}
      >
        {/* Side Panels */}
        {(selectedStep || selectedTr) && (
          <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
            {selectedStep && def && (
              <WorkflowStepPanel
                step={selectedStep}
                definitionId={def.id}
                onClose={() => setSelectedNodeId(null)}
                onSaved={(u) => onStepSaved(u)}
                onSaveLocally={handleSaveStepLocally}
              />
            )}
            {selectedTr && def && (
              <WorkflowTransitionPanel
                transition={selectedTr}
                onClose={() => setSelectedEdgeId(null)}
                onSaved={(u) => onEdgeSaved(u)}
                onSaveLocally={handleSaveLocally}
                onDelete={handleDeleteTransition}
              />
            )}
          </div>
        )}
      </WorkflowCanvas>
    </div>
  )
}
