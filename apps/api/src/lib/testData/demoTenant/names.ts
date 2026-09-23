/**
 * THE WORDS THE DEMO TENANT IS MADE OF (23 Sep 2026).
 *
 * Real-looking names, in English like the product (`teamNames.ts` explains
 * why: a demo where teams are called `TEA-001` hides every defect a real
 * customer would find). Nothing here is random: these are the pools, and the
 * generator draws from them with the seed. A pool is sized for the default
 * counts with room to spare; a name builder that runs out says so instead of
 * repeating a name, because two CIs with the same name are a defect in a demo.
 */

/**
 * PEOPLE HAVE A COUNTRY (tour of 23 Sep 2026, D22 and D69).
 *
 * First and last names were drawn from one mixed pool, so the Service Desk
 * Italy was staffed by «Adrian Kumar», «Agnese Anderson» and «Matteo
 * Lefebvre», and the user list sorted by name showed thirty «Adrian» in a
 * row. Now each country has its own pools — a first name and a last name of
 * the same country — and a person gets the country of the team they work in
 * (people.ts). The pools are large enough that no first name owns a page of
 * the list.
 */
export type Country = 'IT' | 'DE' | 'FR' | 'ES' | 'GB' | 'NL' | 'NORDIC' | 'US' | 'IN' | 'SG' | 'JP' | 'AU'

