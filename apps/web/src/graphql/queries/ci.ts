import { gql } from '@apollo/client'
import { CUSTOM_FIELD_VALUE_FIELDS } from '../fragments'

export const GET_ALL_CIS = gql`
  query GetAllCIs($limit: Int, $offset: Int, $type: String, $environment: String, $status: String, $search: String, $ciTypes: [String], $excludeCiTypes: [String], $filters: String, $sortField: String, $sortDirection: String) {
    allCIs(limit: $limit, offset: $offset, type: $type, environment: $environment, status: $status, search: $search, ciTypes: $ciTypes, excludeCiTypes: $excludeCiTypes, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id name type status environment description createdAt health
        ownerGroup { id name }
        supportGroup { id name }
      }
    }
  }
`

export const GET_BLAST_RADIUS = gql`
  query GetBlastRadius($id: ID!) {
    blastRadius(id: $id) {
      distance
      parentId
      ci { id name type environment status }
    }
  }
`

export const GET_CI_CHANGES = gql`
  query GetCIChanges($ciId: ID!) {
    ciChanges(ciId: $ciId) {
      id
      code
      title
      workflowInstance { currentStep }
      aggregateRiskScore
      approvalStatus
      createdAt
    }
  }
`

/** I problem che hanno il CI fra gli impattati (F12, revisione del 14 set 2026). */
export const GET_CI_PROBLEMS = gql`
  query GetCIProblems($ciId: ID!) {
    ciProblems(ciId: $ciId) {
      id number title priority status
      createdAt updatedAt
    }
  }
`

/** Le richieste che riguardano il CI (revisione del 15 set 2026 · CM-8). */
export const GET_CI_SERVICE_REQUESTS = gql`
  query GetCIServiceRequests($ciId: ID!) {
    ciServiceRequests(ciId: $ciId) {
      id number title priority status
      createdAt updatedAt
    }
  }
`

export const GET_CI_INCIDENTS = gql`
  query GetCIIncidents($ciId: ID!) {
    ciIncidents(ciId: $ciId) {
      id number title severity status
      createdAt updatedAt
    }
  }
`

/**
 * `defaultValue` ed `enumTypeId` vanno chiesti: la modifica di un campo li
 * rimandava come null e l'API li sovrascriveva, quindi ogni «Modifica»
 * azzerava il valore predefinito e la tendina del vocabolario appariva vuota
 * (revisione totale · G-3).
 */
export const GET_BASE_CI_TYPE = gql`
  query GetBaseCIType {
    baseCIType {
      id name label icon color active
      scope tenantId
      validationScript
      fields {
        id name label fieldType
        required defaultValue enumTypeId enumValues order enumTypeName
        isSystem
        validationScript
        visibilityScript
        defaultScript
      }
      relations { id name label relationshipType targetType cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

/** `defaultValue` ed `enumTypeId`: vedi GET_BASE_CI_TYPE (revisione totale · G-3). */
export const GET_CI_TYPES = gql`
  query GetCITypes {
    ciTypes {
      id name label labels { language label } icon color active
      scope tenantId
      validationScript chainFamilies serviceRole
      fields {
        id name label fieldType
        required defaultValue enumTypeId enumValues order enumTypeName
        isSystem
        validationScript
        visibilityScript
        defaultScript
      }
      relations {
        id name label relationshipType
        targetType cardinality direction order
      }
      systemRelations {
        id name label relationshipType
        targetEntity required order
      }
    }
  }
`

export const GET_ITIL_TYPES = gql`
  query GetITILTypes {
    itilTypes {
      id name label icon color active validationScript
      fields {
        id name label fieldType
        required enumValues order isSystem
        enumTypeId enumTypeName
        validationScript visibilityScript defaultScript
        visibleToEndUser
        stepVisibility { mode steps step }
        stepEditability { mode steps }
      }
    }
  }
`

/** I tipi di CI esclusi per un tipo di ticket (revisione del 15 set 2026 · CM-8). */
export const GET_TICKET_CI_EXCLUSIONS = gql`
  query GetTicketCIExclusions($ticketType: String) {
    ticketCIExclusions(ticketType: $ticketType) {
      ticketType ciTypes
    }
  }
`

export const GET_TOPOLOGY = gql`
  query GetTopology($types: [String!], $environment: String, $status: String, $selectedCiId: ID, $maxHops: Int) {
    topology(types: $types, environment: $environment, status: $status, selectedCiId: $selectedCiId, maxHops: $maxHops) {
      nodes {
        id name type status inMaintenance environment ownerGroup incidentCount changeCount health
      }
      edges {
        source target type
      }
      truncated
      nodeLimit
    }
  }
`

/** I gruppi di un CI, riletti quando si torna dalla pagina del CI (secondo giro UI · V-1). */
export const GET_CI_GROUPS_BY_ID = gql`
  query CIGroupsById($id: ID!) {
    ciById(id: $id) { id ownerGroup { id name } supportGroup { id name } }
  }
`

/** Solo id e tipo: serve al reindirizzamento /cis/:id → /ci/:type/:id usato dai link delle notifiche. */
export const GET_CI_BY_ID_REF = gql`
  query CIByIdRef($id: ID!) {
    ciById(id: $id) { id type }
  }
`

/** Cosa porterebbe via `deleteCIType` (regola del 15 set 2026): la conferma del disegnatore lo dice prima. */
export const GET_CI_TYPE_DELETION_IMPACT = gql`
  query CITypeDeletionImpact($id: ID!) {
    ciTypeDeletionImpact(id: $id) {
      cis ticketCIs tickets ticketCIExclusions groupsUpdated groupsDeleted fieldVisibilityRules
      fieldRequirementRules businessRules autoTriggers customWidgets reportSections assessmentQuestionLinks
      blockingServiceMaps
    }
  }
`

/** Quanti CI hanno un valore nel campo del cliente (secondo giro UI · V-15): la conferma di cancellazione lo dice. */
export const GET_CI_FIELD_VALUE_COUNT = gql`
  query CIFieldValueCount($typeId: ID!, $fieldId: ID!) {
    ciFieldValueCount(typeId: $typeId, fieldId: $fieldId)
  }
`

/** Quanti ticket hanno un valore nel campo personalizzato (giro UI del 15 set · U-28): la conferma di cancellazione lo dice. */
export const GET_ITIL_FIELD_VALUE_COUNT = gql`
  query ITILFieldValueCount($typeId: ID!, $fieldId: ID!) {
    itilFieldValueCount(typeId: $typeId, fieldId: $fieldId)
  }
`

/** I campi del modulo di apertura per tipo e categoria (visible/editable della fase iniziale). */
export const GET_TICKET_CREATION_CUSTOM_FIELDS = gql`
  ${CUSTOM_FIELD_VALUE_FIELDS}
  query GetTicketCreationCustomFields($entityType: String!, $category: String) {
    ticketCreationCustomFields(entityType: $entityType, category: $category) { ...CustomFieldValueFields }
  }
`

/** Le fasi di tutti i workflow attivi di un tipo di ticket, per il disegnatore dei campi. */
export const GET_TICKET_WORKFLOW_STEPS = gql`
  query GetTicketWorkflowSteps($entityType: String!) {
    ticketWorkflowSteps(entityType: $entityType) {
      workflow category
      steps { name label labels { language label } }
    }
  }
`
