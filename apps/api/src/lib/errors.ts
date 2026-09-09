import { GraphQLError } from 'graphql'

export class NotFoundError extends GraphQLError {
  constructor(entityType: string, id?: string) {
    super(
      id ? `${entityType} ${id} not found` : `${entityType} not found`,
      { extensions: { code: 'NOT_FOUND' } },
    )
  }
}

export class ValidationError extends GraphQLError {
  constructor(message: string) {
    super(message, { extensions: { code: 'BAD_USER_INPUT' } })
  }
}

export class ForbiddenError extends GraphQLError {
  constructor(message = 'Forbidden') {
    super(message, { extensions: { code: 'FORBIDDEN' } })
  }
}

/**
 * Risorsa temporaneamente satura (es. tutti gli isolate del transform script
 * occupati): il chiamante deve ritentare dopo `retryAfterSeconds`. Su REST
 * diventa 503 + header `Retry-After`; mai un 500 (non è un guasto) né un 400
 * (il payload non c'entra).
 */
export class ServiceUnavailableError extends GraphQLError {
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message, { extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds } })
    this.retryAfterSeconds = retryAfterSeconds
  }
}
