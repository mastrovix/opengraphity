import { gql } from '@apollo/client'

export const GET_ALL_CIS = gql`
  query GetAllCIs($limit: Int, $offset: Int, $type: String, $environment: String, $status: String, $search: String, $ciTypes: [String], $filters: String, $sortField: String, $sortDirection: String) {
    allCIs(limit: $limit, offset: $offset, type: $type, environment: $environment, status: $status, search: $search, ciTypes: $ciTypes, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id name type status environment description createdAt
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
      id title type priority status
      createdAt scheduledStart
    }
  }
`

export const GET_CI_INCIDENTS = gql`
  query GetCIIncidents($ciId: ID!) {
    ciIncidents(ciId: $ciId) {
      id title severity status
      createdAt updatedAt
    }
  }
`

export const GET_BASE_CI_TYPE = gql`
  query GetBaseCIType {
    baseCIType {
      id name label icon color active
      validationScript
      fields {
        id name label fieldType
        required enumValues order
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

export const GET_CI_TYPES = gql`
  query GetCITypes {
    ciTypes {
      id name label icon color active
      validationScript
      fields {
        id name label fieldType
        required enumValues order
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
      }
    }
  }
`

export const GET_ITIL_CI_RELATION_RULES = gql`
  query GetITILCIRelationRules($itilType: String!) {
    itilCIRelationRules(itilType: $itilType) {
      id itilType ciType relationType direction description
    }
  }
`

export const GET_ALL_ITIL_CI_RELATION_RULES = gql`
  query GetAllITILCIRelationRules {
    allITILCIRelationRules {
      id itilType ciType relationType direction description
    }
  }
`

export const GET_TOPOLOGY = gql`
  query GetTopology($types: [String!], $environment: String, $status: String, $selectedCiId: ID, $maxHops: Int) {
    topology(types: $types, environment: $environment, status: $status, selectedCiId: $selectedCiId, maxHops: $maxHops) {
      nodes {
        id name type status environment ownerGroup incidentCount changeCount
      }
      edges {
        source target type
      }
      truncated
    }
  }
`
