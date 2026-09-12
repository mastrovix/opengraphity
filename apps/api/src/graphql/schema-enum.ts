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
    """
    Il valore da usare quando nessuno lo indica (\`null\` = non dichiarato).
    Serve a togliere una regola di dominio dalla POSIZIONE: \`initialCIStatus\`
    prendeva il PRIMO valore della lista, e siccome il Dizionario sapeva solo
    aggiungere in coda, rinominare un valore lo spostava in fondo e un CI nuovo
    nasceva col primo valore rimasto — dal vivo \`inactive\`, cioè subito
    escluso dalla salute dei servizi.
    """
    defaultValue: String
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
    """
    Ondata 7 · B7-2: togliere un valore ancora usato da qualche record (o dalla
    semantica del ciclo di vita nella policy degli allarmi) viene RIFIUTATO, con
    il conteggio nel messaggio. Per procedere si indica qui, valore per valore,
    su cosa riscrivere i record: la riscrittura avviene nella stessa transazione
    del vocabolario, con audit.
    """
    replacements: [EnumValueReplacementInput!]
    """
    Il valore con cui si nasce quando nessuno lo indica. Deve essere fra i
    valori (quelli nuovi, se li stai cambiando nella stessa chiamata).
    """
    defaultValue: String
  }

  """Un valore che si sta togliendo (from) e il valore nuovo su cui riscrivere i record che lo usano (to, deve essere fra i valori nuovi)."""
  input EnumValueReplacementInput {
    from: String!
    to:   String!
  }
  `
}
