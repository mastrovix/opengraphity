import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { SAVE_WORKFLOW_CHANGES } from '@/graphql/mutations'
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
    setHasChanges,
    setPendingChanges,
    handleNodeClick,
    handleEdgeClick,
    handlePaneClick,
    handleSaveLocally,
    handleReconnect,
    onStepSaved,
    onEdgeSaved,
  } = useWorkflowDesigner(def)

  const [saveWorkflowChanges] = useMutation<{ saveWorkflowChanges: { id: string; name: string; version: number } }>(SAVE_WORKFLOW_CHANGES, {
    onError: (e) => toast.error(e.message),
  })

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
      },
    })
    const newVersion = result.data?.saveWorkflowChanges?.version ?? (def.version + 1)
    setPendingChanges([])
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
        pendingCount={pendingChanges.length}
        onSave={handleSave}
      />

      <WorkflowCanvas
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onReconnect={handleReconnect}
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
                onSaved={(u) => { onStepSaved(u); setHasChanges(true) }}
              />
            )}
            {selectedTr && def && (
              <WorkflowTransitionPanel
                transition={selectedTr}
                onClose={() => setSelectedEdgeId(null)}
                onSaved={(u) => onEdgeSaved(u)}
                onSaveLocally={handleSaveLocally}
              />
            )}
          </div>
        )}
      </WorkflowCanvas>
    </div>
  )
}
