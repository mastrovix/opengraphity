export function knowledgeBaseSDL(): string {
  return `#graphql

  type KBArticle {
    id:              ID!
    title:           String!
    slug:            String!
    body:            String!
    category:        String!
    tags:            [String!]!
    status:          String!
    authorId:        String!
    authorName:      String!
    views:           Int!
    helpfulCount:    Int!
    notHelpfulCount: Int!
    createdAt:       String!
    updatedAt:       String!
    publishedAt:     String
  }

  type KBArticlesResult {
    items: [KBArticle!]!
    total: Int!
  }

  type KBCategory {
    name:  String!
    count: Int!
  }
  `
}
