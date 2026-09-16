/**
 * I moduli del catalogo servizi (ondata 1): libreria dei campi e modulo per
 * voce. Il contratto e il perché stanno in `lib/catalogForm.ts` e in
 * `@opengraphity/types` (catalogForm.ts).
 *
 * `definition` viaggia come STRINGA JSON, non come tipi GraphQL annidati, per
 * la stessa ragione per cui i campi personalizzati dei ticket viaggiano come
 * lista: la definizione è dato del cliente e cambia forma con le ondate, mentre
 * lo schema GraphQL è per tenant e viene ricostruito a ogni modifica del
 * metamodello. Tipizzarla qui vorrebbe dire ricostruire lo schema a ogni
 * modifica di un modulo.
 *
 * NIENTE BOZZE, per ora: salvare pubblica e alza la `revision`. Il costruttore
 * ha l'anteprima, quindi si vede prima di salvare; una bozza vera vuol dire due
 * documenti e un «scarta le modifiche», e l'ondata 1 non li ha. Un modulo già
 * compilato non cambia sotto i piedi ai ticket esistenti: il ticket porta la
 * `revision` con cui è stato compilato.
 */
export function catalogFormSDL(): string {
  return `#graphql

  # ── La libreria dei campi del tenant ──────────────────────────────────────

  """Una scelta di un campo a vocabolario: il valore che finisce sul ticket e l'etichetta che si legge."""
  type FormFieldOption {
    value: String!
    label: String!
  }

  type FormField {
    id:               ID!
    """Il nome della proprietà sul ticket: immutabile, perché è la colonna nei report e nei filtri."""
    name:             String!
    fieldType:        String!
    label:            String!
    labels:           [LocalizedLabel!]!
    help:             String
    helps:            [LocalizedLabel!]!
    """Obbligatorio per difetto; ogni modulo può sovrascriverlo."""
    required:         Boolean!
    """Il vocabolario del Dizionario da cui pesca le scelte (solo enum e multi_enum)."""
    vocabulary:       String
    validationScript: String
    """
    Le scelte del vocabolario, con l'etichetta nella lingua chiesta: vuote per i
    tipi che non pescano dal Dizionario. Risolte qui perche' le rende sia il web
    sia il portale, e il portale non ha accesso al Dizionario.
    """
    options(language: String): [FormFieldOption!]!
    """I nomi delle voci di catalogo che lo usano: da sapere PRIMA di cancellarlo."""
    usedBy:           [String!]!
    createdAt:        String
    updatedAt:        String
  }

  input LocalizedTextInput {
    language: String!
    text:     String!
  }

  input CreateFormFieldInput {
    name:             String!
    fieldType:        String!
    label:            String!
    labels:           [LocalizedTextInput!]
    help:             String
    helps:            [LocalizedTextInput!]
    required:         Boolean
    vocabulary:       String
    validationScript: String
  }

  """Nome e tipo non si cambiano: il nome è la proprietà sul ticket e cambiarlo perderebbe i dati già raccolti."""
  input UpdateFormFieldInput {
    label:            String
    labels:           [LocalizedTextInput!]
    help:             String
    helps:            [LocalizedTextInput!]
    required:         Boolean
    vocabulary:       String
    validationScript: String
  }

  # ── Il modulo di una voce di catalogo ─────────────────────────────────────

  type CatalogForm {
    itemId:     ID!
    itemName:   String!
    """0 = mai pubblicato, cioè la voce non ha ancora un modulo."""
    revision:   Int!
    """La definizione come JSON (sezioni, campi, condizioni)."""
    definition: String!
    updatedAt:  String
  }

  """Il modulo pronto da compilare: la definizione più i campi che cita, già risolti."""
  type CatalogFormToFill {
    itemId:     ID!
    revision:   Int!
    definition: String!
    fields:     [FormField!]!
  }

  input FormAnswerInput {
    name:   String!
    """Per i campi a valore singolo."""
    value:  String
    """Per la selezione multipla."""
    values: [String!]
    """Per i campi di riferimento (CI, persona, squadra): l'id del nodo puntato."""
    refIds: [ID!]
  }

  """Il nodo puntato da un campo di riferimento."""
  type FormAnswerReference {
    id:    ID!
    label: String!
  }

  """Un file caricato per un campo allegato."""
  type FormAnswerFile {
    id:        ID!
    filename:  String!
    sizeBytes: Int!
  }

  """Una risposta come si legge sul ticket."""
  type FormAnswer {
    name:      String!
    label:     String!
    fieldType: String!
    value:     String
    values:    [String!]!
    """Per i campi di riferimento: i nodi puntati (vuoto per gli altri)."""
    references: [FormAnswerReference!]!
    """Per i campi allegato: i file del ticket per questo campo (vuoto per gli altri)."""
    files:      [FormAnswerFile!]!
  }
  `
}
