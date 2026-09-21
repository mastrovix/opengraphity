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
    """Modificato: quando e da chi (ondata 6 di «Nulla cablato»)."""
    editedAt:      String
    editedByName:  String
    """Cancellato: resta come traccia, senza testo."""
    deletedAt:     String
    deletedByName: String
  }
  `
}
