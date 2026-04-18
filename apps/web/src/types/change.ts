/**
 * Shared TypeScript interfaces for the Change domain — used by ChangeDetailPage,
 * TaskViewPage, MyTasksPage, CreateChangePage, QuestionAdminPage.
 *
 * These mirror the fields selected by the GraphQL queries in
 * apps/web/src/graphql/queries/change.ts — keep them in sync.
 */

// ── Common primitives ──────────────────────────────────────────────────────────

export interface UserRef  { id?: string; name: string }
export interface TeamRef  { id: string; name: string }

export interface TimeWindow { start: string; end: string }
export interface DeployStep { title: string; validationWindow: TimeWindow; releaseWindow: TimeWindow }

// ── Workflow ───────────────────────────────────────────────────────────────────

export interface AvailableTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

export interface WorkflowInstanceData {
  id:          string
  currentStep: string
  status:      string
}

// ── Change ────────────────────────────────────────────────────────────────────

export interface ChangeData {
  id: string; tenantId?: string; code: string; title: string
  description:        string | null
  aggregateRiskScore: number | null
  approvalRoute:      string | null
  approvalStatus:     string | null
  approvalAt:         string | null
  createdAt:          string
  updatedAt:          string
  requester:          UserRef | null
  changeOwner:        UserRef | null
  approvalBy:         UserRef | null
  workflowInstance:     WorkflowInstanceData | null
  availableTransitions: AvailableTransition[]
}

// ── Task detail fields ─────────────────────────────────────────────────────────

export interface ResponseDetail {
  question:       { id: string; text: string; category: string }
  selectedOption: { id: string; label: string; score: number }
}

export interface AssessmentTaskData {
  id:            string
  code:          string
  responderRole: string
  status:        string
  score:         number | null
  completedBy:   UserRef | null
  completedAt:   string | null
  assignedTeam:  TeamRef | null
  assignee:      { id: string; name: string } | null
  responses:     ResponseDetail[]
}

export interface DeployPlanTaskData {
  id:            string
  code:          string
  status:        string
  steps:         DeployStep[]
  completedBy:   UserRef | null
  completedAt:   string | null
  assignedTeam:  TeamRef | null
  assignee:      { id: string; name: string } | null
}

export interface ValidationTestData {
  id: string; code: string; status: string; result: string | null
  testedAt: string | null; testedBy: UserRef | null
}

export interface DeploymentTaskData {
  id: string; code: string; status: string
  deployedAt: string | null; deployedBy: UserRef | null
}

export interface ReviewTaskData {
  id: string; code: string; status: string; result: string | null
  reviewedAt: string | null; reviewedBy: UserRef | null
}

// ── Affected CI (the aggregate rendered in ChangeDetailPage) ───────────────────

export interface AffectedCI {
  ciPhase:  string
  riskScore: number | null
  ci: {
    id: string; name: string; type: string | null; environment: string | null
    ownerGroup:   TeamRef | null
    supportGroup: TeamRef | null
  }
  assessmentOwner:   AssessmentTaskData | null
  assessmentSupport: AssessmentTaskData | null
  deployPlan:        DeployPlanTaskData | null
  validation:        ValidationTestData | null
  deployment:        DeploymentTaskData | null
  review:            ReviewTaskData | null
}

// ── Audit ──────────────────────────────────────────────────────────────────────

export interface ChangeAuditEntryData {
  timestamp: string
  action:    string
  detail:    string | null
  actor:     UserRef | null
}

// ── Assessment questions ──────────────────────────────────────────────────────

export interface AnswerOptionData {
  id:        string
  label:     string
  score:     number
  sortOrder: number
}

export interface QuestionData {
  id:        string
  text:      string
  category:  string
  isCore:    boolean
  isActive:  boolean
  createdAt: string
  options:   AnswerOptionData[]
}

export interface CITypeAssignment {
  ciTypeId:   string
  ciTypeName: string
  weight:     number
  sortOrder:  number
}

// ── Current user (as seen by the UI) ──────────────────────────────────────────

export interface MeData {
  id:    string
  role:  string
  teams: { id: string }[]
}

// ── MyTasks / TaskView combined row ───────────────────────────────────────────

export interface TaskData {
  id:         string
  code:       string
  kind:       string
  role:       string
  action:     string
  status:     string
  changeId:   string
  changeCode: string
  ciId:       string
  ciName:     string
  phase:      string
  createdAt:  string
}
