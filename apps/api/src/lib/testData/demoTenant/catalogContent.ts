/**
 * THE DEMO TENANT'S SERVICE CATALOG: 50 REQUEST MODELS (23 Sep 2026).
 *
 * The owner of the product asked for request models "built with the
 * designer". Most fields belong to one model only (the library name starts
 * with the model's key); the ones every company shares across its forms —
 * the office, the full name of a person, the device model, the software, the
 * size — are ONE field of the library, reused (tour of 23 Sep 2026, D26: the
 * requests list had eleven «Office site» columns and forty-six in all), and
 * only those four are columns of the list. The forms are
 * created through the app's own mutations (`createFormField`,
 * `saveCatalogForm`), so every rule of the designer applies to them: section
 * titles in English and Italian, a required field offered to the end user,
 * reference fields in the portal only towards CI types, conditions only on
 * fields of the form.
 *
 * Each field carries how a requester answers it (`answer`), so the 15,000
 * requests carry plausible answers and not random strings.
 */

export type DemoFieldType =
  | 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'boolean' | 'enum' | 'multi_enum'
  | 'ref_ci' | 'ref_user' | 'table' | 'note'

export interface DemoFieldSpec {
  /** Without the model prefix: the library name is `<model key>_<key>`. */
  key: string
  type: DemoFieldType
  label: string
  labelIt: string
  help?: string
  required?: boolean
  /** Shown as a column in the requests list. */
  inList?: boolean
  vocabulary?: string
  refTypes?: string[]
  /** Staff only: not offered in the portal (reference fields to users must be). */
  agentOnly?: boolean
  width?: 'full' | 'half'
  /**
   * One field of the library shared by several models: its library name is
   * `key`, without the model's prefix, and it is created once (D26).
   */
  shared?: boolean
  /** Visible only when another field of the form has this value. */
  visibleWhen?: { field: string; op: 'eq' | 'filled'; value?: string }
  table?: Array<{ name: string; label: string; labelIt: string; type: 'text' | 'number' | 'date' | 'boolean' | 'enum'; vocabulary?: string; required?: boolean }>
  /** How requesters answer: sample texts, a number range, a probability of "yes". */
  answer?: {
    samples?: string[]; min?: number; max?: number; yes?: number; daysAhead?: [number, number]; rows?: [number, number]
    /** A shared vocabulary serves several models: the values that make sense for this one. */
    values?: string[]
  }
}

export interface DemoSectionSpec {
  id: string
  title: string
  titleIt: string
  columns?: 1 | 2
  fields: DemoFieldSpec[]
}

export interface DemoCatalogItemSpec {
  key: string
  name: string
  description: string
  /** The `category` vocabulary, with the three values the tenant adds to it (D28). */
  category: 'hardware' | 'software' | 'network' | 'access' | 'security' | 'infrastructure' | 'workplace' | 'people' | 'other'
  priority: 'low' | 'medium' | 'high' | 'critical'
  requiresApproval: boolean
  /** Relative demand: how often people ask for it. */
  demand: number
  /**
   * How long it typically takes to FULFIL, in hours from submission (the
   * median; the approval included). The requests of the tenant are open for
   * this long (D1: ~125 open, median ~16 hours, see serviceRequests.ts).
   */
  fulfilHours: number
  /** The support tower whose team fulfils it: its FULFILMENT GROUP (D56). */
  fulfilTower: string
  /** Done where the person is (a desk, a device): the group dispatches it to the team of the requester's region. */
  local?: boolean
  /** What the requester writes as the request's free text. */
  details: string[]
  sections: DemoSectionSpec[]
}

/**
 * Tenant vocabularies the forms need (created through the Dictionary's
 * mutation), each value with its English and Italian label (D54: the
 * diagnostics found eighteen vocabularies with no label in any language, and
 * the forms showed «Pick Up At The IT Desk»).
 */
export const DEMO_VOCABULARIES: ReadonlyArray<{ name: string; label: string; entries: ReadonlyArray<readonly [value: string, it: string]> }> = [
  { name: 'laptop_model', label: 'Laptop model', entries: [['Standard 14"', 'Standard 14"'], ['Performance 15"', 'Prestazioni 15"'], ['Ultralight 13"', 'Ultraleggero 13"'], ['Developer 16"', 'Sviluppatore 16"'], ['Rugged 14"', 'Rinforzato 14"']] },
  { name: 'device_model', label: 'Device model', entries: [
    ['Laptop Standard 14"', 'Portatile Standard 14"'], ['Laptop Performance 15"', 'Portatile Prestazioni 15"'], ['Laptop Ultralight 13"', 'Portatile Ultraleggero 13"'],
    ['Laptop Developer 16"', 'Portatile Sviluppatore 16"'], ['Laptop Rugged 14"', 'Portatile Rinforzato 14"'],
    ['Desktop Compact office', 'Desktop compatto da ufficio'], ['Desktop Engineering tower', 'Desktop tower per ingegneria'],
    ['Desktop Graphics workstation', 'Workstation grafica'], ['Desktop Thin client', 'Thin client'],
    ['Phone Standard smartphone', 'Smartphone standard'], ['Phone Premium smartphone', 'Smartphone premium'],
    ['Phone Rugged smartphone', 'Smartphone rinforzato'], ['Phone Basic phone', 'Cellulare base'],
  ] },
  { name: 'equipment_size', label: 'Size', entries: [
    ['24"', '24"'], ['27"', '27"'], ['32"', '32"'], ['34" ultrawide', '34" ultrawide'],
    ['Small (2 vCPU, 8 GB)', 'Piccola (2 vCPU, 8 GB)'], ['Medium (4 vCPU, 16 GB)', 'Media (4 vCPU, 16 GB)'],
    ['Large (8 vCPU, 32 GB)', 'Grande (8 vCPU, 32 GB)'], ['X-Large (16 vCPU, 64 GB)', 'Molto grande (16 vCPU, 64 GB)'],
  ] },
  // D30: the offices of the company, the same list people work at (names.ts).
  { name: 'office_site', label: 'Office site', entries: [
    ['Milan HQ', 'Milano, sede centrale'], ['Rome', 'Roma'], ['Turin', 'Torino'], ['Frankfurt', 'Francoforte'], ['Paris', 'Parigi'],
    ['Madrid', 'Madrid'], ['London', 'Londra'], ['Dublin', 'Dublino'], ['Amsterdam', 'Amsterdam'], ['Stockholm', 'Stoccolma'],
    ['New York', 'New York'], ['Chicago', 'Chicago'], ['Bangalore', 'Bangalore'], ['Singapore', 'Singapore'], ['Tokyo', 'Tokyo'],
    ['Sydney', 'Sydney'], ['Remote', 'Da remoto'],
  ] },
  { name: 'department', label: 'Department', entries: [
    ['Finance', 'Finanza'], ['Human Resources', 'Risorse umane'], ['Sales', 'Vendite'], ['Marketing', 'Marketing'], ['Operations', 'Operazioni'],
    ['Legal', 'Legale'], ['IT', 'IT'], ['Customer Care', 'Assistenza clienti'], ['Procurement', 'Acquisti'], ['Risk', 'Rischi'],
  ] },
  { name: 'access_level', label: 'Access level', entries: [['Read only', 'Sola lettura'], ['Read and write', 'Lettura e scrittura'], ['Administrator', 'Amministratore']] },
  { name: 'software_title', label: 'Software title', entries: [
    ['Office suite', 'Suite per l\'ufficio'], ['PDF editor', 'Editor PDF'], ['Diagram editor', 'Editor di diagrammi'], ['Statistics package', 'Pacchetto statistico'],
    ['Project planner', 'Pianificatore di progetti'], ['Screen recorder', 'Registratore dello schermo'], ['Password manager', 'Gestore di password'],
    ['Remote desktop client', 'Client di desktop remoto'],
  ] },
  { name: 'license_term', label: 'License term', entries: [['Monthly', 'Mensile'], ['Yearly', 'Annuale'], ['Perpetual', 'Perpetua']] },
  { name: 'dev_tool', label: 'Developer tool', entries: [
    ['IDE', 'IDE'], ['Container runtime', 'Runtime per container'], ['Database client', 'Client per database'], ['API client', 'Client per API'],
    ['Git GUI', 'Interfaccia grafica per Git'], ['Profiler', 'Profiler'],
  ] },
  { name: 'cloud_region', label: 'Cloud region', entries: [['AWS eu-west-1', 'AWS eu-west-1'], ['AWS eu-central-1', 'AWS eu-central-1'], ['Azure West Europe', 'Azure West Europe'], ['Azure North Europe', 'Azure North Europe']] },
  { name: 'network_protocol', label: 'Network protocol', entries: [['TCP', 'TCP'], ['UDP', 'UDP'], ['TCP and UDP', 'TCP e UDP'], ['ICMP', 'ICMP']] },
  { name: 'dns_record_type', label: 'DNS record type', entries: [['A', 'A'], ['AAAA', 'AAAA'], ['CNAME', 'CNAME'], ['MX', 'MX'], ['TXT', 'TXT'], ['SRV', 'SRV']] },
  { name: 'data_classification', label: 'Data classification', entries: [['Public', 'Pubblico'], ['Internal', 'Interno'], ['Confidential', 'Riservato'], ['Restricted', 'Strettamente riservato']] },
  { name: 'training_course', label: 'Training course', entries: [
    ['Information security awareness', 'Consapevolezza sulla sicurezza delle informazioni'], ['Data protection basics', 'Fondamenti di protezione dei dati'],
    ['Project management', 'Gestione dei progetti'], ['Agile practices', 'Pratiche agili'], ['Cloud fundamentals', 'Fondamenti di cloud'],
    ['Leadership essentials', 'Fondamenti di leadership'], ['Negotiation skills', 'Tecniche di negoziazione'],
  ] },
  { name: 'shipping_option', label: 'Shipping option', entries: [['Pick up at the IT desk', 'Ritiro al banco IT'], ['Deliver to my desk', 'Consegna alla mia scrivania'], ['Ship to my home address', 'Spedizione al mio indirizzo di casa']] },
  { name: 'meeting_room_size', label: 'Meeting room size', entries: [['Huddle (4)', 'Saletta (4)'], ['Small (8)', 'Piccola (8)'], ['Medium (14)', 'Media (14)'], ['Boardroom (24)', 'Sala consiglio (24)']] },
]