export const NAME_POOLS: Readonly<Record<Country, { first: readonly string[]; last: readonly string[] }>> = {
  IT: {
    first: [
      'Alessandro', 'Andrea', 'Antonio', 'Davide', 'Federico', 'Francesco', 'Gabriele', 'Giacomo', 'Giovanni', 'Giuseppe',
      'Lorenzo', 'Luca', 'Marco', 'Matteo', 'Michele', 'Nicola', 'Paolo', 'Pietro', 'Riccardo', 'Roberto',
      'Simone', 'Stefano', 'Tommaso', 'Valerio', 'Vincenzo', 'Emanuele', 'Filippo', 'Jacopo', 'Mattia', 'Edoardo',
      'Alessia', 'Alice', 'Anna', 'Beatrice', 'Camilla', 'Chiara', 'Elena', 'Elisa', 'Federica', 'Francesca',
      'Giorgia', 'Giulia', 'Ilaria', 'Laura', 'Lucia', 'Marta', 'Martina', 'Monica', 'Paola', 'Roberta',
      'Sara', 'Silvia', 'Sofia', 'Valentina', 'Veronica', 'Agnese', 'Bianca', 'Irene', 'Michela', 'Serena',
      'Alberto', 'Carlo', 'Claudio', 'Cristian', 'Daniele', 'Dario', 'Enrico', 'Fabio', 'Fabrizio', 'Gianluca',
      'Giorgio', 'Leonardo', 'Manuel', 'Massimo', 'Maurizio', 'Mauro', 'Nicolò', 'Salvatore', 'Sergio', 'Umberto',
      'Angela', 'Antonella', 'Arianna', 'Barbara', 'Benedetta', 'Carlotta', 'Caterina', 'Claudia', 'Cristina', 'Daniela',
      'Emma', 'Erica', 'Gaia', 'Greta', 'Letizia', 'Ludovica', 'Margherita', 'Noemi', 'Rebecca', 'Rita',
    ],
    last: [
      'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco',
      'Bruno', 'Gallo', 'Conti', 'De Luca', 'Mancini', 'Costa', 'Giordano', 'Rizzo', 'Lombardi', 'Moretti',
      'Barbieri', 'Fontana', 'Santoro', 'Mariani', 'Rinaldi', 'Caruso', 'Ferrara', 'Galli', 'Martini', 'Leone',
      'Longo', 'Gentile', 'Martinelli', 'Vitale', 'Lombardo', 'Serra', 'Coppola', 'De Santis', "D'Angelo", 'Marchetti',
      'Parisi', 'Villa', 'Conte', 'Ferri', 'Fabbri', 'Bianco', 'Marini', 'Grasso', 'Valentini', 'Messina',
      'Sala', 'De Angelis', 'Gatti', 'Pellegrini', 'Palumbo', 'Sanna', 'Farina', 'Rizzi', 'Monti', 'Cattaneo',
    ],
  },
  DE: {
    first: [
      'Alexander', 'Andreas', 'Christian', 'Daniel', 'Florian', 'Jan', 'Jonas', 'Julian', 'Lukas', 'Markus',
      'Martin', 'Matthias', 'Maximilian', 'Michael', 'Niklas', 'Philipp', 'Sebastian', 'Stefan', 'Tobias', 'Felix',
      'Anja', 'Anna', 'Carolin', 'Christina', 'Julia', 'Katharina', 'Laura', 'Lea', 'Lena', 'Lisa',
      'Maria', 'Nina', 'Sabine', 'Sandra', 'Sarah', 'Sophie', 'Stefanie', 'Susanne', 'Svenja', 'Johanna',
    ],
    last: [
      'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
      'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann',
      'Braun', 'Krüger', 'Hofmann', 'Hartmann', 'Lange', 'Schmitt', 'Werner', 'Schmitz', 'Krause', 'Meier',
      'Lehmann', 'Schmid', 'Schulze', 'Maier', 'Köhler', 'Herrmann', 'König', 'Walter', 'Mayer', 'Huber',
    ],
  },
  FR: {
    first: [
      'Antoine', 'Arnaud', 'Baptiste', 'Benoît', 'Clément', 'Damien', 'Étienne', 'Guillaume', 'Hugo', 'Julien',
      'Laurent', 'Louis', 'Mathieu', 'Maxime', 'Nicolas', 'Olivier', 'Pierre', 'Romain', 'Thibault', 'Vincent',
      'Amélie', 'Aurélie', 'Camille', 'Chloé', 'Claire', 'Élodie', 'Émilie', 'Isabelle', 'Julie', 'Juliette',
      'Laure', 'Léa', 'Manon', 'Marie', 'Mathilde', 'Nathalie', 'Pauline', 'Sophie', 'Valérie', 'Céline',
    ],
    last: [
      'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau',
      'Simon', 'Laurent', 'Lefebvre', 'Michel', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Morel',
      'Girard', 'André', 'Mercier', 'Dupont', 'Lambert', 'Bonnet', 'François', 'Legrand', 'Garnier', 'Faure',
      'Rousseau', 'Blanc', 'Guérin', 'Henry', 'Roussel', 'Chevalier', 'Perrin', 'Morin', 'Masson', 'Marchand',
    ],
  },
  ES: {
    first: [
      'Alejandro', 'Álvaro', 'Antonio', 'Carlos', 'Daniel', 'David', 'Diego', 'Enrique', 'Fernando', 'Francisco',
      'Javier', 'Jorge', 'José', 'Juan', 'Luis', 'Manuel', 'Miguel', 'Pablo', 'Raúl', 'Sergio',
      'Alba', 'Ana', 'Beatriz', 'Carmen', 'Cristina', 'Elena', 'Isabel', 'Laura', 'Lucía', 'María',
      'Marta', 'Nuria', 'Paula', 'Pilar', 'Raquel', 'Rocío', 'Rosa', 'Sara', 'Silvia', 'Teresa',
    ],
    last: [
      'García', 'Fernández', 'González', 'Rodríguez', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Martín',
      'Jiménez', 'Ruiz', 'Hernández', 'Díaz', 'Moreno', 'Muñoz', 'Álvarez', 'Romero', 'Alonso', 'Gutiérrez',
      'Navarro', 'Torres', 'Domínguez', 'Vázquez', 'Ramos', 'Gil', 'Ramírez', 'Serrano', 'Blanco', 'Molina',
      'Morales', 'Suárez', 'Ortega', 'Delgado', 'Castro', 'Ortiz', 'Rubio', 'Marín', 'Sanz', 'Iglesias',
    ],
  },
  GB: {
    first: [
      'Adam', 'Alexander', 'Andrew', 'Benjamin', 'Charlie', 'Daniel', 'David', 'Edward', 'George', 'Harry',
      'Jack', 'James', 'Joseph', 'Matthew', 'Oliver', 'Oscar', 'Richard', 'Samuel', 'Thomas', 'William',
      'Amelia', 'Charlotte', 'Chloe', 'Eleanor', 'Emily', 'Emma', 'Grace', 'Hannah', 'Isabella', 'Jessica',
      'Katie', 'Lucy', 'Megan', 'Olivia', 'Rachel', 'Rebecca', 'Sophie', 'Victoria', 'Zoe', 'Abigail',
    ],
    last: [
      'Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Robinson', 'Wright',
      'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Wood', 'Jackson', 'Clarke',
      'Hughes', 'Edwards', 'Turner', 'Hill', 'Cooper', 'Ward', 'Morris', 'Harris', 'Lewis', 'King',
      'Baker', 'Harrison', 'Morgan', 'Murphy', "O'Brien", 'Kelly', 'Walsh', 'Byrne', 'Campbell', 'Stewart',
    ],
  },
  NL: {
    first: [
      'Bas', 'Bram', 'Daan', 'Dirk', 'Jeroen', 'Joost', 'Koen', 'Lars', 'Maarten', 'Niels',
      'Pieter', 'Ruben', 'Sander', 'Stijn', 'Thijs', 'Wouter', 'Arne', 'Jens', 'Kobe', 'Wim',
      'Anouk', 'Eline', 'Femke', 'Fleur', 'Ilse', 'Iris', 'Lieke', 'Lotte', 'Marieke', 'Nienke',
      'Sanne', 'Els', 'Ellen', 'Inge', 'Hanne',
    ],
    last: [
      'de Jong', 'Jansen', 'de Vries', 'van den Berg', 'van Dijk', 'Bakker', 'Janssen', 'Visser', 'Smit', 'Meijer',
      'de Boer', 'Mulder', 'de Groot', 'Bos', 'Vos', 'Peters', 'Hendriks', 'van Leeuwen', 'Dekker', 'Brouwer',
      'de Wit', 'Dijkstra', 'Smits', 'de Graaf', 'van der Meer', 'Peeters', 'Maes', 'Jacobs', 'Mertens', 'Willems',
      'Claes', 'Goossens', 'Wouters', 'De Smet', 'Vermeulen',
    ],
  },
  NORDIC: {
    first: [
      'Anders', 'Erik', 'Fredrik', 'Gustav', 'Henrik', 'Johan', 'Karl', 'Magnus', 'Mikael', 'Oskar',
      'Per', 'Rasmus', 'Sven', 'Mads', 'Jesper', 'Mikko', 'Juha', 'Bjørn', 'Ole', 'Nils',
      'Astrid', 'Elin', 'Freja', 'Ida', 'Ingrid', 'Karin', 'Linnea', 'Maja', 'Signe', 'Aino',
      'Kaisa', 'Liv', 'Sigrid', 'Hanna', 'Ebba',
    ],
    last: [
      'Andersson', 'Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson', 'Olsson', 'Persson', 'Svensson', 'Gustafsson',
      'Pettersson', 'Jonsson', 'Lindberg', 'Lindqvist', 'Berg', 'Nielsen', 'Jensen', 'Hansen', 'Pedersen', 'Andersen',
      'Christensen', 'Larsen', 'Sørensen', 'Rasmussen', 'Olsen', 'Johansen', 'Haugen', 'Solberg', 'Korhonen', 'Virtanen',
      'Mäkinen', 'Nieminen', 'Lehtonen', 'Halvorsen', 'Dahl',
    ],
  },
  US: {
    first: [
      'Michael', 'Christopher', 'Matthew', 'Joshua', 'Ryan', 'Brandon', 'Tyler', 'Justin', 'Kevin', 'Jason',
      'Brian', 'Eric', 'Nathan', 'Aaron', 'Carlos', 'Miguel', 'Luis', 'Rafael', 'Mateo', 'Gabriel',
      'Jennifer', 'Ashley', 'Amanda', 'Sarah', 'Stephanie', 'Nicole', 'Megan', 'Lauren', 'Samantha', 'Brittany',
      'Kimberly', 'Madison', 'Ana', 'Gabriela', 'Camila', 'Fernanda', 'Juliana', 'Taylor', 'Morgan', 'Alexis',
    ],
    last: [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia', 'Rodriguez', 'Wilson',
      'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Hernandez', 'Moore', 'Jackson', 'Thompson', 'White', 'Lopez',
      'Lee', 'Gonzalez', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Perez', 'Young', 'Allen',
      'Sanchez', 'Wright', 'Scott', 'Nguyen', 'Silva', 'Santos', 'Oliveira', 'Souza', 'Carter', 'Mitchell',
    ],
  },
  IN: {
    first: [
      'Aarav', 'Aditya', 'Amit', 'Anil', 'Arjun', 'Deepak', 'Karthik', 'Manish', 'Nikhil', 'Rahul',
      'Rajesh', 'Ravi', 'Rohit', 'Sanjay', 'Suresh', 'Vikram', 'Vivek', 'Ananya', 'Deepa', 'Divya',
      'Kavya', 'Lakshmi', 'Meera', 'Neha', 'Pooja', 'Priya', 'Shreya', 'Sneha', 'Swati', 'Anjali',
    ],
    last: [
      'Sharma', 'Verma', 'Gupta', 'Patel', 'Shah', 'Kumar', 'Singh', 'Reddy', 'Rao', 'Nair',
      'Iyer', 'Menon', 'Pillai', 'Joshi', 'Mehta', 'Desai', 'Kulkarni', 'Chatterjee', 'Banerjee', 'Mukherjee',
      'Das', 'Bose', 'Agarwal', 'Malhotra', 'Kapoor', 'Chopra', 'Saxena', 'Bhat', 'Krishnan', 'Srinivasan',
    ],
  },
  SG: {
    first: [
      'Jason', 'Ryan', 'Marcus', 'Kelvin', 'Benjamin', 'Kenneth', 'Wei Ming', 'Jun Jie', 'Zhi Hao', 'Wen Jie',
      'Rachel', 'Michelle', 'Cheryl', 'Jasmine', 'Hui Min', 'Xin Yi', 'Mei Ling', 'Li Ting', 'Siew Ling', 'Shu Fen',
    ],
    last: [
      'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Goh', 'Chua', 'Chan', 'Koh',
      'Teo', 'Ang', 'Yeo', 'Tay', 'Ho', 'Low', 'Sim', 'Chong', 'Chen', 'Wang',
    ],
  },
  JP: {
    first: [
      'Haruto', 'Hiroshi', 'Kenji', 'Takashi', 'Daiki', 'Yuto', 'Sho', 'Ryo', 'Kazuki', 'Naoki',
      'Yui', 'Aoi', 'Sakura', 'Hana', 'Yuki', 'Emi', 'Mai', 'Rina', 'Ayaka', 'Nanami',
    ],
    last: [
      'Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato',
      'Yoshida', 'Yamada', 'Sasaki', 'Yamaguchi', 'Matsumoto', 'Inoue', 'Kimura', 'Hayashi', 'Shimizu', 'Mori',
    ],
  },
  AU: {
    first: [
      'Jack', 'Lachlan', 'Liam', 'Mitchell', 'Nathan', 'Riley', 'Cooper', 'Hamish', 'Angus', 'Declan',
      'Chloe', 'Isla', 'Mia', 'Ruby', 'Georgia', 'Matilda', 'Sienna', 'Tahlia', 'Brooke', 'Jade',
    ],
    last: [
      'Smith', 'Jones', 'Williams', 'Brown', 'Wilson', 'Taylor', 'Nguyen', 'Johnson', 'Martin', 'White',
      'Anderson', 'Walker', 'Thompson', 'Kelly', 'Ryan', 'Campbell', 'Mitchell', 'Harris', 'Robinson', 'Clarke',
    ],
  },
}

