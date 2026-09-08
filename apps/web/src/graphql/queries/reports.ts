import { gql } from '@apollo/client'

// ── Report builder ───────────────────────────────────────────────────────────

export const GET_REPORT_TEMPLATES = gql`
  query GetReportTemplates {
    reportTemplates {
      id name description icon visibility
      scheduleEnabled scheduleCron
      createdAt
      createdBy { id name }
      sharedWith { id name }
      sections {
        id order title chartType
        groupByNodeId groupByField metric metricField
        limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const GET_REPORT_TEMPLATE = gql`
  query GetReportTemplate($id: ID!) {
    reportTemplate(id: $id) {
      id name description icon visibility
      scheduleEnabled scheduleCron scheduleChannelId
      scheduleRecipients scheduleFormat lastScheduledRun
      createdAt updatedAt
      createdBy { id name }
      sharedWith { id name }
      sections {
        id order title chartType
        groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const GET_NAVIGABLE_ENTITIES = gql`
  query GetNavigableEntities {
    navigableEntities {
      entityType label neo4jLabel
      fields { name label fieldType enumValues }
      relations {
        relationshipType direction label
        targetEntityType targetLabel targetNeo4jLabel
      }
    }
  }
`

export const GET_REACHABLE_ENTITIES = gql`
  query GetReachableEntities($fromNeo4jLabel: String!) {
    reachableEntities(fromNeo4jLabel: $fromNeo4jLabel) {
      entityType label neo4jLabel
      relationshipType direction count
      fields { name label fieldType enumValues }
    }
  }
`

export const EXECUTE_REPORT = gql`
  query ExecuteReport($templateId: ID!) {
    executeReport(templateId: $templateId) {
      sections { sectionId title chartType data total error }
    }
  }
`

export const PREVIEW_REPORT_SECTION = gql`
  query PreviewReportSection($input: ReportSectionInput!) {
    previewReportSection(input: $input) {
      sectionId title chartType data total error
    }
  }
`
