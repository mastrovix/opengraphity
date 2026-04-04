export function commentsSDL(): string {
  return `#graphql

  type EntityComment {
    id:          ID!
    body:        String!
    isInternal:  Boolean!
    authorId:    String!
    authorName:  String!
    authorEmail: String!
    createdAt:   String!
    updatedAt:   String!
  }
  `
}