/**
 * WHERE THE COMPANY'S PEOPLE ARE: a group headquartered in Milan, with
 * offices in Europe and a few beyond. The share of each country for the
 * people who do not belong to a team of a region (the employees who use the
 * portal, the owner teams, the global teams).
 */
export const COMPANY_COUNTRIES: ReadonlyArray<readonly [Country, number]> = [
  ['IT', 42], ['DE', 9], ['FR', 8], ['ES', 7], ['GB', 8], ['NL', 5], ['NORDIC', 4], ['US', 8],
  ['IN', 4], ['SG', 2], ['JP', 1.5], ['AU', 1.5],
]

/** The region whose teams serve the people of a country (a request done on site goes to them). */
export const COUNTRY_REGION: Readonly<Record<Country, string>> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', NL: 'Benelux', NORDIC: 'Nordics',
  US: 'Americas', IN: 'APAC', SG: 'APAC', JP: 'APAC', AU: 'APAC',
}

/** The countries a support team of a region is staffed from. `Global` draws from the whole company. */
export const REGION_COUNTRIES: Readonly<Record<string, ReadonlyArray<readonly [Country, number]>>> = {
  'Italy': [['IT', 1]],
  'Germany': [['DE', 1]],
  'France': [['FR', 1]],
  'Spain': [['ES', 1]],
  'United Kingdom': [['GB', 1]],
  'Benelux': [['NL', 1]],
  'Nordics': [['NORDIC', 1]],
  'Americas': [['US', 1]],
  'APAC': [['IN', 45], ['SG', 25], ['JP', 15], ['AU', 15]],
  'Global': COMPANY_COUNTRIES,
}