/** The values of a demo vocabulary, in order. */
export function vocabularyValues(v: (typeof DEMO_VOCABULARIES)[number]): string[] {
  return v.entries.map(([value]) => value)
}

/**
 * THE VALUES THE TENANT ADDS TO THE SHIPPED `category` VOCABULARY (D28):
 * twelve models of fifty sat in «Other» — cloud machines, databases,
 * onboarding, desk moves. A customer adds the categories its catalog needs.
 */
export const CATALOG_CATEGORIES: ReadonlyArray<readonly [value: string, en: string, it: string]> = [
  ['infrastructure', 'Infrastructure', 'Infrastruttura'],
  ['workplace', 'Workplace', 'Postazione di lavoro'],
  ['people', 'People', 'Persone'],
]

// ── The fields every company shares across its forms (D26) ─────────────────
const SITE: DemoFieldSpec = { key: 'office_site', shared: true, type: 'enum', label: 'Office site', labelIt: 'Sede', vocabulary: 'office_site', required: true, width: 'half', inList: true }
const fullName = (samples: string[]): DemoFieldSpec => ({ key: 'full_name', shared: true, type: 'text', label: 'Full name', labelIt: 'Nome e cognome', required: true, inList: true, width: 'half', answer: { samples } })
const model = (values: string[]): DemoFieldSpec => ({ key: 'device_model', shared: true, type: 'enum', label: 'Model', labelIt: 'Modello', vocabulary: 'device_model', required: true, inList: true, width: 'half', answer: { values } })
const SOFTWARE: DemoFieldSpec = { key: 'software', shared: true, type: 'enum', label: 'Software', labelIt: 'Software', vocabulary: 'software_title', required: true, inList: true, width: 'half' }
const size = (values: string[]): DemoFieldSpec => ({ key: 'size', shared: true, type: 'enum', label: 'Size', labelIt: 'Dimensione', vocabulary: 'equipment_size', required: true, width: 'half', answer: { values } })

/** Builds a spec with a key-prefixed field list (the prefix is added by the creator, not here). */
function item(spec: DemoCatalogItemSpec): DemoCatalogItemSpec { return spec }

