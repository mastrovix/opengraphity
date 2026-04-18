export const TASK_STATUS = {
  PENDING:     'pending',
  IN_PROGRESS: 'in-progress',
  COMPLETED:   'completed',
  PLANNING:    'planning',
} as const

export const VALIDATION_RESULT = {
  PASS: 'pass',
  FAIL: 'fail',
} as const

export const REVIEW_RESULT = {
  CONFIRMED: 'confirmed',
  REJECTED:  'rejected',
} as const

export const ASSESSMENT_ROLE = {
  OWNER:   'owner',
  SUPPORT: 'support',
} as const

export const QUESTION_CATEGORY = {
  FUNCTIONAL: 'functional',
  TECHNICAL:  'technical',
} as const

export const ROLE_TO_CATEGORY: Record<string, string> = {
  [ASSESSMENT_ROLE.OWNER]:   QUESTION_CATEGORY.FUNCTIONAL,
  [ASSESSMENT_ROLE.SUPPORT]: QUESTION_CATEGORY.TECHNICAL,
}

export const ROLE_TO_RELATION: Record<string, string> = {
  [ASSESSMENT_ROLE.OWNER]:   'OWNED_BY',
  [ASSESSMENT_ROLE.SUPPORT]: 'SUPPORTED_BY',
}

export const ROLE_LABEL: Record<string, string> = {
  [ASSESSMENT_ROLE.OWNER]:   'Functional',
  [ASSESSMENT_ROLE.SUPPORT]: 'Technical',
}