/**
 * THE OFFICES, by country (D30). The vocabulary `office_site` of the catalog
 * is this list: the old one had nine European sites, while the servers stood
 * in New York, Singapore and Sydney and the service desks were in APAC, the
 * Americas and the Nordics.
 */
export const OFFICE_SITES: Readonly<Record<Country, ReadonlyArray<readonly [string, number]>>> = {
  IT: [['Milan HQ', 60], ['Rome', 25], ['Turin', 15]],
  DE: [['Frankfurt', 1]],
  FR: [['Paris', 1]],
  ES: [['Madrid', 1]],
  GB: [['London', 80], ['Dublin', 20]],
  NL: [['Amsterdam', 1]],
  NORDIC: [['Stockholm', 1]],
  US: [['New York', 60], ['Chicago', 40]],
  IN: [['Bangalore', 1]],
  SG: [['Singapore', 1]],
  JP: [['Tokyo', 1]],
  AU: [['Sydney', 1]],
}

/** Every office, in the order the vocabulary lists them; `Remote` for those who work from home. */
export const OFFICE_SITE_VALUES: readonly string[] = [
  ...new Set(Object.values(OFFICE_SITES).flatMap((sites) => sites.map(([site]) => site))), 'Remote',
]

export const EMAIL_DOMAIN = 'demo.opengrafo.io'

// ── Teams ───────────────────────────────────────────────────────────────────

/** Business areas: the owner teams are the people who answer for the applications of an area. */
/** The area that owns the infrastructure: its teams own the servers and instances no application claims (D75). */
export const INFRASTRUCTURE_AREA = 'IT Infrastructure'

export const OWNER_TEAM_AREAS: readonly string[] = [
  INFRASTRUCTURE_AREA,
  'Retail Banking', 'Corporate Banking', 'Payments', 'Cards', 'Lending', 'Treasury', 'Wealth Management',
  'Insurance Claims', 'Policy Administration', 'Underwriting', 'Finance', 'Accounting', 'Tax', 'Controlling',
  'Procurement', 'Supply Chain', 'Logistics', 'Warehouse', 'Manufacturing', 'Quality', 'Product Lifecycle',
  'Sales', 'Marketing', 'E-commerce', 'Customer Service', 'Loyalty', 'Human Resources', 'Payroll',
  'Talent Acquisition', 'Learning', 'Legal', 'Compliance', 'Risk Management', 'Internal Audit',
  'Data & Analytics', 'Document Management', 'Facilities', 'Field Service', 'Fleet', 'Energy Trading',
]

/**
 * THE UNITS OF EACH AREA (D69). Owner teams were «<area> Application
 * Owners / Business Systems / Digital Products / Platform Owners / Solutions»
 * — five near-synonyms per area with the same description. A business area
 * is split by what it does, and the team that answers for the applications
 * of that part is named after it.
 */
export const OWNER_TEAM_UNITS: Readonly<Record<string, readonly string[]>> = {
  'IT Infrastructure': ['Data Centre', 'Cloud Platform', 'Network and Security', 'Workplace Technology', 'Identity and Directory'],
  'Retail Banking': ['Current Accounts', 'Branch Network', 'Mortgages', 'Savings', 'Digital Channels'],
  'Corporate Banking': ['Cash Management', 'Trade Services', 'Corporate Lending', 'Client Onboarding', 'Relationship Management'],
  'Payments': ['Card Acquiring', 'Instant Transfers', 'SEPA Clearing', 'Gateway', 'Screening'],
  'Cards': ['Issuing', 'Card Operations', 'Rewards', 'Disputes', 'Card Lifecycle'],
  'Lending': ['Consumer Loans', 'Credit Decisioning', 'Loan Servicing', 'Collections', 'Leasing'],
  'Treasury': ['Liquidity', 'FX Dealing', 'Funding', 'Asset and Liability', 'Back Office'],
  'Wealth Management': ['Advisory', 'Portfolio Management', 'Private Banking', 'Custody', 'Client Reporting'],
  'Insurance Claims': ['Motor', 'Property', 'Intake', 'Loss Adjusting', 'Settlements'],
  'Policy Administration': ['Life', 'Non-Life', 'Renewals', 'Policy Documents', 'Endorsements'],
  'Underwriting': ['Commercial Lines', 'Personal Lines', 'Reinsurance', 'Risk Rating', 'Rules Engine'],
  'Finance': ['Financial Close', 'Group Reporting', 'Budgeting', 'Cost Allocation', 'Investor Relations'],
  'Accounting': ['General Ledger', 'Accounts Payable', 'Accounts Receivable', 'Fixed Assets', 'Intercompany'],
  'Tax': ['VAT', 'Corporate Tax', 'Transfer Pricing', 'E-invoicing', 'Tax Reporting'],
  'Controlling': ['Management Accounting', 'Profitability', 'Cost Centres', 'Forecasting', 'Performance Dashboards'],
  'Procurement': ['Sourcing', 'Supplier Onboarding', 'Purchase-to-Pay', 'Contracts', 'Catalogue Buying'],
  'Supply Chain': ['Demand Planning', 'Supply Planning', 'Order Fulfilment', 'Returns', 'Supplier Collaboration'],
  'Logistics': ['Transport Planning', 'Freight Audit', 'Carriers', 'Track and Trace', 'Customs'],
  'Warehouse': ['Inbound', 'Outbound', 'Inventory Control', 'Yard', 'Automation'],
  'Manufacturing': ['Production Planning', 'Shop Floor', 'Plant Maintenance', 'Plant Engineering', 'Execution Systems'],
  'Quality': ['Quality Control', 'Supplier Quality', 'Certifications', 'Non-conformities', 'Laboratory'],
  'Product Lifecycle': ['Product Data', 'Engineering Changes', 'Specifications', 'Bills of Materials', 'Launches'],
  'Sales': ['Sales Operations', 'Key Accounts', 'Pricing and Quotes', 'Sales Analytics', 'Partner Sales'],
  'Marketing': ['Campaigns', 'Brand', 'Marketing Analytics', 'Content', 'Events'],
  'E-commerce': ['Web Shop', 'Checkout', 'Product Catalogue', 'Marketplace', 'Mobile Commerce'],
  'Customer Service': ['Contact Centre', 'Complaints', 'Field Support', 'Self-Service', 'Customer Feedback'],
  'Loyalty': ['Programme', 'Rewards Catalogue', 'Member Services', 'Partner Rewards', 'Loyalty Analytics'],
  'Human Resources': ['HR Operations', 'Employee Records', 'Performance', 'Compensation', 'Workforce Planning'],
  'Payroll': ['Payroll Italy', 'Payroll International', 'Time and Attendance', 'Benefits', 'Expenses'],
  'Talent Acquisition': ['Recruiting', 'Employer Branding', 'Candidate Experience', 'Onboarding', 'Graduate Programme'],
  'Learning': ['Learning Platform', 'Compliance Training', 'Leadership Programmes', 'Certifications', 'Learning Content'],
  'Legal': ['Contracts', 'Litigation', 'Corporate Affairs', 'Intellectual Property', 'Legal Operations'],
  'Compliance': ['Anti-Money Laundering', 'Know Your Customer', 'Regulatory Change', 'Conduct', 'Data Privacy'],
  'Risk Management': ['Credit Risk', 'Market Risk', 'Operational Risk', 'Model Risk', 'Risk Reporting'],
  'Internal Audit': ['Audit Planning', 'IT Audit', 'Financial Audit', 'Follow-up', 'Continuous Monitoring'],
  'Data & Analytics': ['Data Warehouse', 'BI Reporting', 'Data Science', 'Master Data', 'Data Governance'],
  'Document Management': ['Archiving', 'Records', 'E-signature', 'Capture', 'Correspondence'],
  'Facilities': ['Workplace Services', 'Real Estate', 'Building Management', 'Space Planning', 'Health and Safety'],
  'Field Service': ['Dispatch', 'Service Contracts', 'Spare Parts', 'Mobile Workforce', 'Installed Base'],
  'Fleet': ['Fleet Operations', 'Telematics', 'Fuel Cards', 'Vehicle Leasing', 'Fleet Maintenance'],
  'Energy Trading': ['Trading Desk', 'Risk and Settlement', 'Market Access', 'Scheduling', 'Energy Analytics'],
}

