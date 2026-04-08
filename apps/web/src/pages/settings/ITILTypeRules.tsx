import { FieldRulesPanel } from './shared/FieldRulesPanel'

export interface ITILTypeRulesProps {
  entityType:    string
  fields:        { name: string; label: string; fieldType: string; enumValues: string[] }[]
  workflowSteps: string[]
}

export function ITILTypeRules({ entityType, fields, workflowSteps }: ITILTypeRulesProps) {
  return (
    <FieldRulesPanel
      flat
      entityType={entityType}
      fields={fields}
      workflowSteps={workflowSteps}
    />
  )
}
