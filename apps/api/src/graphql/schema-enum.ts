export function enumTypeSDL(): string {
  return `
  type EnumTypeDefinition {
    id:        ID!
    tenantId:  String!
    name:      String!
    label:     String!
    values:    [String!]!
    """
    Flag di PROTEZIONE (non si cancella, non se ne cambia lo scope). È scritto
    anche sulle copie per tenant seminate in passato, quindi NON dice di chi è
    il vocabolario: per quello c'è \`isShipped\`.
    """
    isSystem:  Boolean!
    """
    Vero quando il vocabolario è spedito col prodotto (\`tenant_id = 'system'\`),
    cioè è lo stesso per tutti i clienti e non è modificabile in posto: si
    personalizza con \`customizeEnumType\`, che ne crea la copia del tenant (la
    copia vince in lettura solo per chi la possiede).
    """
    isShipped: Boolean!
    scope:     String!
    createdAt: String!
    updatedAt: String!
  }

  input CreateEnumTypeInput {
    name:   String!
    label:  String!
    values: [String!]!
    scope:  String!
  }

  input UpdateEnumTypeInput {
    label:  String
    values: [String!]
    scope:  String
  }
  `
}
