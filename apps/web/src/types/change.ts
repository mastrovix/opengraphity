/**
 * Shared TypeScript interfaces for the Change domain — used by ChangeDetailPage,
 * TaskViewPage, MyTasksPage, CreateChangePage, QuestionAdminPage.
 *
 * These mirror the fields selected by the GraphQL queries in
 * apps/web/src/graphql/queries/change.ts — keep them in sync.
 */

import type { EventRow } from './events'

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
  /** Campi del cliente (ondata 4). */
  customFields?: import('@/components/ticket/customFields/customFields').CustomFieldValueView[]
  id: string; tenantId?: string; code: string; title: string
  why?:               string | null
  what?:              string | null
  aggregateRiskScore: number | null
  priority?:          string | null
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
  resolvesIncidents?:   LinkedTicketRef[]
  resolvesProblems?:    LinkedTicketRef[]
  approvals?:           ChangeApproval[]
  /** Allarmi silenziati dalla finestra di rilascio di questa change (Event Management, ondata 3). */
  suppressedEvents?:    EventRow[]
  /** Quanti sono in TUTTO: `suppressedEvents` e paginato (revisione totale · G-EVT-11). */
  suppressedEventCount?: number
  /**
   * Le altre change che RILASCIANO su uno stesso CI in una finestra
   * sovrapposta (18 set 2026). Lista vuota = nessun conflitto, ed è una
   * risposta: la sezione lo dice invece di non comparire.
   */
  deployConflicts?:     { items: ChangeDeployConflict[]; unreadablePlans: string[] }
}

/** Una finestra del piano: due istanti ISO. */
export interface DeployWindowRange {
  start: string
  end:   string
}

export interface ChangeDeployConflict {
  changeId:    string
  code:        string
  title:       string
  /** Il passo dell'altra change: dice quanto è imminente. */
  currentStep: string | null
  ciId:        string
  ciName:      string
  /** La finestra di QUESTA change, quella dell'altra, e la parte in comune. */
  mine:    DeployWindowRange
  theirs:  DeployWindowRange
  overlap: DeployWindowRange
}

export interface ChangeApproval {
  kind: string
  teamId: string | null
  teamName: string | null
  status: string
  approvedByName: string | null
  approvedAt: string | null
  canApprove: boolean
  /** Vero quando l'admin approva a nome di un team di cui non fa parte (#34). */
  onBehalf: boolean
}

export interface LinkedTicketRef {
  id: string; number: string; title: string; status: string
  severity?: string | null
  priority?: string | null
  removable?: boolean | null
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
  /** Chiave (sotto `changeAudit.`) e dati JSON della frase del dettaglio (CH-5). */
  detailKey?:    string | null
  detailParams?: string | null
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

/*
 * Qui stava `TaskData`, «MyTasks / TaskView combined row». Non la usava più
 * nessuno — `MyTasksPage` ha la sua interfaccia locale — e dal 20 set 2026
 * era anche BUGIARDA: `changeId`/`changeCode` non esistono più (le righe
 * parlano di entità, perché ci sono anche i compiti di incident, problem e
 * richieste) e il CI può mancare. Un tipo condiviso che mente è peggio di
 * nessun tipo: il prossimo che tocca la pagina ci si fida.
 */
