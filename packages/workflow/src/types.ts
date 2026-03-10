export type WorkflowStepType = 'start' | 'standard' | 'end'

export type WorkflowTrigger =
  | 'manual'       // richiede azione utente
  | 'automatic'    // sistema lo fa da solo
  | 'sla_breach'   // SLA engine lo triggera
  | 'timer'        // BullMQ job

export type WorkflowActionType =
  | 'sla_start'
  | 'sla_stop'
  | 'sla_pause'
  | 'sla_resume'
  | 'notify'
  | 'publish_event'
  | 'schedule_job'
  | 'cancel_job'

export interface WorkflowActionConfig {
  type:   WorkflowActionType
  params: Record<string, string>
}

export interface WorkflowStepDef {
  id:           string
  name:         string
  label:        string
  type:         WorkflowStepType
  enterActions: WorkflowActionConfig[]
  exitActions:  WorkflowActionConfig[]
}

export interface WorkflowTransitionDef {
  id:            string
  fromStepName:  string
  toStepName:    string
  trigger:       WorkflowTrigger
  label:         string
  condition:     string | null
  requiresInput: boolean
  inputField:    string | null
}

export interface WorkflowDefinition {
  id:          string
  tenantId:    string
  name:        string
  entityType:  string
  version:     number
  active:      boolean
  steps:       WorkflowStepDef[]
  transitions: WorkflowTransitionDef[]
}

export interface WorkflowInstance {
  id:           string
  tenantId:     string
  definitionId: string
  entityId:     string
  entityType:   string
  currentStep:  string
  status:       'active' | 'completed' | 'failed'
  createdAt:    string
  updatedAt:    string
}

export interface WorkflowStepExecution {
  id:          string
  tenantId:    string
  instanceId:  string
  stepName:    string
  enteredAt:   string
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string
  triggerType: WorkflowTrigger
  notes:       string | null
}

export interface TransitionInput {
  instanceId:  string
  toStepName:  string
  triggeredBy: string
  triggerType: WorkflowTrigger
  notes?:      string
}

export interface TransitionResult {
  success:    boolean
  instance:   WorkflowInstance
  execution:  WorkflowStepExecution
  actionsRun: WorkflowActionType[]
  error?:     string
}
