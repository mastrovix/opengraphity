import { gql } from '@apollo/client'

// ── SLA policies ─────────────────────────────────────────────────────────────

export const CREATE_SLA_POLICY = gql`
  mutation CreateSLAPolicy($input: CreateSLAPolicyInput!) {
    createSLAPolicy(input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours calendarId calendarName complianceTarget complianceWarning warningMinutes enabled
    }
  }
`

export const UPDATE_SLA_POLICY = gql`
  mutation UpdateSLAPolicy($id: ID!, $input: UpdateSLAPolicyInput!) {
    updateSLAPolicy(id: $id, input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours calendarId calendarName complianceTarget complianceWarning warningMinutes enabled
    }
  }
`

export const DELETE_SLA_POLICY = gql`
  mutation DeleteSLAPolicy($id: ID!) { deleteSLAPolicy(id: $id) }
`

// ── OLA / UC contracts ───────────────────────────────────────────────────────

export const CREATE_OLA_CONTRACT = gql`
  mutation CreateOLAContract($input: CreateOLAContractInput!) {
    createOLAContract(input: $input) {
      id type name entityType responseMinutes resolveMinutes businessHours calendarId calendarName complianceTarget complianceWarning partyType partyName teamId teamName enabled createdAt
    }
  }
`

export const UPDATE_OLA_CONTRACT = gql`
  mutation UpdateOLAContract($id: ID!, $input: UpdateOLAContractInput!) {
    updateOLAContract(id: $id, input: $input) {
      id type name entityType responseMinutes resolveMinutes businessHours calendarId calendarName complianceTarget complianceWarning partyType partyName teamId teamName enabled createdAt
    }
  }
`

// ── Calendari di servizio con nome (ondata 2) ────────────────────────────────

export const CREATE_SERVICE_CALENDAR = gql`
  mutation CreateServiceCalendar($name: String!, $calendar: ServiceCalendarInput!) {
    createServiceCalendar(name: $name, calendar: $calendar) { id name days start end holidays usedBySlaPolicies usedByOlaContracts usedByWorkflowSteps }
  }
`

export const UPDATE_SERVICE_CALENDAR = gql`
  mutation UpdateServiceCalendar($id: ID!, $name: String, $calendar: ServiceCalendarInput) {
    updateServiceCalendar(id: $id, name: $name, calendar: $calendar) { id name days start end holidays usedBySlaPolicies usedByOlaContracts usedByWorkflowSteps }
  }
`

export const DELETE_SERVICE_CALENDAR = gql`
  mutation DeleteServiceCalendar($id: ID!) { deleteServiceCalendar(id: $id) }
`
