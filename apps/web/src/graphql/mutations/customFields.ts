import { gql } from '@apollo/client'
import { CUSTOM_FIELD_VALUE_FIELDS } from '../fragments'

/** Scrive i campi personalizzati di un ticket dal suo dettaglio (verifica «Cosa resta cablato», ondata 4). */
export const SET_TICKET_CUSTOM_FIELDS = gql`
  mutation SetTicketCustomFields($entityType: String!, $id: ID!, $values: [CustomFieldInput!]!) {
    setTicketCustomFields(entityType: $entityType, id: $id, values: $values) { ...CustomFieldValueFields }
  }
  ${CUSTOM_FIELD_VALUE_FIELDS}
`
