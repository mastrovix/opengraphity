import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { FieldRulesPanel, type StepOption } from './shared/FieldRulesPanel'
import { GET_TICKET_WORKFLOW_STEPS } from '@/graphql/queries'
import { stepChoicesOf } from './ITILTypeFields'

export interface ITILTypeRulesProps {
  entityType:    string
  fields:        { name: string; label: string; fieldType: string; enumValues: string[]; enumTypeName?: string | null }[]
}

export function ITILTypeRules({ entityType, fields }: ITILTypeRulesProps) {
  /**
   * Le fasi sono le STESSE della scheda Campi (revisione totale · G-10): tutti
   * i workflow attivi del tipo di ticket, con l'etichetta tradotta. Prima
   * venivano dai soli workflow senza categoria e col nome tecnico.
   */
  const { data } = useQuery<{ ticketWorkflowSteps: { workflow: string; steps: { name: string; label: string; labels?: { language: string; label: string }[] }[] }[] }>(
    GET_TICKET_WORKFLOW_STEPS, { variables: { entityType }, skip: !entityType, fetchPolicy: 'cache-and-network' },
  )
  const workflowSteps: StepOption[] = useMemo(
    () => stepChoicesOf(data?.ticketWorkflowSteps ?? []).map((c) => ({ name: c.name, label: c.label || c.name })),
    [data],
  )
  return (
    <FieldRulesPanel
      flat
      entityType={entityType}
      fields={fields}
      workflowSteps={workflowSteps}
    />
  )
}
