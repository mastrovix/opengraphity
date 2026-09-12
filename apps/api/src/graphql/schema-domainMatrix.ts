export function domainMatrixSDL(): string {
  return `
  """
  Una cella della matrice: la combinazione d'ingresso e il valore d'uscita.
  \`value\` è null quando la combinazione è ammessa dai vocabolari del cliente
  ma la matrice non la copre — è il caso che a runtime diventa un errore, e la
  pagina lo mostra come cella da compilare.
  """
  type DomainMatrixCell {
    """Chiave della cella: i valori d'ingresso uniti da "|" nell'ordine di \`inputs\`."""
    key:    String!
    """Gli stessi valori, già separati (una voce per dimensione)."""
    inputs: [String!]!
    value:  String
  }

  """
  Una matrice di dominio del cliente: la regola che traduce valori di
  vocabolario in altri valori di vocabolario (priorità = impatto × urgenza,
  criticità del servizio → impatto, …). Prima queste regole erano tabelle nel
  codice, quindi un valore rinominato dal cliente non stava in nessuna e il
  codice ripiegava su un default in silenzio.
  """
  type DomainMatrix {
    kind:          String!
    """I vocabolari delle dimensioni d'ingresso, nell'ordine della chiave."""
    inputs:        [String!]!
    """Il vocabolario del valore d'uscita."""
    output:        String!
    """I valori ammessi per ogni dimensione d'ingresso, DEL CLIENTE (uno per \`inputs\`)."""
    inputValues:   [[String!]!]!
    """I valori ammessi in uscita, DEL CLIENTE."""
    outputValues:  [String!]!
    """
    Tutte le combinazioni che i vocabolari del cliente rendono possibili, più
    le celle salvate che non ne fanno parte (una chiave rimasta dopo una
    rinomina): così la pagina mostra sia i buchi sia il residuo.
    """
    cells:         [DomainMatrixCell!]!
    """Le chiavi senza valore: se non è vuoto, a runtime quelle combinazioni sono un errore."""
    missing:       [String!]!
    """Le chiavi salvate che non appartengono più ai vocabolari del cliente."""
    stale:         [String!]!
    """
    Le celle il cui VALORE salvato non è più nel vocabolario d'uscita: l'altra
    metà del residuo di una rinomina, che a runtime è un errore
    (\`lib/domainValue.ts\`) e che a occhio non si vedeva — la chiave era valida
    e la matrice sembrava a posto.
    """
    invalid:       [String!]!
    """Vero quando è ancora il contenuto di fabbrica (il cliente non l'ha mai salvata)."""
    isDefault:     Boolean!
    updatedAt:     String
  }

  input DomainMatrixEntryInput {
    key:   String!
    value: String!
  }

  extend type Query {
    """
    Le matrici di dominio del cliente, con i valori VERI dei suoi vocabolari.
    Admin: è configurazione del tenant.
    """
    domainMatrices: [DomainMatrix!]!

    """
    Le criticità che la matrice \`service_impact\` del cliente traduce
    nell'impatto più ALTO: è la definizione di «servizio critico» per il
    banner della console allarmi. Prima quei due valori erano copiati nel web
    (\`CriticalServicesBanner.tsx\`) e mandati al server come filtro, quindi
    un servizio con una criticità aggiunta dall'admin non compariva mai nel
    banner — in silenzio (C-7). Lettura per tutto lo staff, come il banner.
    """
    criticalServiceCriticalities: [String!]!

    """
    I tipi di change PRE-APPROVATI di questo cliente, con il vocabolario fra
    cui scegliere. Una change di un tipo pre-approvato salta la catena di
    approvazioni (è il cambiamento pre-autorizzato dell'ITIL).

    Prima era il letterale \`standard\` in quattro punti del codice: chi
    rinominava quel valore nel Dizionario perdeva la pre-approvazione, e chi
    aggiungeva un tipo che considerava pre-approvato non veniva riconosciuto.
    Admin: è configurazione del tenant.
    """
    preApprovedChangeTypes: PreApprovedChangeTypes!
  }

  """La lista, e i valori fra cui scegliere."""
  type PreApprovedChangeTypes {
    types:      [String!]!
    """Il vocabolario \`change_type\` del cliente: le opzioni possibili."""
    vocabulary: [String!]!
  }

  extend type Mutation {
    """
    Sostituisce la lista dei tipi di change pre-approvati. Ogni valore
    deve essere nel vocabolario \`change_type\` del cliente: una lista con un
    tipo che non esiste sarebbe una pre-approvazione che non si applica a
    nulla. Una lista vuota è legittima (nessuna pre-approvazione).
    """
    updatePreApprovedChangeTypes(types: [String!]!): PreApprovedChangeTypes!

    """
    Salva una matrice. Valida ogni chiave e ogni valore contro i vocabolari
    dichiarati dal tipo di matrice e rifiuta una matrice INCOMPLETA dicendo
    quali combinazioni mancano: una matrice con un buco è un errore a runtime
    su un cammino (apertura di un incident, ingest di un allarme) dove non si
    vuole scoprirlo.
    """
    updateDomainMatrix(kind: String!, entries: [DomainMatrixEntryInput!]!): DomainMatrix!
  }
  `
}
