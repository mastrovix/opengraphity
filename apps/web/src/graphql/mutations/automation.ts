import { gql } from '@apollo/client'

// ── Auto triggers ────────────────────────────────────────────────────────────

export const CREATE_AUTO_TRIGGER = gql`
  mutation CreateAutoTrigger($input: CreateAutoTriggerInput!) {
    createAutoTrigger(input: $input) {
      id name entityType eventType conditions timerDelayMinutes actions enabled executionCount lastExecutedAt
    }
  }
`

export const UPDATE_AUTO_TRIGGER = gql`
  mutation UpdateAutoTrigger($id: ID!, $input: UpdateAutoTriggerInput!) {
    updateAutoTrigger(id: $id, input: $input) {
      id name entityType eventType conditions timerDelayMinutes actions enabled executionCount lastExecutedAt
    }
  }
`

export const DELETE_AUTO_TRIGGER = gql`
  mutation DeleteAutoTrigger($id: ID!) { deleteAutoTrigger(id: $id) }
`

// ── Business rules ───────────────────────────────────────────────────────────

export const CREATE_BUSINESS_RULE = gql`
  mutation CreateBusinessRule($input: CreateBusinessRuleInput!) {
    createBusinessRule(input: $input) {
      id name description entityType eventType conditionLogic conditions actions priority stopOnMatch enabled
    }
  }
`

export const UPDATE_BUSINESS_RULE = gql`
  mutation UpdateBusinessRule($id: ID!, $input: UpdateBusinessRuleInput!) {
    updateBusinessRule(id: $id, input: $input) {
      id name description entityType eventType conditionLogic conditions actions priority stopOnMatch enabled
    }
  }
`

export const DELETE_BUSINESS_RULE = gql`
  mutation DeleteBusinessRule($id: ID!) { deleteBusinessRule(id: $id) }
`

export const REORDER_BUSINESS_RULES = gql`
  mutation ReorderBusinessRules($ruleIds: [String!]!) {
    reorderBusinessRules(ruleIds: $ruleIds) {
      id name priority
    }
  }
`
