export function enumTypeSDL(): string {
  return `
  type EnumValueRecordUsage {
    typeName:  String!
    fieldName: String!
    count:     Int!
  }

  type EnumValueUsage {
    value:       String!
    records:     [EnumValueRecordUsage!]!
    policyLists: [String!]!
    matrices:    [String!]!
    configSites: [String!]!
    total:       Int!
  }

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
    Values the product added to the shipped dictionary after this copy was made (or after the last decision),
    which the copy does not have. Always empty for a shipped dictionary. Decide with \`adoptShippedValues\`
    or \`acknowledgeShippedValues\`.
    """
    newShippedValues: [String!]!
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
    """
    Il valore e l'etichetta con cui si legge, NELL'ORDINE DEI VALORI e sempre
    completa: dove l'admin non ha scritto un'etichetta c'e il valore con le
    iniziali maiuscole, quindi chi legge non deve ripiegare da se. Prima
    l'etichetta non esisteva e il dettaglio di un incident mostrava «high /
    high»: i valori spediti sono parole inglesi in un'interfaccia italiana.

    Quattro vocabolari non ne portano di proposito — i «status_*», i cui valori
    sono i nomi dei passi e l'italiano lo scrive l'admin sul passo — e
    «import_severity», i cui 28 valori sono chiavi di riconoscimento dei dati in
    arrivo, non voci di menu.
    """
    valueLabels(language: String): [EnumValueLabel!]!
    """
    Il colore di ogni valore che ne ha uno, nell'ordine dei valori: il nome di
    una famiglia della palette del prodotto (neutral, success, info, purple,
    warning, orange, danger), mai un esadecimale. Un valore senza colore si
    mostra neutro. Revisione del 14 set 2026 · F9: prima i colori erano tabelle
    scritte nel web, e un valore del cliente appariva grigio.
    """
    valueColors: [EnumValueColor!]!
    """The icon of each value that has one, in the order of the values: a name of the product's list (G40)."""
    valueIcons: [EnumValueIcon!]!
    """
    Perche questo vocabolario NON porta etichette per valore, come chiave i18n —
    \`null\` quando le porta (e quindi un'etichetta vuota e vuota davvero).

    Esiste perche il Dizionario scriveva «not written» accanto a tutti i valori
    di \`status_change\`, in entrambe le lingue, senza dire che e di proposito: la
    lettura naturale era «manca qualcosa». Il motivo stava nei commenti del
    server, dove nessun cliente lo legge (17 set 2026).
    """
    valueLabelsReasonKey: String
  }

  type EnumValueColor {
    value: String!
    color: String!
  }

  """
  Un valore del vocabolario e come si legge a schermo.

  «label» e' l'etichetta nella lingua CHIESTA e c'e' sempre, col ripiego
  dichiarato: lingua chiesta → lingua predefinita del cliente → il valore con
  le iniziali maiuscole.
  Chi legge non deve ripiegare da se'.

  «labels» porta le lingue in cui l'etichetta e' davvero scritta, e serve
  all'editor del Dizionario, che mostra un campo per lingua. Una lingua assente
  significa «non scritta», non «vuota».
  """
  type EnumValueLabel {
    value: String!
    label: String!
    labels: [LocalizedLabel!]!
  }

  type LocalizedLabel {
    language: String!
    label:    String!
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
    Le etichette per valore, SOSTITUITE in blocco (la lista che si manda e
    quella che resta). Un'etichetta vuota o assente significa «leggi il
    valore»: non c'e bisogno di cancellarla, basta non mandarla. Le etichette
    dei valori che non esistono piu si scartano da se.
    """
    valueLabels: [EnumValueLabelInput!]
    """
    Il valore con cui si nasce quando nessuno lo indica. Deve essere fra i
    valori (quelli nuovi, se li stai cambiando nella stessa chiamata).
    """
    defaultValue: String
    """I colori per valore, SOSTITUITI in blocco (la lista mandata è quella che resta)."""
    valueColors: [EnumValueColorInput!]
    """The icons per value, replaced as a whole (the list sent is the one that stays)."""
    valueIcons: [EnumValueIconInput!]
  }

  type EnumValueIcon {
    value: String!
    icon:  String!
  }

  input EnumValueIconInput {
    value: String!
    icon:  String!
  }

  input EnumValueColorInput {
    value: String!
    color: String!
  }

  """Un'etichetta, per un valore e per UNA lingua. Un valore con due lingue manda due voci."""
  input EnumValueLabelInput {
    value:    String!
    language: String!
    label:    String!
  }

  """Un valore che si sta togliendo (from) e il valore nuovo su cui riscrivere i record che lo usano (to, deve essere fra i valori nuovi)."""
  input EnumValueReplacementInput {
    from: String!
    to:   String!
  }
  `
}
