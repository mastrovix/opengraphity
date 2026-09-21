/**
 * I NOMI DEI TEAM PER I DATI DI TEST (17 set 2026).
 *
 * Perché scritti a mano e non generati: `c-one` ha 70 team chiamati `TEA-001`,
 * `TEA-002`, `TEA-003`, ed è il modo più rapido di rendere una demo
 * inguardabile — e anche di nascondere i difetti veri, perché con quei nomi
 * nessuna colonna è troppo stretta, nessun ordinamento è sbagliato e nessun
 * filtro sembra inutile. Un nome vero («Network Operations», «SAP Basis»)
 * mette sotto sforzo l'interfaccia come farebbe un cliente.
 *
 * Sono nomi di UNITÀ ORGANIZZATIVE, come si trovano nell'IT di un'azienda
 * grande: per area tecnologica, per applicazione, per servizio. Nessun numero
 * progressivo, nessuna ripetizione.
 *
 * INGLESE, come la lingua del prodotto: un cliente italiano rinomina quello
 * che gli serve, ma un nome inglese in un'interfaccia italiana si legge —
 * mentre l'inverso, in una demo in inglese, no.
 *
 * Tutti `internal` e tutti di tipo `owner`, per scelta del proprietario.
 */

/**
 * IL PREFISSO, scelto dal proprietario: ogni team di esercizio si riconosce a
 * occhio da `OWN_`. Sta qui e non dentro i nomi perché si applica in un posto
 * solo — e un test può pretendere che nessun team seminato ne sia senza.
 */
export const TEST_TEAM_PREFIX = 'OWN_'

/** I team di ESERCIZIO, in ordine di area, SENZA prefisso: lo mette chi scrive. */
export const TEST_TEAM_NAMES: readonly string[] = [
  // ── Infrastructure & platform ──────────────────────────────────────────────
  'Network Operations',
  'Network Engineering',
  'Datacenter Operations',
  'Datacenter Facilities',
  'Storage & Backup',
  'Virtualization Platform',
  'Linux Systems',
  'Windows Server Team',
  'Mainframe Operations',
  'AS/400 Systems',
  'Middleware Platform',
  'Message Broker Team',
  'Container Platform',
  'Kubernetes Platform',
  'High Performance Computing',
  'Print & Output Management',
  'Capacity Planning',
  'Infrastructure Monitoring',
  'Configuration Management',
  'Patch Management',
  'Hardware Maintenance',
  'Server Provisioning',
  'Load Balancing & ADC',
  'DNS & IPAM',
  'Time & Certificate Services',

  // ── Network & connectivity ─────────────────────────────────────────────────
  'WAN & Branch Connectivity',
  'LAN & Campus Network',
  'Wireless Network',
  'Firewall Operations',
  'VPN & Remote Access',
  'SD-WAN Team',
  'Network Capacity & Traffic',
  'Voice & Telephony',
  'Contact Center Technology',
  'Video Conferencing',
  'Mobile Connectivity',
  'Satellite & Remote Sites',

  // ── Database ───────────────────────────────────────────────────────────────
  'Database Administration',
  'Oracle Database Team',
  'SQL Server Team',
  'PostgreSQL Team',
  'MySQL & MariaDB Team',
  'MongoDB Team',
  'Data Replication & HA',
  'Database Performance',
  'Data Archiving',
  'Backup & Restore Services',

  // ── Applications & ERP ─────────────────────────────────────────────────────
  'SAP Basis',
  'SAP FI/CO Support',
  'SAP MM & Procurement',
  'SAP SD & Sales',
  'SAP HR Support',
  'Salesforce Platform',
  'CRM Application Support',
  'Billing Applications',
  'Payroll Systems',
  'Treasury & Payments Systems',
  'Document Management',
  'Workflow & BPM Platform',
  'Legacy Applications',
  'Integration & API Team',
  'EDI & B2B Integration',
  'Warehouse Management Systems',
  'Manufacturing Execution Systems',
  'Transport Management Systems',
  'Point of Sale Systems',
  'Reservation Systems',

  // ── Digital & web ──────────────────────────────────────────────────────────
  'E-commerce Platform',
  'Corporate Website',
  'Customer Portal',
  'Mobile Apps Team',
  'Content Management Platform',
  'Search & Recommendations',
  'Payment Gateway Team',
  'Digital Marketing Technology',
  'Accessibility & Frontend Standards',
  'Web Performance',

  // ── Security ───────────────────────────────────────────────────────────────
  'Security Operations Center',
  'Incident Response Team',
  'Threat Intelligence',
  'Vulnerability Management',
  'Identity & Access Management',
  'Privileged Access Management',
  'Endpoint Security',
  'Email Security',
  'Cloud Security',
  'Application Security',
  'Cryptography & Key Management',
  'Data Loss Prevention',
  'Security Architecture',
  'Compliance & Audit Support',

  // ── Data & analytics ───────────────────────────────────────────────────────
  'Data Platform Engineering',
  'Data Warehouse Team',
  'Business Intelligence',
  'Reporting Factory',
  'Data Governance',
  'Master Data Management',
  'Machine Learning Engineering',
  'Data Quality',
  'Streaming & Real Time Data',
  'Analytics Enablement',

  // ── End user & workplace ───────────────────────────────────────────────────
  'Service Desk',
  'Service Desk — Second Level',
  'Field Services North',
  'Field Services South',
  'Workplace Engineering',
  'Device Provisioning',
  'Mobile Device Management',
  'Collaboration Services',
  'Microsoft 365 Team',
  'Google Workspace Team',
  'Remote Desktop Services',
  'Accessibility Support',

  // ── Service management & operations ────────────────────────────────────────
  'Change Advisory Board',
  'Change Management Office',
  'Problem Management',
  'Release Management',
  'Service Level Management',
  'Major Incident Management',
  'Knowledge Management',
  'Asset & License Management',
  'Procurement & Vendor Management',
  'IT Financial Management',
  'Business Continuity',
  'Disaster Recovery',

  // ── Cloud & DevOps ─────────────────────────────────────────────────────────
  'Cloud Platform Team',
  'AWS Operations',
  'Azure Operations',
  'Google Cloud Operations',
  'Private Cloud Team',
  'FinOps Team',
  'CI/CD Platform',
  'Site Reliability Engineering',
  'Observability Platform',
  'Infrastructure as Code',
  'Developer Experience',
  'Release Engineering',

  // ── Industrial, facilities & specialised ───────────────────────────────────
  'Industrial Control Systems',
  'OT Security',
  'Plant Network Operations',
  'Building Management Systems',
  'Physical Security Systems',
  'Energy & Cooling',
  'Laboratory Systems',
  'Clinical Systems Support',
  'Retail Store Systems',
  'Logistics Technology',
  'Fleet Telematics',
  'Environmental Monitoring',

  // ── Specialistici ──────────────────────────────────────────────────────────
  'Firmware & BIOS Management',
]
