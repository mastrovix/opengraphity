import { useMemo, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { toast } from 'sonner'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { SAVE_WORKFLOW_CHANGES, ADD_WORKFLOW_TRANSITION, REMOVE_WORKFLOW_TRANSITION, REMOVE_WORKFLOW_STEP } from '@/graphql/mutations'
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
    clearLocalChanges,
    handleNodeClick,
    handleEdgeClick,
    handlePaneClick,
    handleSaveLocally,
    handleSaveStepLocally,
    handleReconnect,
    onStepSaved,
    onEdgeSaved,
  } = useWorkflowDesigner(def)

  // Nessun onError qui: handleSave distingue CONFLICT (modifiche di un altro
  // utente → non sovrascrivere, invitare a ricaricare) dagli altri errori.
  const [saveWorkflowChanges] = useMutation<{ saveWorkflowChanges: { id: string; name: string; version: number } }>(SAVE_WORKFLOW_CHANGES)

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

  const [removeStep] = useMutation(REMOVE_WORKFLOW_STEP, { onError: (e) => toast.error(e.message) })
  const handleDeleteStep = useCallback(async (stepName: string) => {
    if (!def) return
    try {
      await removeStep({ variables: { definitionId: def.id, stepName } })
      setSelectedNodeId(null)
      toast.success('Step eliminato')
      await refetch()
    } catch { /* onError handles toast */ }
  }, [def, removeStep, refetch, setSelectedNodeId])

  const handleSave = async () => {
    if (!def) return
    const positions = nodes.map((n) => ({
      stepId:    n.id,
      positionX: n.position.x,
      positionY: n.position.y,
    }))
    let result
    try {
      result = await saveWorkflowChanges({
        variables: {
          definitionId:    def.id,
          transitions:     pendingChanges,
          positions,
          steps:           pendingStepChanges,
          expectedVersion: def.version,
        },
      })
    } catch (e) {
      const code = CombinedGraphQLErrors.is(e) ? e.errors[0]?.extensions?.['code'] : undefined
      if (code === 'CONFLICT') {
        // Le modifiche locali restano in coda: sta all'utente ricaricare (perdendole)
        // o confrontarle; non sovrascriviamo mai il lavoro dell'altro utente.
        toast.error('Workflow modificato da un altro utente: ricarica la pagina prima di salvare. Le tue modifiche non sono state applicate.', { duration: 10_000 })
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
      return
    }
    const newVersion = result.data?.saveWorkflowChanges?.version
    if (newVersion == null) {
      toast.error('Salvataggio senza risposta dal server: ricarica la pagina per verificare lo stato del workflow.')
      return
    }
    clearLocalChanges()
    toast.success(`Workflow salvato — v${newVersion}`)
    void refetch()
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
                key={selectedStep.id}
                step={selectedStep}
                definitionId={def.id}
                onClose={() => setSelectedNodeId(null)}
                onSaved={(u) => onStepSaved(u)}
                onSaveLocally={handleSaveStepLocally}
                onDelete={handleDeleteStep}
              />
            )}
            {selectedTr && def && (
              <WorkflowTransitionPanel
                key={selectedTr.id}
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