/** Technology towers: the support teams are the people who keep the CIs running. */
export const SUPPORT_TEAM_TOWERS: readonly string[] = [
  'Linux Operations', 'Windows Server Operations', 'Oracle DBA', 'PostgreSQL DBA', 'SQL Server DBA',
  'Network Operations', 'Network Security', 'Storage & Backup', 'Virtualization', 'Kubernetes Platform',
  'Cloud Operations', 'Middleware', 'Integration Services', 'Messaging Platform', 'Identity & Access',
  'PKI & Certificates', 'Security Operations', 'Monitoring & Observability', 'Service Desk', 'End User Computing',
  'SAP Basis', 'Web Hosting', 'Mainframe Operations', 'Application Support', 'Release Management',
  'Batch Scheduling', 'Data Platform', 'API Management', 'Mobile Platform', 'DevOps Tooling',
]

export const SUPPORT_TEAM_REGIONS: readonly string[] = [
  'Italy', 'Germany', 'France', 'Spain', 'United Kingdom', 'Benelux', 'Nordics', 'Americas', 'APAC', 'Global',
]

/** Fictional suppliers for the external teams (no real company names). */
export const SUPPLIERS: readonly string[] = [
  'Brightline IT Services', 'Northbridge Managed Services', 'Bluewater Tech Partners', 'Cedar Systems Consulting',
  'Harborview Digital', 'Silverpeak Solutions', 'Ironwood Outsourcing', 'Meridian Cloud Services',
]

export const CHANGE_MANAGER_TEAM_NAME = 'Change Management Office'

// ── Business applications, applications, capabilities ─────────────────────

export const BA_QUALIFIERS: readonly string[] = [
  'Global', 'Group', 'Retail', 'Corporate', 'Digital', 'Enterprise', 'Regional', 'Online', 'Mobile', 'Partner',
  'Supplier', 'Employee', 'Customer', 'Wholesale', 'Central',
]

export const BA_SUBJECTS: readonly string[] = [
  'Payments', 'Billing', 'Invoicing', 'Payroll', 'Recruiting', 'Onboarding', 'Order Management', 'Inventory',
  'Warehouse', 'Transport', 'Pricing', 'Claims', 'Underwriting', 'Lending', 'Cards', 'Treasury', 'Tax',
  'Audit', 'Compliance', 'Fraud Detection', 'CRM', 'Loyalty', 'Campaign', 'Product Catalog', 'Commerce',
  'Procurement', 'Contract', 'Asset', 'Field Service', 'Quality', 'Document', 'Learning', 'Expense',
  'Travel', 'Facilities', 'Customer Support', 'Knowledge', 'Data Warehouse', 'Reporting', 'Forecasting',
  'Collections', 'Settlement', 'Trade Finance', 'Credit Risk', 'Market Data', 'Identity', 'Consent',
  'Scheduling', 'Maintenance', 'Energy Metering',
]

export const BA_KINDS: readonly string[] = [
  'Platform', 'System', 'Suite', 'Portal', 'Hub', 'Engine', 'Service', 'Manager', 'Workbench', 'Gateway',
]

