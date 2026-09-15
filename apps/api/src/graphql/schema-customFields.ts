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
    "Si vede nella fase in cui è il ticket (all'apertura: nella fase iniziale). Chi lo mostra nasconde un campo non visibile."
    visible:          Boolean!
    "Si modifica nella fase in cui è il ticket: altrimenti in sola lettura, e l'API rifiuta la scrittura."
    editable:         Boolean!
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

  "Le fasi di un workflow attivo di un tipo di ticket, per il disegnatore dei campi."
  type TicketWorkflowSteps {
    workflow: String!
    category: String
    steps:    [TicketWorkflowStep!]!
  }

  type TicketWorkflowStep {
    name:   String!
    label:  String!
    labels: [LocalizedLabel!]!
  }

  extend type Query {
    "I campi personalizzati del modulo di apertura: quelli che si modificano nella fase iniziale del workflow scelto per tipo e categoria (visible/editable dell'apertura)."
    ticketCreationCustomFields(entityType: String!, category: String): [CustomFieldValue!]!
    "Le fasi di ogni workflow attivo del tipo di ticket, raggruppate per workflow (il disegnatore dei campi le offre tutte)."
    ticketWorkflowSteps(entityType: String!): [TicketWorkflowSteps!]!
  }

  extend type Mutation {
    "Scrive i campi personalizzati di un ticket (incident, problem, change, service_request)."
    setTicketCustomFields(entityType: String!, id: ID!, values: [CustomFieldInput!]!): [CustomFieldValue!]!
  }
  `
}
