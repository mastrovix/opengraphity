import { gql } from '@apollo/client'

// ── Report builder ───────────────────────────────────────────────────────────

export const CREATE_REPORT_TEMPLATE = gql`
  mutation CreateReportTemplate($input: CreateReportTemplateInput!) {
    createReportTemplate(input: $input) {
      id name description icon visibility scheduleEnabled scheduleCron createdAt
    }
  }
`

export const UPDATE_REPORT_TEMPLATE = gql`
  mutation UpdateReportTemplate($id: ID!, $input: UpdateReportTemplateInput!) {
    updateReportTemplate(id: $id, input: $input) {
      id name description icon visibility scheduleEnabled scheduleCron scheduleChannelId
      sharedWith { id name }
    }
  }
`

export const DELETE_REPORT_TEMPLATE = gql`
  mutation DeleteReportTemplate($id: ID!) {
    deleteReportTemplate(id: $id)
  }
`

export const DUPLICATE_REPORT_TEMPLATE = gql`
  mutation DuplicateReportTemplate($id: ID!, $name: String) {
    duplicateReportTemplate(id: $id, name: $name) {
      id name description icon visibility scheduleEnabled scheduleCron createdAt
      sections { id order title chartType }
    }
  }
`

export const ADD_REPORT_SECTION = gql`
  mutation AddReportSection($templateId: ID!, $input: ReportSectionInput!) {
    addReportSection(templateId: $templateId, input: $input) {
      id sections {
        id order title chartType groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const UPDATE_REPORT_SECTION = gql`
  mutation UpdateReportSection($sectionId: ID!, $input: ReportSectionInput!) {
    updateReportSection(sectionId: $sectionId, input: $input) {
      id sections {
        id order title chartType groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const REMOVE_REPORT_SECTION = gql`
  mutation RemoveReportSection($templateId: ID!, $sectionId: ID!) {
    removeReportSection(templateId: $templateId, sectionId: $sectionId) {
      id sections { id order title }
    }
  }
`

export const EXPORT_REPORT_PDF = gql`
  mutation ExportReportPDF($templateId: ID!) {
    exportReportPDF(templateId: $templateId)
  }
`

export const EXPORT_REPORT_EXCEL = gql`
  mutation ExportReportExcel($templateId: ID!) {
    exportReportExcel(templateId: $templateId)
  }
`

export const UPDATE_REPORT_SCHEDULE = gql`
  mutation UpdateReportSchedule($templateId: ID!, $enabled: Boolean!, $cron: String, $recipients: [String!], $format: String) {
    updateReportSchedule(templateId: $templateId, enabled: $enabled, cron: $cron, recipients: $recipients, format: $format) {
      id scheduleEnabled scheduleCron scheduleRecipients scheduleFormat lastScheduledRun
    }
  }
`

/**
 * L'AI PROGETTA UNA SEZIONE DI REPORT da una descrizione (19 set 2026).
 *
 * Mutation e non query per le stesse due ragioni del progettista dei moduli:
 * costa una chiamata al modello e va nell'Audit Log, e una query si sarebbe
 * messa in cache come se la risposta fosse un dato del grafo. Non SCRIVE
 * niente: riempie il costruttore, e a salvare ci pensa `addReportSection`.
 */
export const PROPOSE_REPORT_SECTION = gql`
  mutation ProposeReportSection($prompt: String!) {
    proposeReportSection(prompt: $prompt) {
      prompt title chartType metric metricField
      groupByNodeId groupByField groupByGranularity limit sortDir why
      nodes { id entityType neo4jLabel label isRoot isResult selectedFields filters positionX positionY why }
      edges { id sourceNodeId targetNodeId relationshipType direction label }
      discarded { what key params }
      notes
    }
  }
`
