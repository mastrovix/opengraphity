/**
 * I campi personalizzati dei ticket (verifica «Cosa resta cablato», ondata 4).
 * I tipi dei ticket sono dello schema di base e uguali per tutti i clienti: i
 * campi del cliente arrivano come elenco, con quello che serve a mostrarli.
 */
export function customFieldsSDL(): string {
  return `
  "Il valore di un campo personalizzato di un ticket (sempre testo, o null)."
  type CustomFieldValue {
    name:             String!
    label:            String!
    fieldType:        String!
    value:            String
    "I valori ammessi di un campo a vocabolario."
    enumValues:       [String!]!
    "Il vocabolario del campo, per le etichette dei valori."
    enumTypeName:     String
    required:         Boolean!
    visibleToEndUser: Boolean!
    "I valori ammessi con l'etichetta del Dizionario nella lingua chiesta (il portale non legge il Dizionario)."
    options(language: String): [CustomFieldOption!]!
    "L'etichetta del valore nella lingua chiesta; null senza valore."
    valueLabel(language: String): String
  }

  type CustomFieldOption {
    value: String!
    label: String!
  }

  "Un valore da scrivere: null o vuoto toglie il valore."
  input CustomFieldInput {
    name:  String!
    value: String
  }

  extend type Incident       { customFields: [CustomFieldValue!]! }
  extend type Problem        { customFields: [CustomFieldValue!]! }
  extend type Change         { customFields: [CustomFieldValue!]! }
  extend type ServiceRequest { customFields: [CustomFieldValue!]! }

  extend input CreateIncidentInput       { customFields: [CustomFieldInput!] }
  extend input CreateProblemInput        { customFields: [CustomFieldInput!] }
  extend input CreateChangeInput         { customFields: [CustomFieldInput!] }
  extend input CreateServiceRequestInput { customFields: [CustomFieldInput!] }

  extend type Mutation {
    "Scrive i campi personalizzati di un ticket (incident, problem, change, service_request)."
    setTicketCustomFields(entityType: String!, id: ID!, values: [CustomFieldInput!]!): [CustomFieldValue!]!
  }
  `
}
