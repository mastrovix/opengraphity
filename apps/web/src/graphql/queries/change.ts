import { gql } from '@apollo/client'

export const GET_CHANGES = gql`
  query GetChanges($currentStep: String, $limit: Int, $offset: Int) {
    changes(currentStep: $currentStep, limit: $limit, offset: $offset) {
      total
      items {
        id
        code
        title
        aggregateRiskScore
        approvalRoute
        approvalStatus
        createdAt
        updatedAt
        requester { id name email }
        changeOwner { id name email }
        workflowInstance { id currentStep status }
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
      description
      aggregateRiskScore
      approvalRoute
      approvalStatus
      approvalAt
      createdAt
      updatedAt
      requester { id name email }
      changeOwner { id name email }
      approvalBy { id name email }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
    }
  }
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
        changeId changeCode ciId ciName phase createdAt
      }
      unassigned {
        id code kind role action status
        changeId changeCode ciId ciName phase createdAt
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
