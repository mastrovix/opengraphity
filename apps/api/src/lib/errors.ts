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
