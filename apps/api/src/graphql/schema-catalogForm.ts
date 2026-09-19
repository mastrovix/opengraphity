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
    I tipi di CI fra cui si puo' scegliere, per un campo \`ref_ci\`. Vuoto o
    assente = tutta la CMDB. Su un altro tipo di campo e' un errore: un filtro
    che non filtra niente e' peggio di nessun filtro, perche' chi lo imposta
    crede di aver ristretto la scelta.
    """
    refTypes:         [String!]!
    """
    Condiviso nella LIBRERIA: il campo compare fra quelli da riusare su altri
    moduli. Assente o falso = resta del modulo in cui e nato.
    """
    shared:           Boolean!
    """
    Il filtro sui CI offerti, come JSON \`{rules:[…]}\`: lo stesso documento
    delle liste della CMDB. Solo per \`ref_ci\`, e solo sui campi che i tipi
    scelti hanno davvero.
    """
    refFilter:        String
    """
    La FORMULA di un campo calcolato (ondata 6): JavaScript che riceve in
    \`input\` le risposte dei campi non calcolati e RESTITUISCE il valore
    (\`return input.costo * input.quantita\`). Assente = campo normale, lo
    compila una persona. Un campo con formula e' in SOLA LETTURA: il valore lo
    decide il server al salvataggio; il browser lo calcola intanto, solo per
    mostrarlo. Solo sui tipi a valore singolo che diventano una proprieta'.
    """
    formula:          String
    """
    Le COLONNE, se il campo e' una tabella (ondata 7), come JSON:
    «{version, columns: [{name, labels, fieldType, vocabulary, required}]}».
    Viaggia come stringa per la stessa ragione del documento del modulo: e' dato
    del cliente che cambia forma con le ondate, e tipizzarlo qui vorrebbe dire
    ricostruire lo schema GraphQL a ogni modifica di una tabella.
    """
    tableDefinition:  String
    """
    Se questo campo e' una COLONNA nelle liste delle richieste e
    nell'esportazione CSV (ondata 4). Spento per difetto: una libreria ricca ha
    decine di campi, e una colonna per ognuno renderebbe la lista illeggibile.
    Solo i campi che diventano una proprieta' del ticket possono accenderlo.
    """
    inList:           Boolean!
    """
    Le scelte del vocabolario, con l'etichetta nella lingua chiesta: vuote per i
    tipi che non pescano dal Dizionario. Risolte qui perche' le rende sia il web
    sia il portale, e il portale non ha accesso al Dizionario.
    """
    options(language: String): [FormFieldOption!]!
    """
    Le colonne di una tabella GIA' RISOLTE, per chi la compila (ondata 7):
    etichetta nella lingua chiesta e scelte del Dizionario dentro. Diverso da
    \`tableDefinition\`, che e' il documento da modificare nella libreria: qui c'e'
    quello che serve a disegnare una riga, e il browser non deve leggere
    vocabolari.
    """
    tableColumns(language: String): [FormFieldTableColumn!]!
    """I nomi delle voci di catalogo che lo usano: da sapere PRIMA di cancellarlo."""
    usedBy:           [String!]!
    createdAt:        String
    updatedAt:        String
  }

  """Una colonna di tabella pronta da compilare."""
  type FormFieldTableColumn {
    name:      String!
    label:     String!
    fieldType: String!
    required:  Boolean!
    """Le scelte, solo per una colonna a vocabolario."""
    options:   [FormFieldOption!]!
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
    """La formula di un campo calcolato; assente o vuota = campo normale."""
    formula:          String
    """Le colonne di una tabella, come JSON (solo per fieldType «table»)."""
    tableDefinition:  String
    """Colonna nelle liste: spento se assente."""
    inList:           Boolean
    """
    I tipi di CI fra cui si puo' scegliere, per un campo \`ref_ci\`. Vuoto o
    assente = tutta la CMDB. Su un altro tipo di campo e' un errore: un filtro
    che non filtra niente e' peggio di nessun filtro, perche' chi lo imposta
    crede di aver ristretto la scelta.
    """
    refTypes:         [String!]
    """
    Condiviso nella LIBRERIA: il campo compare fra quelli da riusare su altri
    moduli. Assente o falso = resta del modulo in cui e nato.
    """
    shared:           Boolean
    """
    Il filtro sui CI offerti, come JSON \`{rules:[…]}\`: lo stesso documento
    delle liste della CMDB. Solo per \`ref_ci\`, e solo sui campi che i tipi
    scelti hanno davvero.
    """
    refFilter:        String
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
    """La formula di un campo calcolato; stringa vuota = torna un campo normale."""
    formula:          String
    """Le colonne di una tabella, come JSON."""
    tableDefinition:  String
    """Colonna nelle liste."""
    inList:           Boolean
    """
    I tipi di CI fra cui si puo' scegliere, per un campo \`ref_ci\`. Vuoto o
    assente = tutta la CMDB. Su un altro tipo di campo e' un errore: un filtro
    che non filtra niente e' peggio di nessun filtro, perche' chi lo imposta
    crede di aver ristretto la scelta.
    """
    refTypes:         [String!]
    """
    Condiviso nella LIBRERIA: il campo compare fra quelli da riusare su altri
    moduli. Assente o falso = resta del modulo in cui e nato.
    """
    shared:           Boolean
    """
    Il filtro sui CI offerti, come JSON \`{rules:[…]}\`: lo stesso documento
    delle liste della CMDB. Solo per \`ref_ci\`, e solo sui campi che i tipi
    scelti hanno davvero.
    """
    refFilter:        String
  }

  """
  Il TETTO sui moduli (ondata 4). Tecnico, non commerciale: lo stesso per ogni
  piano, e l'amministratore lo cambia da qui. Vedi lib/catalogFormLimits.ts.
  """
  type CatalogFormLimits {
    """Quanti campi puo' avere la libreria."""
    maxLibraryFields:  Int!
    """Quanti campi puo' citare UN modulo."""
    maxFieldsPerForm:  Int!
    """
    Quante RIGHE puo' avere una tabella ripetibile (ondata 7). Era applicato dal
    server e non esposto qui, quindi nessuno poteva alzarlo da UI: un cliente che
    serve 80 righe doveva farsi cambiare una proprieta' nel grafo, mentre tre
    commenti nel codice promettevano il contrario (revisione del 17 set 2026).
    """
    maxTableRows:      Int!
    """Quanti campi ci sono adesso nella libreria: per dire quanto manca al tetto."""
    libraryFieldsUsed: Int!
    """I binari entro cui si puo' scrivere un tetto, per non doverli ripetere nel client."""
    min:               Int!
    max:               Int!
  }

  # ── La proposta dell'AI (19 set 2026) ─────────────────────────────────────
  #
  # Tipizzata e non una stringa JSON, al contrario della definizione del
  # modulo: questa forma e NOSTRA, non dato del cliente, e il designer deve
  # poter rendere pezzo per pezzo (accetta questo campo, non quel vocabolario).
  # Una condizione di visibilita resta JSON perche quella si, e dato del
  # cliente con la forma che cambia per ondate.

  """Perche questo pezzo esiste: il pezzo della descrizione da cui nasce."""
  type FormDesignItemProposal {
    name:                   String!
    description:            String
    """Un valore del vocabolario \`category\`, o null se quello proposto non esisteva."""
    category:               String
    priority:               String
    requiresApproval:       Boolean!
    workflowDefinitionId:   ID
    workflowDefinitionName: String
    why:                    String!
  }

  """Un vocabolario che la proposta vorrebbe CREARE nel Dizionario: si crea solo accettando."""
  type FormDesignVocabularyProposal {
    name:   String!
    label:  String!
    values: [String!]!
    why:    String!
  }

  """Un campo NUOVO da creare in libreria accettando la proposta."""
  type FormDesignFieldProposal {
    name:             String!
    fieldType:        String!
    labelIt:          String!
    labelEn:          String!
    helpIt:           String
    helpEn:           String
    vocabulary:       String
    refTypes:         [String!]!
    """La formula di un campo calcolato, se proposta: JavaScript, da leggere prima di accettarla."""
    formula:          String
    """Lo script di validazione, se proposto: JavaScript, da leggere prima di accettarlo."""
    validationScript: String
    why:              String!
  }

  """Un campo dentro una sezione proposta."""
  type FormDesignSectionItem {
    field:    String!
    """\`library\` = campo che esisteva gia (riuso), \`new\` = da creare."""
    source:   String!
    required: Boolean!
    width:    String!
    endUser:  Boolean!
    readOnly: Boolean!
    """La condizione di visibilita come JSON, o null se il campo si vede sempre."""
    visibleWhen: String
    why:      String!
  }

  type FormDesignSection {
    id:       ID!
    titleIt:  String!
    titleEn:  String!
    columns:  Int!
    items:    [FormDesignSectionItem!]!
  }

  """
  Quello che la proposta ha SCARTATO, e perche: \`key\` e una chiave i18n che il
  designer rende nella lingua del cliente. Uno scarto silenzioso sarebbe il
  difetto peggiore — l'utente accetterebbe una tela diversa da quella che ha
  chiesto senza sapere dove.
  """
  type FormDesignDiscard {
    """Il pezzo di proposta a cui lo scarto si riferisce: l'etichetta di un campo, il nome di un elenco."""
    what:   String!
    key:    String!
    """I parametri della chiave, come JSON."""
    params: String!
  }

  """
  La proposta di progetto per una service request: NON scrive niente. Atterra
  sulla tela del designer come bozza, e si applica accettandola — i campi nuovi
  con \`createFormField\`, i vocabolari con \`createEnumType\`, il modulo con
  \`saveCatalogForm\`.
  """
  type FormDesignProposal {
    """La descrizione da cui e nata, per rileggerla accanto al risultato."""
    prompt:          String!
    item:            FormDesignItemProposal
    sections:        [FormDesignSection!]!
    newFields:       [FormDesignFieldProposal!]!
    newVocabularies: [FormDesignVocabularyProposal!]!
    discarded:       [FormDesignDiscard!]!
    """Quello che il modello dice di non aver potuto fare."""
    notes:           [String!]!
    """Il tetto di campi per modulo: per spiegare un troncamento."""
    maxFieldsPerForm: Int!
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
    """Per i campi TABELLA: le righe (ondata 7). Le righe vuote si scartano."""
    rows:   [FormTableRowInput!]
  }

  """Una cella: il nome della colonna e il suo valore come testo."""
  input FormTableCellInput {
    column: String!
    value:  String
  }

  """
  Una riga di tabella. Celle per NOME e non un oggetto libero: un oggetto
  libero in GraphQL vuol dire uno scalare JSON, e con quello si perde il
  controllo dello schema su cosa arriva.
  """
  input FormTableRowInput {
    cells: [FormTableCellInput!]!
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
    """
    Il valore COME SI LEGGE (ondata 5): l'etichetta del Dizionario per un campo
    a vocabolario, il valore stesso per gli altri. \`value\` resta il dato — lo
    leggono filtri, report e condizioni; questo e' per gli occhi.
    """
    displayValue:  String
    """Gli stessi valori di \`values\`, come si leggono."""
    displayValues: [String!]!
    """Per i campi di riferimento: i nodi puntati (vuoto per gli altri)."""
    references: [FormAnswerReference!]!
    """Per i campi allegato: i file del ticket per questo campo (vuoto per gli altri)."""
    files:      [FormAnswerFile!]!
    """Per i campi TABELLA: le righe, in ordine (vuoto per gli altri)."""
    rows:        [FormAnswerTableRow!]!
    """Le colonne della tabella con cui leggere le righe: nome, etichetta e tipo."""
    tableColumns: [FormAnswerTableColumn!]!
    """
    Le scelte del vocabolario, con l'etichetta: servono a CORREGGERE la
    risposta (decisione del 17 set 2026). Vuota per i campi senza vocabolario.
    """
    options: [FormFieldOption!]!
  }

  """Una riga come si legge: una cella per colonna, nell'ordine delle colonne."""
  type FormAnswerTableRow {
    cells: [FormAnswerTableCell!]!
  }

  type FormAnswerTableCell {
    column: String!
    value:  String
    """Il valore come si legge: l'etichetta del Dizionario per una colonna a scelta."""
    displayValue: String
  }

  type FormAnswerTableColumn {
    name:      String!
    label:     String!
    fieldType: String!
  }
  `
}
