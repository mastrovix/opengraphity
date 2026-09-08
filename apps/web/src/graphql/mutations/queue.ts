import { gql } from '@apollo/client'

// ── Queues ───────────────────────────────────────────────────────────────────

export const RETRY_QUEUE_JOB = gql`
  mutation RetryQueueJob($queueName: String!, $jobId: ID!) {
    retryQueueJob(queueName: $queueName, jobId: $jobId)
  }
`
