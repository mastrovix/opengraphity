export function attachmentsSDL(): string {
  return `#graphql

  type Attachment {
    id:          ID!
    filename:    String!
    mimeType:    String!
    sizeBytes:   Int!
    uploadedBy:  String!
    uploadedAt:  String!
    description: String
    downloadUrl: String!
  }
  `
}