/**
 * THE CODE NAMES OF THE APPLICATIONS (22 set 2026).
 *
 * Most applications of a real estate have a name of their own — a code name
 * the team gave them — and only some are called after the business they
 * serve. Naming them all "<business application> <component>" made the list
 * unreadable the moment somebody sorted it by name: a whole page of
 * near-identical rows, same first two words, one after the other.
 *
 * Invented words with no meaning in the business: birds, trees, minerals,
 * weather and stars. None is the name of a real product, and they spread
 * across the alphabet so that no letter owns a page of the list.
 */
export const APPLICATION_CODE_NAMES: readonly string[] = [
  'Alder', 'Altair', 'Amber', 'Aspen', 'Auriga', 'Avocet', 'Basalt', 'Beryl', 'Birch', 'Calcite',
  'Capella', 'Carina', 'Cirrus', 'Curlew', 'Cygnus', 'Daybreak', 'Deneb', 'Draco', 'Equinox', 'Feldspar',
  'Firecrest', 'Garnet', 'Godwit', 'Granite', 'Gypsum', 'Halo', 'Hawthorn', 'Hazel', 'Heron', 'Hornbeam',
  'Jasper', 'Juniper', 'Kestrel', 'Kite', 'Lapwing', 'Larch', 'Linnet', 'Lyra', 'Maple', 'Mira',
  'Mistral', 'Monsoon', 'Obsidian', 'Onyx', 'Osprey', 'Petrel', 'Plover', 'Puffin', 'Pyrite', 'Quartz',
  'Redstart', 'Rigel', 'Rowan', 'Sandpiper', 'Siskin', 'Solstice', 'Stratus', 'Sycamore', 'Tern', 'Topaz',
  'Twilight', 'Vega', 'Willow', 'Wren', 'Yew', 'Zenith', 'Zephyr', 'Zircon', 'Bittern', 'Chaffinch',
  'Dunlin', 'Egret', 'Fulmar', 'Gannet', 'Hobby', 'Ibis', 'Jackdaw', 'Knot', 'Lark', 'Marten',
  'Nightjar', 'Oriole', 'Pintail', 'Quail', 'Raven', 'Shearwater', 'Teal', 'Umbra', 'Vireo', 'Whimbrel',
  'Xenon', 'Yarrow', 'Zinnia', 'Cobalt', 'Flint', 'Slate', 'Tourmaline', 'Verdite', 'Alabaster', 'Selenite',
  'Almandine', 'Anhydrite', 'Azurite', 'Barite', 'Bluebell', 'Bracken', 'Briar', 'Bromine', 'Cairn', 'Campion',
  'Cassiter', 'Celandine', 'Chalcedon', 'Cinnabar', 'Clover', 'Comfrey', 'Coral', 'Cowslip', 'Crocus', 'Cypress',
  'Dolerite', 'Dolomite', 'Drumlin', 'Elderflower', 'Ember', 'Fennel', 'Fenland', 'Fern', 'Foxglove', 'Gabbro',
  'Galena', 'Gorse', 'Greenstone', 'Hematite', 'Heather', 'Hyssop', 'Ironstone', 'Jadeite', 'Kaolin', 'Kyanite',
  'Lavender', 'Limestone', 'Lodestone', 'Magnetite', 'Mallow', 'Marl', 'Meadowsweet', 'Millstone', 'Moraine', 'Mullein',
  'Nettle', 'Olivine', 'Orpiment', 'Peridot', 'Pimpernel', 'Pumice', 'Quartzite', 'Realgar', 'Rhyolite', 'Ryegrass',
  'Sandstone', 'Sanidine', 'Saxifrage', 'Scoria', 'Sorrel', 'Speedwell', 'Spinel', 'Staurolite', 'Sundew', 'Tansy',
  'Thistle', 'Thrift', 'Tremolite', 'Trefoil', 'Tuff', 'Valerian', 'Vervain', 'Wolframite', 'Woodruff', 'Wormwood',
  'Ashlar', 'Bedrock', 'Chert', 'Clastic', 'Esker', 'Gneiss', 'Kettle', 'Loess', 'Outcrop', 'Scarp',
  'Acanthus', 'Agate', 'Alkanet', 'Almond', 'Amaranth', 'Anemone', 'Angelica', 'Apatite', 'Arbutus', 'Ardsley',
  'Argentite', 'Arnica', 'Arrowwood', 'Ashwood', 'Asphodel', 'Auburn', 'Aventurine', 'Bailey', 'Balsam', 'Bankstone',
  'Barleycorn', 'Basil', 'Bayberry', 'Bellwort', 'Bentgrass', 'Bergamot', 'Betony', 'Bilberry', 'Bindweed', 'Birchwood',
  'Bistort', 'Blackcap', 'Bloodstone', 'Bogbean', 'Borage', 'Boxwood', 'Brimstone', 'Bristlecone', 'Broomrape', 'Bryony',
  'Buckthorn', 'Bugloss', 'Bullace', 'Burdock', 'Burnet', 'Butterbur', 'Buttonwood', 'Calamint', 'Camphor', 'Caraway',
  'Cardamine', 'Carnelian', 'Catmint', 'Cedarwood', 'Celestine', 'Centaury', 'Chamomile', 'Charlock', 'Chervil', 'Chickweed',
  'Chicory', 'Chrysolite', 'Cinquefoil', 'Citrine', 'Clearwater', 'Cleavers', 'Cloudberry', 'Columbine', 'Coneflower', 'Coppice',
  'Cordgrass', 'Cornflower', 'Cottongrass', 'Cranesbill', 'Crowberry', 'Cudweed', 'Currantwood', 'Cyclamen', 'Daffodil', 'Damson',
  'Dandelion', 'Deerhorn', 'Dewberry', 'Dittany', 'Dogbane', 'Dogrose', 'Downland', 'Dropwort', 'Dunefield', 'Eelgrass',
  'Eglantine', 'Elecampane', 'Elmwood', 'Endive', 'Eyebright', 'Fairstone', 'Falkenrock', 'Fenugreek', 'Fieldfare', 'Figwort',
  'Filbert', 'Firethorn', 'Flaxfield', 'Fleabane', 'Flixweed', 'Foxtail', 'Freestone', 'Fritillary', 'Frostwood', 'Fumitory',
  'Galingale', 'Gaultheria', 'Gentian', 'Germander', 'Ghostmoth', 'Gillyflower', 'Ginkgo', 'Glasswort', 'Goldenrod', 'Goosefoot',
  'Granadilla', 'Grassland', 'Greenbrier', 'Groundsel', 'Guelder', 'Hairgrass', 'Harebell', 'Hartstongue', 'Hawkbit', 'Hawkweed',
  'Headland', 'Heartwood', 'Hedgerow', 'Helleborine', 'Hemlock', 'Henbane', 'Herbrock', 'Hillstone', 'Hogweed', 'Hollyhock',
  'Honesty', 'Hopbine', 'Horehound', 'Hornstone', 'Houndstooth', 'Iceflow', 'Inkberry', 'Ivywood', 'Jacobsen', 'Jetstone',
  'Kingcup', 'Knapweed', 'Knotgrass', 'Labradorite', 'Ladybell', 'Lakeland', 'Lampstone', 'Larkspur', 'Laurelwood', 'Leadwort',
  'Lichenrock', 'Lightfoot', 'Lilywort', 'Limewood', 'Lingonberry', 'Lionstone', 'Liverwort', 'Longleaf', 'Loosestrife', 'Lovage',
  'Lungwort', 'Madderwood', 'Maidenhair', 'Marjoram', 'Marshwort', 'Mayweed', 'Meadowgrass', 'Medlar', 'Melilot', 'Mercury',
  'Milkvetch', 'Milkwort', 'Mintbush', 'Moonwort', 'Moorland', 'Mossbank', 'Motherwort', 'Mountainash', 'Mousetail', 'Mudstone',
  'Mugwort', 'Mulberry', 'Muskroot', 'Myrtlewood', 'Navelwort', 'Nightshade', 'Ninebark', 'Nutgall', 'Oakmoss', 'Oatgrass',
  'Orach', 'Oxlip', 'Pansywood', 'Parsleywood', 'Pasqueflower', 'Peatland', 'Pennywort', 'Peppermint', 'Periwinkle', 'Pewterstone',
  'Pineland', 'Pipewort', 'Plantain', 'Ploughland', 'Plumstone', 'Polypody', 'Pondweed', 'Poplarwood', 'Primrose', 'Purslane',
  'Quakinggrass', 'Quickthorn', 'Quillwort', 'Ragwort', 'Rampion', 'Rattlebox', 'Redshank', 'Reedmace', 'Restharrow', 'Ribwort',
  'Rockrose', 'Rosemary', 'Rowanwood', 'Rushfield', 'Saffronwood', 'Sagebrush', 'Sainfoin', 'Samphire', 'Sandwort', 'Sanicle',
  'Savory', 'Scabious', 'Sedgeland', 'Selfheal', 'Shadbush', 'Sheepbit', 'Shepherdsneedle', 'Silverweed', 'Skullcap', 'Sloewood',
  'Snakeroot', 'Sneezewort', 'Soapwort', 'Solomonseal', 'Sowthistle', 'Spearwort', 'Spikenard', 'Spindlewood', 'Spurge', 'Squillwood',
  'Stonecrop', 'Storksbill', 'Sunstone', 'Sweetbriar', 'Swordgrass', 'Tamarisk', 'Tansywood', 'Teasel', 'Thornfield', 'Thymewood',
  'Toadflax', 'Tormentil', 'Trailstone', 'Tulipwood', 'Turnstone', 'Twayblade', 'Valeswood', 'Venusherb', 'Vetchling', 'Vinestone',
  'Violetwood', 'Wallflower', 'Watercress', 'Waterlily', 'Waxwing', 'Wayfaring', 'Weldwood', 'Whitebeam', 'Whitethorn', 'Wildrye',
  'Windflower', 'Winterberry', 'Witchhazel', 'Woadfield', 'Woodbine', 'Woodrush', 'Woundwort', 'Yellowhorn', 'Yewfield', 'Yorkstone',
]

