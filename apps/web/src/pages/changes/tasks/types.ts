export interface TaskHandlers {
  // Assessment task
  onCompleteTask: (taskId: string, input: { riskLevel: string; impactDescription: string; mitigation: string | null; notes: string | null }) => void
  onRejectTask: (taskId: string, reason: string) => void
  onAssignTaskTeam: (taskId: string, teamId: string) => void
  onAssignTaskUser: (taskId: string, userId: string) => void
  // Deploy step
  onUpdateStepStatus: (stepId: string, status: string, notes?: string, skipReason?: string) => void
  onAssignStepTeam: (stepId: string, teamId: string) => void
  onAssignStepUser: (stepId: string, userId: string) => void
  onUpdateStepValidation: (stepId: string, status: string, notes: string | null) => void
  onAssignValidationTeam: (stepId: string, teamId: string) => void
  onAssignValidationUser: (stepId: string, userId: string) => void
  onUpdateChangeTask: (id: string, input: { rollbackPlan?: string }) => void
  // Global validation
  onCompleteValidation: (changeId: string, notes: string | null) => void
  onFailValidation: (changeId: string) => void
  // Deploy steps form
  onSaveSteps: (changeId: string, steps: object[]) => void
  onSaveValidation: (changeId: string, scheduledStart: string, scheduledEnd: string) => void
}
