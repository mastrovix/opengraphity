# Design system — componenti condivisi

Componenti disponibili (in `components/` e `components/ui/`):

- **Button** (`components/Button.tsx`) — varianti `primary` / `secondary` / `ghost`, size `sm` / `xs`, prop `icon` e `style` per override puntuali
- **Card / SectionCard** — contenitori con titolo di sezione
- **DetailField** — coppia label/valore nelle pagine di dettaglio
- **PageTitle / PageContainer** — testata e layout standard di pagina
- **EmptyState** — stato vuoto di liste e tabelle
- **QueryError** — errore di query GraphQL
- **SlaBadge / CountBadge / StatusBadge / SeverityBadge** — badge di stato
- **Pagination** — paginazione liste
- **skeleton** — placeholder di caricamento
- **sonner** (toast), **dialog**, **dropdown-menu**, **input**, **label**, **select**, **table**, **textarea** — primitive UI

**Regola:** nelle nuove pagine usare questi componenti; non introdurre nuovi
stili inline per pattern già coperti. Se un pattern ricorre in più pagine,
estrarlo qui invece di duplicarlo.

Nota: `Button.tsx` vive in `components/` (non in `ui/`) perché `ui/button.tsx`
(shadcn) esiste già e il filesystem macOS è case-insensitive.