/** The technical parts an application is built from: "<business application> <component>". */
export const APPLICATION_COMPONENTS: readonly string[] = [
  'Web Frontend', 'API', 'Batch', 'Integration Service', 'Mobile App', 'Reporting', 'Backoffice',
  'Workflow Engine', 'Event Processor', 'Admin Console', 'Search Service', 'Notification Service',
]

export const BUSINESS_UNITS: readonly string[] = [
  'Retail', 'Corporate', 'Finance', 'Operations', 'Sales', 'Marketing', 'Human Resources', 'Legal',
  'Risk', 'Technology', 'Customer Care', 'Supply Chain',
]

/** Level-1 capabilities and their level-2 children. */
export const CAPABILITY_TREE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Customer Management', ['Customer Onboarding', 'Customer Service', 'Customer Insight', 'Loyalty Management', 'Complaint Handling', 'Customer Data Management']],
  ['Sales', ['Lead Management', 'Opportunity Management', 'Quotation', 'Order Capture', 'Sales Performance', 'Channel Management']],
  ['Marketing', ['Campaign Management', 'Brand Management', 'Market Research', 'Digital Marketing', 'Content Management', 'Pricing Strategy']],
  ['Product Management', ['Product Design', 'Product Catalogue', 'Product Pricing', 'Product Lifecycle', 'Product Compliance', 'Product Analytics']],
  ['Finance', ['General Ledger', 'Accounts Payable', 'Accounts Receivable', 'Financial Planning', 'Treasury Management', 'Tax Management']],
  ['Human Resources', ['Workforce Planning', 'Recruitment', 'Payroll', 'Performance Management', 'Learning & Development', 'Employee Relations']],
  ['Supply Chain', ['Demand Planning', 'Inventory Management', 'Warehouse Management', 'Transport Management', 'Supplier Management', 'Returns Management']],
  ['Operations', ['Service Delivery', 'Field Operations', 'Quality Management', 'Asset Maintenance', 'Facilities Management', 'Business Continuity']],
  ['Risk & Compliance', ['Risk Assessment', 'Regulatory Reporting', 'Fraud Management', 'Internal Controls', 'Data Protection', 'Audit Management']],
  ['Procurement', ['Sourcing', 'Contract Management', 'Purchase Ordering', 'Spend Analysis', 'Vendor Onboarding', 'Catalogue Buying']],
  ['IT Management', ['Service Management', 'Architecture Management', 'Security Management', 'Infrastructure Management', 'Application Management', 'Data Management']],
  ['Corporate Services', ['Legal Services', 'Document Management', 'Travel Management', 'Expense Management', 'Corporate Communication', 'Knowledge Management']],
]

