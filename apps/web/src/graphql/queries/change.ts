import { gql } from '@apollo/client'
import { EVENT_ROW_FIELDS, CUSTOM_FIELD_VALUE_FIELDS } from '../fragments'

export const GET_CHANGES = gql`
  query GetChanges($currentStep: String, $priority: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    changes(currentStep: $currentStep, priority: $priority, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id
        code
        title
        aggregateRiskScore
        priority
        approvalRoute
        changeType
        approvalStatus
        createdAt
        updatedAt
        requester { id name email }
        changeOwner { id name email }
        workflowInstance { id currentStep status }
        customFields { name value }
      }
    }
  }
`

export const GET_CHANGE = gql`
  query GetChange($id: ID!) {
    change(id: $id) {
      id
      tenantId
      code
      title
      why
      what
      aggregateRiskScore
      priority
      approvalRoute
      changeType
      approvalStatus
      approvalAt
      createdAt
      updatedAt
      requester { id name email }
      changeOwner { id name email }
      approvalBy { id name email }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label labels { language label } requiresInput inputField condition }
      resolvesIncidents { id number title status severity removable }
      resolvesProblems { id number title status priority removable }
      approvals { kind teamId teamName status approvedByName approvedAt canApprove onBehalf }
      # Release conflicts: other changes deploying on the same CI in an
      # overlapping window. Validation windows are not compared.
      deployConflicts {
        items {
          changeId code title currentStep ciId ciName
          mine { start end } theirs { start end } overlap { start end }
        }
        # Plans that could not be read: "no conflict" and "I could not look"
        # are different answers in front of an approval.
        unreadablePlans
      }
      suppressedEvents { ...EventRowFields }
      suppressedEventCount
      customFields { ...CustomFieldValueFields }
    }
  }
  ${EVENT_ROW_FIELDS}
  ${CUSTOM_FIELD_VALUE_FIELDS}
`

export const GET_CHANGE_AFFECTED_CIS = gql`
  query GetChangeAffectedCIs($changeId: ID!) {
    changeAffectedCIs(changeId: $changeId) {
      ciPhase
      riskScore
      ci {
        id
        name
        type
        status
        environment
        ownerGroup { id name }
        supportGroup { id name }
      }
      assessmentOwner {
        id
        code
        responderRole
        status
        score
        completedAt
        createdAt
        completedBy { id name }
        assignedTeam { id name }
        assignee { id name }
        responses {
          answeredAt
          answeredBy { id name }
          question {
            id
            text
            category
          }
          selectedOption { id label score sortOrder }
        }
      }
      assessmentSupport {
        id
        code
        responderRole
        status
        score
        completedAt
        createdAt
        completedBy { id name }
        assignedTeam { id name }
        assignee { id name }
        responses {
          answeredAt
          answeredBy { id name }
          question {
            id
            text
            category
          }
          selectedOption { id label score sortOrder }
        }
      }
      deployPlan {
        id
        code
        status
        steps {
          title
          validationWindow { start end }
          releaseWindow { start end }
        }
        assignedTeam { id name }
        assignee { id name }
        completedBy { id name }
        completedAt
        createdAt
      }
      validation {
        id
        code
        status
        result
        testedAt
        testedBy { id name }
      }
      deployment {
        id
        code
        status
        deployedAt
        deployedBy { id name }
      }
      review {
        id
        code
        status
        result
        reviewedAt
        reviewedBy { id name }
      }
    }
  }
`

export const GET_CHANGE_IMPACTED_CIS = gql`
  query GetChangeImpactedCIs($changeId: ID!, $depth: Int) {
    changeImpactedCIs(changeId: $changeId, depth: $depth) {
      distance
      impactPath
      ci { id name type status environment }
      affectedBy { id name type }
    }
  }
`

export const GET_TASK_BY_ID = gql`
  query GetTaskById($id: ID!) {
    taskById(id: $id) {
      id
      code
      kind
      changeId
      changeCode
      changeTitle
      changePhase
      changeDescription
      ciId
      ciName
      ciType
      ciEnv
    }
  }
`

export const GET_CHANGE_AUDIT_TRAIL = gql`
  query GetChangeAuditTrail($changeId: ID!) {
    changeAuditTrail(changeId: $changeId) {
      timestamp
      action
      detail
      detailKey
      detailParams
      actor { id name }
    }
  }
`

export const GET_QUESTION_CATALOG = gql`
  query GetQuestionCatalog($category: String) {
    assessmentQuestionCatalog(category: $category) {
      weight
      sortOrder
      question {
        id
        text
        category
        isCore
        isActive
        createdAt
        options { id label score sortOrder }
      }
    }
  }
`

export const GET_QUESTIONS_ADMIN = gql`
  query GetQuestionsAdmin {
    assessmentQuestionsAdmin {
      id
      text
      category
      isCore
      isActive
      createdAt
      options { id label score sortOrder }
    }
  }
`

export const GET_QUESTION_CITYPE_ASSIGNMENTS = gql`
  query GetQuestionCITypeAssignments($questionId: ID!) {
    questionCITypeAssignments(questionId: $questionId) {
      ciTypeId
      ciTypeName
      weight
      sortOrder
    }
  }
`

export const GET_MY_TASKS = gql`
  query GetMyTasks {
    myTasks {
      assignedToMe {
        id code kind role action status
        entityType entityId entityNumber ciId ciName phase createdAt
      }
      unassigned {
        id code kind role action status
        entityType entityId entityNumber ciId ciName phase createdAt
      }
    }
  }
`

export const GET_CHANGE_IMPACT = gql`
  query GetChangeImpact($ciIds: [ID!]!) {
    changeImpactAnalysis(ciIds: $ciIds) {
      riskScore
      riskLevel
      breakdown { productionCIs blastRadiusCIs openIncidents failedChanges ongoingChanges scoreDetails }
      blastRadius { id name type environment distance }
      openIncidents { id number title severity status ciName ciId createdAt isOpen }
      recentChanges { id code title phase ciName ciId createdAt }
    }
  }
`

/**
 * IL CALENDARIO DELLE CHANGE (17 set 2026): le finestre pianificate che cadono
 * nell'intervallo, una voce per finestra. L'intervallo lo applica il server,
 * che filtra sull'inviluppo indicizzato del piano — qui non si scarica tutto
 * per poi tagliare nel browser.
 */
export const GET_CHANGE_CALENDAR = gql`
  query GetChangeCalendar($from: String!, $to: String!) {
    changeCalendar(from: $from, to: $to) {
      unreadablePlans
      entries {
        changeId
        code
        title
        changeType
        priority
        currentStep
        kind
        start
        end
        stepTitle
        taskCode
        ciId
        ciName
      }
    }
  }
`

/**
 * L'ANTEPRIMA di una change per il calendario (17 set 2026): titolo, perché,
 * cosa e i CI impattati.
 *
 * Volutamente MAGRA e chiesta solo quando il modale si apre: mettere `why`,
 * `what` e l'elenco dei CI su ogni voce del calendario avrebbe ripetuto gli
 * stessi campi per ogni finestra della stessa change — un piano con tre passi
 * li avrebbe portati sei volte.
 */
export const GET_CHANGE_PREVIEW = gql`
  query GetChangePreview($id: ID!) {
    change(id: $id) {
      id
      code
      title
      why
      what
      changeType
      priority
    }
    changeAffectedCIs(changeId: $id) {
      ci {
        id
        name
        type
        environment
        supportGroup { id name }
      }
      deployPlan {
        code
        status
        steps {
          title
          validationWindow { start end }
          releaseWindow { start end }
        }
        assignedTeam { id name }
      }
    }
  }
`