export const DEMO_CATALOG: readonly DemoCatalogItemSpec[] = [
  // ── Hardware ──────────────────────────────────────────────────────────────
  item({ key: 'laptop', name: 'New Laptop', description: 'Request a new or replacement laptop.', category: 'hardware', priority: 'medium', requiresApproval: true, demand: 9, fulfilHours: 48, fulfilTower: 'End User Computing', local: true,
    details: ['My laptop is five years old and very slow.', 'New starter in my team next month.', 'Replacement after the screen broke.', 'I need a machine that can run the analysis tools.'],
    sections: [
      { id: 'device', title: 'Device', titleIt: 'Dispositivo', columns: 2, fields: [
        model(['Laptop Standard 14"', 'Laptop Performance 15"', 'Laptop Ultralight 13"', 'Laptop Developer 16"', 'Laptop Rugged 14"']),
        { key: 'replacement', type: 'boolean', label: 'Replaces an existing laptop', labelIt: 'Sostituisce un portatile esistente', width: 'half', answer: { yes: 0.55 } },
        { key: 'old_asset_tag', type: 'text', label: 'Asset tag of the laptop being replaced', labelIt: 'Etichetta del portatile sostituito', visibleWhen: { field: 'replacement', op: 'eq', value: 'true' }, answer: { samples: ['LT-20411', 'LT-18877', 'LT-22190', 'LT-19533'] } },
        { key: 'justification', type: 'textarea', label: 'Business justification', labelIt: 'Motivazione', required: true, answer: { samples: ['Current device no longer meets performance needs.', 'New hire starting in the team.', 'Device damaged beyond repair.'] } },
      ] },
      { id: 'delivery', title: 'Delivery', titleIt: 'Consegna', columns: 2, fields: [
        SITE,
        { key: 'shipping', type: 'enum', label: 'Shipping', labelIt: 'Spedizione', vocabulary: 'shipping_option', width: 'half' },
        { key: 'needed_by', type: 'date', label: 'Needed by', labelIt: 'Serve entro', width: 'half', answer: { daysAhead: [5, 30] } },
      ] },
    ] }),
  item({ key: 'desktop', name: 'Desktop Workstation', description: 'Request a desktop computer or workstation.', category: 'hardware', priority: 'medium', requiresApproval: true, demand: 3, fulfilHours: 60, fulfilTower: 'End User Computing', local: true,
    details: ['Workstation for CAD work.', 'Shared PC for the reception.', 'Replacement of a failing desktop.'],
    sections: [{ id: 'workstation', title: 'Workstation', titleIt: 'Postazione', columns: 2, fields: [
      model(['Desktop Compact office', 'Desktop Engineering tower', 'Desktop Graphics workstation', 'Desktop Thin client']),
      SITE,
      { key: 'monitors', type: 'number', label: 'Number of monitors', labelIt: 'Numero di monitor', width: 'half', answer: { min: 1, max: 3 } },
      { key: 'usage', type: 'textarea', label: 'What it will be used for', labelIt: 'Per cosa verrà usata', required: true, answer: { samples: ['3D modelling and rendering.', 'Front desk check-in.', 'Trading desk with market data feeds.'] } },
    ] }] }),
  item({ key: 'monitor', name: 'Additional Monitor', description: 'Request an extra or bigger monitor.', category: 'hardware', priority: 'low', requiresApproval: false, demand: 6, fulfilHours: 20, fulfilTower: 'End User Computing', local: true,
    details: ['I would like a second screen.', 'Bigger monitor for spreadsheets.', 'Ergonomic setup recommended by the doctor.'],
    sections: [{ id: 'monitor', title: 'Monitor', titleIt: 'Monitor', columns: 2, fields: [
      size(['24"', '27"', '32"', '34" ultrawide']),
      { key: 'quantity', type: 'number', label: 'Quantity', labelIt: 'Quantità', required: true, width: 'half', answer: { min: 1, max: 2 } },
      SITE,
      { key: 'height_adjustable', type: 'boolean', label: 'Height-adjustable stand', labelIt: 'Supporto regolabile in altezza', width: 'half', answer: { yes: 0.4 } },
    ] }] }),
  item({ key: 'dock', name: 'Docking Station', description: 'Request a docking station for your laptop.', category: 'hardware', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 14, fulfilTower: 'End User Computing', local: true,
    details: ['Docking station for my home office.', 'The old dock does not support two screens.'],
    sections: [{ id: 'dock', title: 'Docking station', titleIt: 'Docking station', columns: 2, fields: [
      SITE,
      { key: 'laptop_tag', type: 'text', label: 'Asset tag of your laptop', labelIt: 'Etichetta del tuo portatile', required: true, width: 'half', answer: { samples: ['LT-21007', 'LT-23315', 'LT-20982', 'LT-24410'] } },
      { key: 'dual_display', type: 'boolean', label: 'Two external displays', labelIt: 'Due schermi esterni', width: 'half', answer: { yes: 0.6 } },
    ] }] }),
  item({ key: 'mobile', name: 'Mobile Phone', description: 'Request a company mobile phone and SIM.', category: 'hardware', priority: 'medium', requiresApproval: true, demand: 5, fulfilHours: 36, fulfilTower: 'End User Computing', local: true,
    details: ['I am now on call and need a company phone.', 'My phone was stolen.', 'Travelling abroad for the project.'],
    sections: [
      { id: 'phone', title: 'Phone', titleIt: 'Telefono', columns: 2, fields: [
        model(['Phone Standard smartphone', 'Phone Premium smartphone', 'Phone Rugged smartphone', 'Phone Basic phone']),
        { key: 'international', type: 'boolean', label: 'International roaming', labelIt: 'Roaming internazionale', width: 'half', answer: { yes: 0.3 } },
        { key: 'countries', type: 'text', label: 'Countries you travel to', labelIt: 'Paesi in cui viaggi', visibleWhen: { field: 'international', op: 'eq', value: 'true' }, answer: { samples: ['Germany, France', 'United States', 'United Kingdom', 'Spain, Portugal'] } },
      ] },
      { id: 'reason', title: 'Reason', titleIt: 'Motivo', fields: [
        { key: 'reason', type: 'textarea', label: 'Why you need it', labelIt: 'Perché ti serve', required: true, answer: { samples: ['On-call rota for the support team.', 'Field work with customers.', 'Replacement of a lost device.'] } },
      ] },
    ] }),
  item({ key: 'tablet', name: 'Tablet', description: 'Request a tablet for field or presentation work.', category: 'hardware', priority: 'low', requiresApproval: true, demand: 2, fulfilHours: 36, fulfilTower: 'End User Computing', local: true,
    details: ['Tablet for store visits.', 'Presentations to customers.'],
    sections: [{ id: 'tablet', title: 'Tablet', titleIt: 'Tablet', columns: 2, fields: [
      { key: 'cellular', type: 'boolean', label: 'With mobile data', labelIt: 'Con dati mobili', width: 'half', answer: { yes: 0.5 } },
      { key: 'keyboard', type: 'boolean', label: 'With keyboard cover', labelIt: 'Con cover tastiera', width: 'half', answer: { yes: 0.5 } },
      { key: 'purpose', type: 'textarea', label: 'Purpose', labelIt: 'Scopo', required: true, answer: { samples: ['Field inspections.', 'Sales presentations.', 'Warehouse stock counts.'] } },
    ] }] }),
  item({ key: 'headset', name: 'Headset', description: 'Request a headset for calls and meetings.', category: 'hardware', priority: 'low', requiresApproval: false, demand: 5, fulfilHours: 10, fulfilTower: 'End User Computing', local: true,
    details: ['My headset broke.', 'I need noise cancelling for the open space.'],
    sections: [{ id: 'headset', title: 'Headset', titleIt: 'Cuffie', columns: 2, fields: [
      { key: 'wireless', type: 'boolean', label: 'Wireless', labelIt: 'Senza fili', width: 'half', answer: { yes: 0.6 } },
      { key: 'noise_cancelling', type: 'boolean', label: 'Noise cancelling', labelIt: 'Cancellazione del rumore', width: 'half', answer: { yes: 0.7 } },
      SITE,
    ] }] }),
  item({ key: 'peripherals', name: 'Keyboard and Mouse', description: 'Request a keyboard, mouse or other peripherals.', category: 'hardware', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 10, fulfilTower: 'End User Computing', local: true,
    details: ['Ergonomic keyboard please.', 'Replacement mouse.', 'Keyboard with Italian layout.'],
    sections: [{ id: 'items', title: 'Items', titleIt: 'Articoli', fields: [
      { key: 'items', type: 'table', label: 'Items requested', labelIt: 'Articoli richiesti', required: true,
        table: [
          { name: 'item', label: 'Item', labelIt: 'Articolo', type: 'text', required: true },
          { name: 'quantity', label: 'Quantity', labelIt: 'Quantità', type: 'number', required: true },
          { name: 'ergonomic', label: 'Ergonomic', labelIt: 'Ergonomico', type: 'boolean' },
        ],
        answer: { samples: ['Keyboard', 'Mouse', 'Wrist rest', 'Laptop stand', 'USB-C adapter'], rows: [1, 3] } },
      SITE,
    ] }] }),
  item({ key: 'hwrepair', name: 'Hardware Repair', description: 'Report faulty hardware and ask for a repair or a swap.', category: 'hardware', priority: 'medium', requiresApproval: false, demand: 6, fulfilHours: 20, fulfilTower: 'End User Computing', local: true,
    details: ['The keyboard has keys that do not work.', 'Battery lasts less than an hour.', 'The laptop does not boot.'],
    sections: [{ id: 'fault', title: 'Fault', titleIt: 'Guasto', columns: 2, fields: [
      { key: 'asset_tag', type: 'text', label: 'Asset tag', labelIt: 'Etichetta del bene', required: true, width: 'half', answer: { samples: ['LT-20114', 'LT-19870', 'DT-04412', 'LT-22871', 'MN-10233'] } },
      { key: 'symptom', type: 'textarea', label: 'What is wrong', labelIt: 'Cosa non funziona', required: true, answer: { samples: ['Screen flickers.', 'Battery drains quickly.', 'Does not power on.', 'Fan is very loud.'] } },
      { key: 'loaner', type: 'boolean', label: 'I need a loaner meanwhile', labelIt: 'Mi serve un sostitutivo nel frattempo', width: 'half', answer: { yes: 0.45 } },
      SITE,
    ] }] }),
  item({ key: 'printer', name: 'Printer Access', description: 'Get access to a network printer.', category: 'hardware', priority: 'low', requiresApproval: false, demand: 3, fulfilHours: 8, fulfilTower: 'End User Computing', local: true,
    details: ['I cannot print on the third floor.', 'New printer in our area.'],
    sections: [{ id: 'printer', title: 'Printer', titleIt: 'Stampante', columns: 2, fields: [
      SITE,
      { key: 'floor', type: 'text', label: 'Floor and area', labelIt: 'Piano e zona', required: true, width: 'half', answer: { samples: ['3rd floor, east wing', 'Ground floor, reception', '5th floor, finance area', '2nd floor'] } },
      { key: 'color', type: 'boolean', label: 'Colour printing', labelIt: 'Stampa a colori', width: 'half', answer: { yes: 0.35 } },
    ] }] }),

  // ── Software ──────────────────────────────────────────────────────────────
  item({ key: 'swinstall', name: 'Software Installation', description: 'Install approved software on your device.', category: 'software', priority: 'low', requiresApproval: false, demand: 9, fulfilHours: 8, fulfilTower: 'End User Computing',
    details: ['I need this tool for the new project.', 'Please install it on my laptop.'],
    sections: [{ id: 'software', title: 'Software', titleIt: 'Software', columns: 2, fields: [
      SOFTWARE,
      { key: 'device_tag', type: 'text', label: 'Device asset tag', labelIt: 'Etichetta del dispositivo', required: true, width: 'half', answer: { samples: ['LT-21407', 'LT-20009', 'DT-03310', 'LT-24110'] } },
      { key: 'notes', type: 'textarea', label: 'Notes for the technician', labelIt: 'Note per il tecnico', answer: { samples: ['Any time after 3 pm.', 'I work remotely on Fridays.', ''] } },
    ] }] }),
  item({ key: 'license', name: 'Software License', description: 'Request a licence for licensed software.', category: 'software', priority: 'medium', requiresApproval: true, demand: 6, fulfilHours: 20, fulfilTower: 'End User Computing',
    details: ['License for the statistics package.', 'My trial expired.'],
    sections: [{ id: 'license', title: 'License', titleIt: 'Licenza', columns: 2, fields: [
      SOFTWARE,
      { key: 'term', type: 'enum', label: 'Term', labelIt: 'Durata', vocabulary: 'license_term', required: true, width: 'half' },
      { key: 'users', type: 'number', label: 'Number of users', labelIt: 'Numero di utenti', required: true, width: 'half', answer: { min: 1, max: 12 } },
      { key: 'cost_center', type: 'text', label: 'Cost center', labelIt: 'Centro di costo', required: true, width: 'half', answer: { samples: ['CC-410', 'CC-220', 'CC-705', 'CC-318'] } },
    ] }] }),
  item({ key: 'devtools', name: 'Developer Tools', description: 'Request developer tooling on your workstation.', category: 'software', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 10, fulfilTower: 'DevOps Tooling',
    details: ['Setting up my development environment.', 'Need the profiler to investigate a leak.'],
    sections: [{ id: 'tools', title: 'Tools', titleIt: 'Strumenti', fields: [
      { key: 'tools', type: 'multi_enum', label: 'Tools', labelIt: 'Strumenti', vocabulary: 'dev_tool', required: true },
      { key: 'admin_rights', type: 'boolean', label: 'Temporary local admin rights', labelIt: 'Diritti di amministratore temporanei', answer: { yes: 0.25 } },
      { key: 'project', type: 'text', label: 'Project', labelIt: 'Progetto', answer: { samples: ['Payments modernisation', 'Customer portal v3', 'Data platform migration', 'Mobile app'] } },
    ] }] }),
  item({ key: 'swremove', name: 'Software Removal', description: 'Remove software you no longer need.', category: 'software', priority: 'low', requiresApproval: false, demand: 2, fulfilHours: 6, fulfilTower: 'End User Computing',
    details: ['I no longer use it.', 'License to be reassigned.'],
    sections: [{ id: 'removal', title: 'Removal', titleIt: 'Rimozione', columns: 2, fields: [
      SOFTWARE,
      { key: 'device_tag', type: 'text', label: 'Device asset tag', labelIt: 'Etichetta del dispositivo', required: true, width: 'half', answer: { samples: ['LT-21001', 'LT-18030', 'DT-02201'] } },
    ] }] }),
  item({ key: 'appenv', name: 'New Application Environment', description: 'Request a new environment (test, staging) for an application.', category: 'infrastructure', priority: 'medium', requiresApproval: true, demand: 3, fulfilHours: 64, fulfilTower: 'Cloud Operations',
    details: ['We need a staging environment before the go-live.', 'Performance test environment for Q4.'],
    sections: [
      { id: 'app', title: 'Application', titleIt: 'Applicazione', fields: [
        { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application'], required: true },
        { key: 'environment', type: 'enum', label: 'Environment', labelIt: 'Ambiente', vocabulary: 'environment', required: true },
      ] },
      { id: 'sizing', title: 'Sizing', titleIt: 'Dimensionamento', columns: 2, fields: [
        { key: 'servers', type: 'number', label: 'Servers', labelIt: 'Server', width: 'half', answer: { min: 1, max: 6 } },
        { key: 'database', type: 'boolean', label: 'Needs a database', labelIt: 'Serve un database', width: 'half', answer: { yes: 0.7 } },
        { key: 'ready_by', type: 'date', label: 'Ready by', labelIt: 'Pronto entro', width: 'half', answer: { daysAhead: [14, 60] } },
      ] },
    ] }),
  item({ key: 'appaccess', name: 'Application Access', description: 'Request a role in a business application.', category: 'access', priority: 'medium', requiresApproval: true, demand: 8, fulfilHours: 14, fulfilTower: 'Identity & Access',
    details: ['I changed team and need the new role.', 'Read access for the audit.'],
    sections: [{ id: 'access', title: 'Access', titleIt: 'Accesso', fields: [
      { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application', 'business_application'], required: true },
      { key: 'level', type: 'enum', label: 'Access level', labelIt: 'Livello di accesso', vocabulary: 'access_level', required: true },
      { key: 'until', type: 'date', label: 'Needed until', labelIt: 'Serve fino al', answer: { daysAhead: [30, 365] } },
      { key: 'reason', type: 'textarea', label: 'Reason', labelIt: 'Motivo', required: true, answer: { samples: ['New responsibilities in the team.', 'Quarterly audit.', 'Backup for a colleague on leave.'] } },
    ] }] }),

  // ── Access ────────────────────────────────────────────────────────────────
  item({ key: 'newuser', name: 'New User Account', description: 'Create accounts for a new employee or contractor.', category: 'people', priority: 'high', requiresApproval: true, demand: 7, fulfilHours: 20, fulfilTower: 'Identity & Access',
    details: ['New hire starting on Monday.', 'Contractor joining the project.'],
    sections: [
      { id: 'person', title: 'Person', titleIt: 'Persona', columns: 2, fields: [
        fullName(['Laura Bianchi', 'James Walker', 'Sofia Romano', 'Lukas Weber', 'Elena Costa', 'Hugo Moreau']),
        { key: 'start_date', type: 'date', label: 'Start date', labelIt: 'Data di inizio', required: true, width: 'half', answer: { daysAhead: [3, 30] } },
        { key: 'department', type: 'enum', label: 'Department', labelIt: 'Reparto', vocabulary: 'department', required: true, width: 'half' },
        { key: 'contractor', type: 'boolean', label: 'External contractor', labelIt: 'Collaboratore esterno', width: 'half', answer: { yes: 0.3 } },
        { key: 'end_date', type: 'date', label: 'Contract end date', labelIt: 'Fine contratto', visibleWhen: { field: 'contractor', op: 'eq', value: 'true' }, answer: { daysAhead: [90, 365] } },
      ] },
      { id: 'accounts', title: 'Accounts', titleIt: 'Account', fields: [
        { key: 'email', type: 'boolean', label: 'Mailbox', labelIt: 'Casella di posta', answer: { yes: 0.95 } },
        { key: 'manager', type: 'ref_user', label: 'Line manager', labelIt: 'Responsabile', agentOnly: true },
      ] },
    ] }),
  item({ key: 'folder', name: 'Shared Folder Access', description: 'Access to a shared folder on the file server.', category: 'access', priority: 'low', requiresApproval: true, demand: 7, fulfilHours: 10, fulfilTower: 'Identity & Access',
    details: ['I need the finance reports folder.', 'Access for the new project folder.'],
    sections: [{ id: 'folder', title: 'Folder', titleIt: 'Cartella', columns: 2, fields: [
      { key: 'path', type: 'text', label: 'Folder path', labelIt: 'Percorso della cartella', required: true, answer: { samples: ['\\\\fs01\\finance\\reports', '\\\\fs02\\projects\\apollo', '\\\\fs01\\hr\\policies', '\\\\fs03\\marketing\\assets'] } },
      { key: 'level', type: 'enum', label: 'Access level', labelIt: 'Livello di accesso', vocabulary: 'access_level', required: true, width: 'half' },
      { key: 'classification', type: 'enum', label: 'Data classification', labelIt: 'Classificazione dei dati', vocabulary: 'data_classification', width: 'half' },
    ] }] }),
  item({ key: 'vpn', name: 'VPN Access', description: 'Remote access to the company network.', category: 'access', priority: 'medium', requiresApproval: true, demand: 6, fulfilHours: 10, fulfilTower: 'Network Security',
    details: ['I will work from home two days a week.', 'Supplier needs remote access for maintenance.'],
    sections: [{ id: 'vpn', title: 'VPN', titleIt: 'VPN', columns: 2, fields: [
      { key: 'profile', type: 'enum', label: 'Profile', labelIt: 'Profilo', vocabulary: 'access_level', required: true, width: 'half' },
      { key: 'until', type: 'date', label: 'Needed until', labelIt: 'Serve fino al', width: 'half', answer: { daysAhead: [30, 365] } },
      { key: 'reason', type: 'textarea', label: 'Reason', labelIt: 'Motivo', required: true, answer: { samples: ['Hybrid working.', 'Supplier maintenance window.', 'On-call support.'] } },
    ] }] }),
  item({ key: 'privileged', name: 'Privileged Access', description: 'Temporary administrator access to a system.', category: 'access', priority: 'high', requiresApproval: true, demand: 3, fulfilHours: 6, fulfilTower: 'Identity & Access',
    details: ['Admin access to apply a patch.', 'Emergency access for the migration weekend.'],
    sections: [
      { id: 'target', title: 'Target', titleIt: 'Destinazione', fields: [
        { key: 'system', type: 'ref_ci', label: 'System', labelIt: 'Sistema', refTypes: ['server', 'database_instance', 'application'], required: true },
        { key: 'from', type: 'datetime', label: 'From', labelIt: 'Dal', required: true, answer: { daysAhead: [1, 10] } },
        { key: 'hours', type: 'number', label: 'Duration (hours)', labelIt: 'Durata (ore)', required: true, answer: { min: 2, max: 48 } },
      ] },
      { id: 'why', title: 'Justification', titleIt: 'Motivazione', fields: [
        { key: 'justification', type: 'textarea', label: 'Justification', labelIt: 'Motivazione', required: true, answer: { samples: ['Patch installation during the maintenance window.', 'Investigation of a production incident.', 'Database migration.'] } },
        { key: 'policy_note', type: 'note', label: 'Privileged sessions are recorded and reviewed by Security Operations.', labelIt: 'Le sessioni privilegiate sono registrate e riviste dalla Security Operations.' },
      ] },
    ] }),
  item({ key: 'dlist', name: 'Distribution List Membership', description: 'Join or leave an e-mail distribution list.', category: 'access', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 4, fulfilTower: 'Service Desk',
    details: ['Please add me to the project list.', 'Remove me from the old team list.'],
    sections: [{ id: 'list', title: 'List', titleIt: 'Lista', columns: 2, fields: [
      { key: 'list_name', type: 'text', label: 'List address', labelIt: 'Indirizzo della lista', required: true, answer: { samples: ['finance-all@opengrafo-demo.com', 'project-apollo@opengrafo-demo.com', 'it-announcements@opengrafo-demo.com'] } },
      { key: 'join', type: 'boolean', label: 'Join (untick to leave)', labelIt: 'Iscriviti (togli la spunta per uscire)', width: 'half', answer: { yes: 0.85 } },
    ] }] }),
  item({ key: 'mailbox', name: 'Shared Mailbox Access', description: 'Access to a shared mailbox.', category: 'access', priority: 'low', requiresApproval: true, demand: 4, fulfilHours: 8, fulfilTower: 'Service Desk',
    details: ['I cover the customer care mailbox.', 'Access to the invoices mailbox.'],
    sections: [{ id: 'mailbox', title: 'Mailbox', titleIt: 'Casella', columns: 2, fields: [
      { key: 'address', type: 'text', label: 'Mailbox address', labelIt: 'Indirizzo della casella', required: true, answer: { samples: ['care@opengrafo-demo.com', 'invoices@opengrafo-demo.com', 'hr-requests@opengrafo-demo.com'] } },
      { key: 'send_as', type: 'boolean', label: 'Send as the mailbox', labelIt: 'Invia come la casella', width: 'half', answer: { yes: 0.4 } },
    ] }] }),
  item({ key: 'badge', name: 'Building Badge', description: 'New or replacement building access badge.', category: 'workplace', priority: 'medium', requiresApproval: false, demand: 4, fulfilHours: 20, fulfilTower: 'Service Desk', local: true,
    details: ['I lost my badge.', 'Badge for a new colleague.'],
    sections: [{ id: 'badge', title: 'Badge', titleIt: 'Badge', columns: 2, fields: [
      SITE,
      { key: 'lost', type: 'boolean', label: 'The old badge was lost', labelIt: 'Il vecchio badge è stato smarrito', width: 'half', answer: { yes: 0.35 } },
      { key: 'areas', type: 'text', label: 'Restricted areas needed', labelIt: 'Aree riservate necessarie', answer: { samples: ['Data centre', 'Server room', 'None', 'Archive'] } },
    ] }] }),
  item({ key: 'guestwifi', name: 'Guest Wi-Fi', description: 'Wi-Fi access for visitors.', category: 'workplace', priority: 'low', requiresApproval: false, demand: 3, fulfilHours: 5, fulfilTower: 'Network Operations', local: true,
    details: ['Customer workshop next week.', 'Auditors on site.'],
    sections: [{ id: 'visit', title: 'Visit', titleIt: 'Visita', columns: 2, fields: [
      { key: 'visitors', type: 'number', label: 'Visitors', labelIt: 'Visitatori', required: true, width: 'half', answer: { min: 1, max: 25 } },
      { key: 'day', type: 'date', label: 'Day', labelIt: 'Giorno', required: true, width: 'half', answer: { daysAhead: [1, 14] } },
      SITE,
    ] }] }),
  item({ key: 'unlock', name: 'Account Unlock', description: 'Unlock your account or reset the password.', category: 'access', priority: 'high', requiresApproval: false, demand: 8, fulfilHours: 2, fulfilTower: 'Service Desk',
    details: ['I am locked out after the holidays.', 'Password expired while travelling.'],
    sections: [{ id: 'account', title: 'Account', titleIt: 'Account', columns: 2, fields: [
      { key: 'username', type: 'text', label: 'Username', labelIt: 'Nome utente', required: true, width: 'half', answer: { samples: ['lbianchi', 'jwalker', 'sromano', 'lweber', 'ecosta'] } },
      { key: 'callback', type: 'text', label: 'Phone number for the call back', labelIt: 'Numero per essere richiamato', required: true, width: 'half', answer: { samples: ['+39 02 5555 0101', '+44 20 5555 0199', '+49 69 5555 0133', '+39 06 5555 0112'] } },
    ] }] }),

  // ── Network ───────────────────────────────────────────────────────────────
  item({ key: 'fwrule', name: 'Firewall Rule', description: 'Open a network flow between two systems.', category: 'network', priority: 'medium', requiresApproval: true, demand: 6, fulfilHours: 28, fulfilTower: 'Network Security',
    details: ['New integration between the portal and the payments API.', 'Monitoring agent needs to reach the collectors.'],
    sections: [
      { id: 'flow', title: 'Flow', titleIt: 'Flusso', columns: 2, fields: [
        { key: 'source', type: 'ref_ci', label: 'Source', labelIt: 'Origine', refTypes: ['server', 'application'], required: true },
        { key: 'destination', type: 'ref_ci', label: 'Destination', labelIt: 'Destinazione', refTypes: ['server', 'database_instance', 'application'], required: true },
        { key: 'protocol', type: 'enum', label: 'Protocol', labelIt: 'Protocollo', vocabulary: 'network_protocol', required: true, width: 'half' },
        { key: 'ports', type: 'text', label: 'Ports', labelIt: 'Porte', required: true, width: 'half', answer: { samples: ['443', '1521', '5432', '8080, 8443', '22'] } },
      ] },
      { id: 'validity', title: 'Validity', titleIt: 'Validità', columns: 2, fields: [
        { key: 'permanent', type: 'boolean', label: 'Permanent rule', labelIt: 'Regola permanente', width: 'half', answer: { yes: 0.6 } },
        { key: 'expires', type: 'date', label: 'Expires on', labelIt: 'Scade il', width: 'half', visibleWhen: { field: 'permanent', op: 'eq', value: 'false' }, answer: { daysAhead: [30, 180] } },
      ] },
    ] }),
  item({ key: 'dns', name: 'DNS Record', description: 'Create or change a DNS record.', category: 'network', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 10, fulfilTower: 'Network Operations',
    details: ['New host name for the application.', 'Alias for the migration.'],
    sections: [{ id: 'record', title: 'Record', titleIt: 'Record', columns: 2, fields: [
      { key: 'record_type', type: 'enum', label: 'Type', labelIt: 'Tipo', vocabulary: 'dns_record_type', required: true, width: 'half' },
      { key: 'host', type: 'text', label: 'Host name', labelIt: 'Nome host', required: true, width: 'half', answer: { samples: ['portal.opengrafo-demo.com', 'api-test.opengrafo-demo.com', 'mail2.opengrafo-demo.com'] } },
      { key: 'value', type: 'text', label: 'Value', labelIt: 'Valore', required: true, answer: { samples: ['10.20.4.15', 'lb-prod-01.opengrafo-demo.com', 'v=spf1 include:mail.example -all'] } },
    ] }] }),
  item({ key: 'lbconfig', name: 'Load Balancer Configuration', description: 'Add or change a virtual service on the load balancers.', category: 'network', priority: 'medium', requiresApproval: true, demand: 2, fulfilHours: 28, fulfilTower: 'Network Operations',
    details: ['New pool member after the scale-out.', 'Health check path changed.'],
    sections: [{ id: 'service', title: 'Virtual service', titleIt: 'Servizio virtuale', fields: [
      { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application'], required: true },
      { key: 'members', type: 'table', label: 'Pool members', labelIt: 'Membri del pool',
        table: [
          { name: 'host', label: 'Host', labelIt: 'Host', type: 'text', required: true },
          { name: 'port', label: 'Port', labelIt: 'Porta', type: 'number', required: true },
        ],
        answer: { samples: ['mil-prd-web', 'fra-prd-web', 'lon-prd-api', 'ams-prd-app'], rows: [2, 4] } },
      { key: 'health_check', type: 'text', label: 'Health check path', labelIt: 'Percorso del controllo di salute', answer: { samples: ['/health', '/status', '/api/ping'] } },
    ] }] }),
  item({ key: 'netport', name: 'Network Port Activation', description: 'Activate a wall port or a switch port.', category: 'workplace', priority: 'low', requiresApproval: false, demand: 3, fulfilHours: 20, fulfilTower: 'Network Operations', local: true,
    details: ['New desk in the meeting area.', 'Printer moved to another room.'],
    sections: [{ id: 'port', title: 'Port', titleIt: 'Porta', columns: 2, fields: [
      SITE,
      { key: 'socket', type: 'text', label: 'Wall socket label', labelIt: 'Etichetta della presa', required: true, width: 'half', answer: { samples: ['3E-114', '2W-031', '5N-220', 'G-008'] } },
      { key: 'vlan', type: 'text', label: 'VLAN (if known)', labelIt: 'VLAN (se nota)', width: 'half', answer: { samples: ['110', '220', '', '305'] } },
    ] }] }),
  item({ key: 's2svpn', name: 'Site-to-Site VPN', description: 'New VPN tunnel with a partner or a new office.', category: 'network', priority: 'high', requiresApproval: true, demand: 1, fulfilHours: 64, fulfilTower: 'Network Security',
    details: ['New logistics partner integration.', 'Temporary office for the project.'],
    sections: [{ id: 'tunnel', title: 'Tunnel', titleIt: 'Tunnel', columns: 2, fields: [
      { key: 'partner', type: 'text', label: 'Partner or site', labelIt: 'Partner o sede', required: true, width: 'half', answer: { samples: ['Northwind Logistics', 'Madrid pop-up office', 'Contoso Payments'] } },
      { key: 'peer_ip', type: 'text', label: 'Peer public IP', labelIt: 'IP pubblico del peer', required: true, width: 'half', answer: { samples: ['203.0.113.10', '198.51.100.44', '192.0.2.77'] } },
      { key: 'networks', type: 'textarea', label: 'Networks to route', labelIt: 'Reti da instradare', required: true, answer: { samples: ['10.50.0.0/16 to 172.16.10.0/24', '10.60.12.0/24 to 192.168.40.0/24'] } },
    ] }] }),
  item({ key: 'secexc', name: 'Security Exception', description: 'Request a temporary exception to a security policy.', category: 'security', priority: 'high', requiresApproval: true, demand: 2, fulfilHours: 48, fulfilTower: 'Security Operations',
    details: ['Legacy system cannot enforce the new password policy.', 'USB storage needed for the lab.'],
    sections: [
      { id: 'exception', title: 'Exception', titleIt: 'Eccezione', fields: [
        { key: 'policy', type: 'text', label: 'Policy', labelIt: 'Policy', required: true, answer: { samples: ['Password complexity', 'USB storage', 'Remote access MFA', 'Encryption at rest'] } },
        { key: 'system', type: 'ref_ci', label: 'System', labelIt: 'Sistema', refTypes: ['application', 'server'], required: true },
        { key: 'until', type: 'date', label: 'Exception until', labelIt: 'Eccezione fino al', required: true, answer: { daysAhead: [30, 180] } },
      ] },
      { id: 'risk', title: 'Risk', titleIt: 'Rischio', fields: [
        { key: 'compensating', type: 'textarea', label: 'Compensating controls', labelIt: 'Controlli compensativi', required: true, answer: { samples: ['Network segregation and monitoring.', 'Access limited to two named users.', 'Weekly review of the logs.'] } },
      ] },
    ] }),
  item({ key: 'tlscert', name: 'TLS Certificate', description: 'Request a new or renewed TLS certificate.', category: 'security', priority: 'medium', requiresApproval: false, demand: 5, fulfilHours: 16, fulfilTower: 'PKI & Certificates',
    details: ['The certificate expires next month.', 'New host name for the application.'],
    sections: [{ id: 'certificate', title: 'Certificate', titleIt: 'Certificato', columns: 2, fields: [
      { key: 'common_name', type: 'text', label: 'Common name', labelIt: 'Nome comune', required: true, answer: { samples: ['portal.opengrafo-demo.com', 'api.opengrafo-demo.com', 'sso.opengrafo-demo.com', 'shop.opengrafo-demo.com'] } },
      { key: 'renewal', type: 'boolean', label: 'Renewal of an existing certificate', labelIt: 'Rinnovo di un certificato esistente', width: 'half', answer: { yes: 0.6 } },
      { key: 'installed_on', type: 'ref_ci', label: 'Installed on', labelIt: 'Installato su', refTypes: ['server', 'application'], required: true },
      { key: 'type', type: 'enum', label: 'Type', labelIt: 'Tipo', vocabulary: 'certificate_type', required: true, width: 'half' },
    ] }] }),
  item({ key: 'pentest', name: 'Penetration Test', description: 'Book a penetration test before a release.', category: 'security', priority: 'medium', requiresApproval: true, demand: 1, fulfilHours: 72, fulfilTower: 'Security Operations',
    details: ['New customer-facing release in October.', 'Annual test required by the regulator.'],
    sections: [{ id: 'scope', title: 'Scope', titleIt: 'Perimetro', fields: [
      { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application'], required: true },
      { key: 'window_start', type: 'date', label: 'Test window start', labelIt: 'Inizio della finestra di test', required: true, answer: { daysAhead: [14, 60] } },
      { key: 'external', type: 'boolean', label: 'Internet-facing', labelIt: 'Esposta su Internet', answer: { yes: 0.6 } },
    ] }] }),
  item({ key: 'dataexport', name: 'Data Export Approval', description: 'Approval to export data outside the company.', category: 'security', priority: 'medium', requiresApproval: true, demand: 2, fulfilHours: 36, fulfilTower: 'Security Operations',
    details: ['Data for the external auditor.', 'Dataset for the analytics partner.'],
    sections: [{ id: 'export', title: 'Export', titleIt: 'Esportazione', columns: 2, fields: [
      { key: 'classification', type: 'enum', label: 'Data classification', labelIt: 'Classificazione dei dati', vocabulary: 'data_classification', required: true, width: 'half' },
      { key: 'recipient', type: 'text', label: 'Recipient', labelIt: 'Destinatario', required: true, width: 'half', answer: { samples: ['External auditor', 'Analytics partner', 'Regulator'] } },
      { key: 'records', type: 'number', label: 'Approximate records', labelIt: 'Record approssimativi', width: 'half', answer: { min: 100, max: 500000 } },
      { key: 'anonymised', type: 'boolean', label: 'Anonymised', labelIt: 'Anonimizzati', width: 'half', answer: { yes: 0.65 } },
    ] }] }),
  item({ key: 'phishing', name: 'Suspicious E-mail Review', description: 'Ask Security to review a suspicious e-mail.', category: 'security', priority: 'high', requiresApproval: false, demand: 5, fulfilHours: 4, fulfilTower: 'Security Operations',
    details: ['I received a strange invoice.', 'Someone asked for my password by e-mail.'],
    sections: [{ id: 'email', title: 'E-mail', titleIt: 'E-mail', fields: [
      { key: 'sender', type: 'text', label: 'Sender', labelIt: 'Mittente', required: true, answer: { samples: ['billing@invoice-update.example', 'it-support@secure-login.example', 'ceo.office@mail.example'] } },
      { key: 'clicked', type: 'boolean', label: 'I clicked a link or opened an attachment', labelIt: 'Ho cliccato un link o aperto un allegato', answer: { yes: 0.2 } },
      { key: 'received_at', type: 'datetime', label: 'Received at', labelIt: 'Ricevuta il', answer: { daysAhead: [-2, 0] } },
    ] }] }),
  item({ key: 'enckey', name: 'Encryption Key', description: 'Request a key from the key management service.', category: 'security', priority: 'medium', requiresApproval: true, demand: 1, fulfilHours: 20, fulfilTower: 'PKI & Certificates',
    details: ['Key for the new data store.', 'Key rotation for the payments service.'],
    sections: [{ id: 'key', title: 'Key', titleIt: 'Chiave', columns: 2, fields: [
      { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application'], required: true },
      { key: 'rotation_days', type: 'number', label: 'Rotation period (days)', labelIt: 'Periodo di rotazione (giorni)', width: 'half', answer: { min: 30, max: 365 } },
    ] }] }),

  // ── People, workplace, infrastructure and the rest (D28: they were all «Other») ──
  item({ key: 'onboard', name: 'Employee Onboarding', description: 'Everything a new employee needs on day one.', category: 'people', priority: 'high', requiresApproval: true, demand: 6, fulfilHours: 48, fulfilTower: 'Service Desk', local: true,
    details: ['New analyst joining Finance.', 'Two developers starting next week.'],
    sections: [
      { id: 'employee', title: 'Employee', titleIt: 'Dipendente', columns: 2, fields: [
        fullName(['Marco Ferrari', 'Anna Schmidt', 'Carlos García', 'Emma Johnson', 'Giulia Greco']),
        { key: 'start_date', type: 'date', label: 'Start date', labelIt: 'Data di inizio', required: true, width: 'half', answer: { daysAhead: [5, 30] } },
        { key: 'department', type: 'enum', label: 'Department', labelIt: 'Reparto', vocabulary: 'department', required: true, width: 'half' },
        SITE,
      ] },
      { id: 'equipment', title: 'Equipment', titleIt: 'Dotazione', columns: 2, fields: [
        { key: 'laptop', type: 'enum', label: 'Laptop', labelIt: 'Portatile', vocabulary: 'laptop_model', width: 'half' },
        { key: 'phone', type: 'boolean', label: 'Company phone', labelIt: 'Telefono aziendale', width: 'half', answer: { yes: 0.4 } },
        { key: 'buddy', type: 'ref_user', label: 'Onboarding buddy', labelIt: 'Tutor', agentOnly: true },
      ] },
    ] }),
  item({ key: 'offboard', name: 'Employee Offboarding', description: 'Close accounts and collect equipment of a leaver.', category: 'people', priority: 'high', requiresApproval: false, demand: 4, fulfilHours: 36, fulfilTower: 'Identity & Access',
    details: ['Colleague leaving at the end of the month.', 'Contract ending on Friday.'],
    sections: [{ id: 'leaver', title: 'Leaver', titleIt: 'Uscita', columns: 2, fields: [
      fullName(['Paolo Ricci', 'Sarah Miller', 'Jonas Nielsen', 'Chiara Conti']),
      { key: 'last_day', type: 'date', label: 'Last working day', labelIt: 'Ultimo giorno di lavoro', required: true, width: 'half', answer: { daysAhead: [3, 30] } },
      { key: 'mail_forward', type: 'boolean', label: 'Forward e-mail to the manager', labelIt: 'Inoltra la posta al responsabile', width: 'half', answer: { yes: 0.7 } },
    ] }] }),
  item({ key: 'deskmove', name: 'Desk Move', description: 'Move your desk and equipment to another location.', category: 'workplace', priority: 'low', requiresApproval: false, demand: 3, fulfilHours: 36, fulfilTower: 'End User Computing', local: true,
    details: ['Team moving to the fourth floor.', 'I moved to another office.'],
    sections: [{ id: 'move', title: 'Move', titleIt: 'Trasloco', columns: 2, fields: [
      { key: 'from_site', type: 'enum', label: 'From', labelIt: 'Da', vocabulary: 'office_site', required: true, width: 'half' },
      { key: 'to_site', type: 'enum', label: 'To', labelIt: 'A', vocabulary: 'office_site', required: true, width: 'half' },
      { key: 'move_date', type: 'date', label: 'Move date', labelIt: 'Data del trasloco', required: true, width: 'half', answer: { daysAhead: [5, 40] } },
      { key: 'items', type: 'number', label: 'Items to move', labelIt: 'Oggetti da spostare', width: 'half', answer: { min: 1, max: 8 } },
    ] }] }),
  item({ key: 'meeting', name: 'Meeting Room Setup', description: 'Audio-video setup for a meeting or an event.', category: 'workplace', priority: 'low', requiresApproval: false, demand: 4, fulfilHours: 20, fulfilTower: 'End User Computing', local: true,
    details: ['Board meeting with remote participants.', 'Town hall broadcast.'],
    sections: [{ id: 'event', title: 'Event', titleIt: 'Evento', columns: 2, fields: [
      { key: 'room_size', type: 'enum', label: 'Room size', labelIt: 'Dimensione della sala', vocabulary: 'meeting_room_size', required: true, width: 'half' },
      { key: 'starts_at', type: 'datetime', label: 'Starts at', labelIt: 'Inizia il', required: true, width: 'half', answer: { daysAhead: [1, 20] } },
      { key: 'remote', type: 'boolean', label: 'Remote participants', labelIt: 'Partecipanti da remoto', width: 'half', answer: { yes: 0.7 } },
      { key: 'recording', type: 'boolean', label: 'Recording', labelIt: 'Registrazione', width: 'half', answer: { yes: 0.3 } },
    ] }] }),
  item({ key: 'training', name: 'Training Enrolment', description: 'Enrol in an internal training course.', category: 'people', priority: 'low', requiresApproval: true, demand: 5, fulfilHours: 36, fulfilTower: 'Service Desk',
    details: ['Required by my development plan.', 'New to the role.'],
    sections: [{ id: 'course', title: 'Course', titleIt: 'Corso', columns: 2, fields: [
      { key: 'course', type: 'enum', label: 'Course', labelIt: 'Corso', vocabulary: 'training_course', required: true, width: 'half' },
      { key: 'preferred_date', type: 'date', label: 'Preferred date', labelIt: 'Data preferita', width: 'half', answer: { daysAhead: [10, 90] } },
      { key: 'remote', type: 'boolean', label: 'Remote session', labelIt: 'Sessione da remoto', width: 'half', answer: { yes: 0.5 } },
    ] }] }),
  item({ key: 'cloudvm', name: 'Cloud Virtual Machine', description: 'Provision a virtual machine in the cloud.', category: 'infrastructure', priority: 'medium', requiresApproval: true, demand: 4, fulfilHours: 20, fulfilTower: 'Cloud Operations',
    details: ['Batch processing for the month-end.', 'Test machine for the vendor.'],
    sections: [
      { id: 'vm', title: 'Virtual machine', titleIt: 'Macchina virtuale', columns: 2, fields: [
        { key: 'region', type: 'enum', label: 'Region', labelIt: 'Regione', vocabulary: 'cloud_region', required: true, width: 'half' },
        size(['Small (2 vCPU, 8 GB)', 'Medium (4 vCPU, 16 GB)', 'Large (8 vCPU, 32 GB)', 'X-Large (16 vCPU, 64 GB)']),
        { key: 'os', type: 'enum', label: 'Operating system', labelIt: 'Sistema operativo', vocabulary: 'os', required: true, width: 'half' },
        { key: 'environment', type: 'enum', label: 'Environment', labelIt: 'Ambiente', vocabulary: 'environment', required: true, width: 'half' },
      ] },
      { id: 'cost', title: 'Cost', titleIt: 'Costo', columns: 2, fields: [
        { key: 'cost_center', type: 'text', label: 'Cost center', labelIt: 'Centro di costo', required: true, width: 'half', answer: { samples: ['CC-410', 'CC-512', 'CC-633'] } },
        { key: 'temporary', type: 'boolean', label: 'Temporary', labelIt: 'Temporanea', width: 'half', answer: { yes: 0.4 } },
        { key: 'decommission_on', type: 'date', label: 'Decommission on', labelIt: 'Da dismettere il', visibleWhen: { field: 'temporary', op: 'eq', value: 'true' }, answer: { daysAhead: [30, 120] } },
      ] },
    ] }),
  item({ key: 'dbprov', name: 'Database Provisioning', description: 'Create a new database on a managed instance.', category: 'infrastructure', priority: 'medium', requiresApproval: true, demand: 3, fulfilHours: 28, fulfilTower: 'Data Platform',
    details: ['Database for the new microservice.', 'Reporting database for the dashboard.'],
    sections: [{ id: 'database', title: 'Database', titleIt: 'Database', columns: 2, fields: [
      { key: 'engine', type: 'enum', label: 'Engine', labelIt: 'Motore', vocabulary: 'instance_type', required: true, width: 'half' },
      { key: 'environment', type: 'enum', label: 'Environment', labelIt: 'Ambiente', vocabulary: 'environment', required: true, width: 'half' },
      { key: 'application', type: 'ref_ci', label: 'Application', labelIt: 'Applicazione', refTypes: ['application'], required: true },
      { key: 'size_gb', type: 'number', label: 'Initial size (GB)', labelIt: 'Dimensione iniziale (GB)', width: 'half', answer: { min: 5, max: 500 } },
    ] }] }),
  item({ key: 'backup', name: 'Restore from Backup', description: 'Restore files or a database from a backup.', category: 'infrastructure', priority: 'high', requiresApproval: false, demand: 3, fulfilHours: 8, fulfilTower: 'Storage & Backup',
    details: ['I deleted a folder by mistake.', 'We need yesterday\'s data for the investigation.'],
    sections: [{ id: 'restore', title: 'Restore', titleIt: 'Ripristino', columns: 2, fields: [
      { key: 'what', type: 'text', label: 'What to restore', labelIt: 'Cosa ripristinare', required: true, answer: { samples: ['\\\\fs01\\finance\\2026', 'orders_core database', 'Mailbox of a leaver', '\\\\fs02\\projects\\apollo\\design'] } },
      { key: 'point_in_time', type: 'datetime', label: 'Point in time', labelIt: 'Momento del ripristino', required: true, width: 'half', answer: { daysAhead: [-7, -1] } },
      { key: 'overwrite', type: 'boolean', label: 'Overwrite the current copy', labelIt: 'Sovrascrivi la copia attuale', width: 'half', answer: { yes: 0.3 } },
    ] }] }),
  item({ key: 'storage', name: 'Storage Increase', description: 'More disk space for a server or a share.', category: 'infrastructure', priority: 'medium', requiresApproval: true, demand: 3, fulfilHours: 14, fulfilTower: 'Storage & Backup',
    details: ['Disk at 90% on the batch server.', 'Share is almost full.'],
    sections: [{ id: 'storage', title: 'Storage', titleIt: 'Spazio', columns: 2, fields: [
      { key: 'server', type: 'ref_ci', label: 'Server', labelIt: 'Server', refTypes: ['server'], required: true },
      { key: 'extra_gb', type: 'number', label: 'Additional space (GB)', labelIt: 'Spazio aggiuntivo (GB)', required: true, width: 'half', answer: { min: 20, max: 2000 } },
      { key: 'reason', type: 'textarea', label: 'Reason', labelIt: 'Motivo', answer: { samples: ['Growth of the order history.', 'New archive retention.', 'Log volume increased.'] } },
    ] }] }),
  item({ key: 'monitoring', name: 'Monitoring Onboarding', description: 'Add a CI to monitoring and alerting.', category: 'infrastructure', priority: 'low', requiresApproval: false, demand: 2, fulfilHours: 14, fulfilTower: 'Monitoring & Observability',
    details: ['New server in production.', 'Application went live last week.'],
    sections: [{ id: 'target', title: 'Target', titleIt: 'Oggetto', columns: 2, fields: [
      { key: 'ci', type: 'ref_ci', label: 'CI', labelIt: 'CI', refTypes: ['server', 'application', 'database_instance'], required: true },
      { key: 'pager', type: 'boolean', label: 'Page the on-call engineer', labelIt: 'Avvisa il reperibile', width: 'half', answer: { yes: 0.5 } },
    ] }] }),
  item({ key: 'report', name: 'New Report', description: 'Request a new business report or dashboard.', category: 'other', priority: 'low', requiresApproval: true, demand: 3, fulfilHours: 64, fulfilTower: 'Data Platform',
    details: ['Monthly sales by region.', 'Weekly SLA report for the steering committee.'],
    sections: [{ id: 'report', title: 'Report', titleIt: 'Report', fields: [
      { key: 'title', type: 'text', label: 'Report title', labelIt: 'Titolo del report', required: true, answer: { samples: ['Monthly sales by region', 'Weekly SLA compliance', 'Stock rotation', 'Open orders ageing'] } },
      { key: 'frequency', type: 'text', label: 'Frequency', labelIt: 'Frequenza', answer: { samples: ['Daily', 'Weekly', 'Monthly'] } },
      { key: 'audience', type: 'textarea', label: 'Who reads it and why', labelIt: 'Chi lo legge e perché', answer: { samples: ['Regional sales managers, to plan the month.', 'Steering committee, to follow the service levels.'] } },
    ] }] }),
  item({ key: 'procurement', name: 'IT Purchase', description: 'Buy IT goods or services not in the catalog.', category: 'other', priority: 'medium', requiresApproval: true, demand: 3, fulfilHours: 64, fulfilTower: 'Service Desk',
    details: ['Specialised scanner for the lab.', 'Consulting days for the migration.'],
    sections: [{ id: 'purchase', title: 'Purchase', titleIt: 'Acquisto', fields: [
      { key: 'lines', type: 'table', label: 'Items', labelIt: 'Voci', required: true,
        table: [
          { name: 'description', label: 'Description', labelIt: 'Descrizione', type: 'text', required: true },
          { name: 'quantity', label: 'Quantity', labelIt: 'Quantità', type: 'number', required: true },
          { name: 'unit_price', label: 'Unit price (EUR)', labelIt: 'Prezzo unitario (EUR)', type: 'number' },
        ],
        answer: { samples: ['Barcode scanner', 'Consulting day', 'Rack shelf', 'Label printer', 'Extended warranty'], rows: [1, 4] } },
      { key: 'cost_center', type: 'text', label: 'Cost center', labelIt: 'Centro di costo', required: true, answer: { samples: ['CC-410', 'CC-220', 'CC-705'] } },
    ] }] }),
  item({ key: 'apikey', name: 'API Access for a Partner', description: 'Grant a partner access to one of our APIs.', category: 'access', priority: 'medium', requiresApproval: true, demand: 1, fulfilHours: 36, fulfilTower: 'API Management',
    details: ['New reseller integration.', 'Logistics partner tracking updates.'],
    sections: [{ id: 'api', title: 'API', titleIt: 'API', columns: 2, fields: [
      { key: 'application', type: 'ref_ci', label: 'API application', labelIt: 'Applicazione API', refTypes: ['application'], required: true },
      { key: 'partner', type: 'text', label: 'Partner', labelIt: 'Partner', required: true, width: 'half', answer: { samples: ['Northwind Logistics', 'Contoso Retail', 'Fabrikam Payments'] } },
      { key: 'rate_limit', type: 'number', label: 'Requests per minute', labelIt: 'Richieste al minuto', width: 'half', answer: { min: 60, max: 3000 } },
    ] }] }),
  item({ key: 'sapaccess', name: 'ERP Transaction Access', description: 'Access to transactions of the ERP system.', category: 'access', priority: 'medium', requiresApproval: true, demand: 4, fulfilHours: 16, fulfilTower: 'SAP Basis',
    details: ['I took over the supplier invoices.', 'Month-end closing tasks.'],
    sections: [{ id: 'erp', title: 'ERP', titleIt: 'ERP', columns: 2, fields: [
      { key: 'transactions', type: 'textarea', label: 'Transactions', labelIt: 'Transazioni', required: true, answer: { samples: ['Supplier invoice posting', 'Vendor master display', 'Purchase order approval', 'Goods receipt'] } },
      { key: 'company_code', type: 'text', label: 'Company code', labelIt: 'Codice società', required: true, width: 'half', answer: { samples: ['IT01', 'DE02', 'FR01', 'ES01'] } },
      { key: 'until', type: 'date', label: 'Needed until', labelIt: 'Serve fino al', width: 'half', answer: { daysAhead: [30, 365] } },
    ] }] }),
]