/** Level-3 capabilities are aspects of a level-2 one. */
export const CAPABILITY_ASPECTS: readonly string[] = [
  'Planning', 'Execution', 'Monitoring', 'Reporting', 'Analytics', 'Governance',
]

/** How many capabilities the tree has names for: every level 1, every level 2, and each aspect of every level 2. */
export const CAPABILITY_CAPACITY = CAPABILITY_TREE.reduce((n, [, children]) => n + 1 + children.length * (1 + CAPABILITY_ASPECTS.length), 0)

// ── Infrastructure ──────────────────────────────────────────────────────────

/** Data centres and cloud regions: [site code for hostnames, location as shown]. */
export const SITES: ReadonlyArray<readonly [string, string]> = [
  ['mil', 'Milan'], ['rom', 'Rome'], ['tor', 'Turin'], ['fra', 'Frankfurt'], ['lon', 'London'], ['par', 'Paris'],
  ['mad', 'Madrid'], ['ams', 'Amsterdam'], ['dub', 'Dublin'], ['sto', 'Stockholm'], ['nyc', 'New York'],
  ['chi', 'Chicago'], ['sgp', 'Singapore'], ['tyo', 'Tokyo'], ['syd', 'Sydney'],
  ['aws-euw1', 'AWS eu-west-1'], ['aws-euc1', 'AWS eu-central-1'], ['azr-weu', 'Azure West Europe'], ['azr-neu', 'Azure North Europe'],
]

/**
 * WHAT A SERVER IS FOR, and how many of each (D7, tour of 23 Sep 2026). The
 * roles were drawn uniformly — as many domain controllers as application
 * servers — and the applications and instances took one to four servers at
 * random: 10,788 servers of 15,000 hosted nothing. An estate is mostly
 * application and database servers, with a few infrastructure ones (backup,
 * monitoring, directory, jump hosts) that host no business application.
 * `group`: what stands on it — applications, database instances, or neither.
 */
export const SERVER_ROLE_MIX: ReadonlyArray<readonly [role: string, weight: number, group: 'app' | 'db' | 'infra']> = [
  ['app', 20, 'app'], ['web', 15, 'app'], ['api', 12, 'app'], ['k8s', 8, 'app'], ['bat', 6, 'app'], ['cache', 4, 'app'],
  ['mq', 4, 'app'], ['etl', 4, 'app'], ['lb', 3, 'app'], ['fs', 3, 'app'],
  ['db', 14, 'db'],
  ['mon', 2, 'infra'], ['bkp', 2, 'infra'], ['ad', 1.5, 'infra'], ['jmp', 1.5, 'infra'],
]

export const HARDWARE_VENDORS: readonly string[] = ['Dell', 'HPE', 'Lenovo', 'Cisco', 'IBM', 'VMware', 'Amazon Web Services', 'Microsoft Azure']

export const LINUX_VERSIONS: readonly string[] = ['RHEL 8.8', 'RHEL 8.10', 'RHEL 9.2', 'RHEL 9.4', 'Ubuntu 20.04 LTS', 'Ubuntu 22.04 LTS', 'SLES 15 SP5', 'Oracle Linux 8.9']
export const WINDOWS_VERSIONS: readonly string[] = ['Windows Server 2016', 'Windows Server 2019', 'Windows Server 2022']

/** Database engine versions by instance type (the `instance_type` vocabulary). */
export const DB_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  'PostgreSQL': ['12.18', '13.14', '14.11', '15.6', '16.2'],
  'Oracle': ['12.2.0.1', '19.21', '19.22', '21.3'],
  'SQL Server': ['2016 SP3', '2017 CU31', '2019 CU25', '2022 CU12'],
}

export const DB_PORTS: Readonly<Record<string, string>> = {
  'PostgreSQL': '5432', 'Oracle': '1521', 'SQL Server': '1433',
}

export const DB_ENGINE_CODES: Readonly<Record<string, string>> = {
  'PostgreSQL': 'pg', 'Oracle': 'ora', 'SQL Server': 'mss',
}

/** What a database of an application holds: "<application slug>_<purpose>". */
export const DATABASE_PURPOSES: readonly string[] = [
  'core', 'audit', 'archive', 'reporting', 'staging', 'config', 'events', 'documents', 'history', 'cache',
]

export const CERTIFICATE_DOMAIN = 'opengrafo-demo.com'

/** A lower-case, dash-separated form of a name, for hostnames and database names. */
export function slug(text: string, separator = '-'): string {
  return text
    // The letters that do not decompose into a base letter and an accent (Bjørn, Sørensen, Mäkinen is fine).
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[œŒ]/g, 'oe').replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '')
}
