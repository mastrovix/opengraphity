# Design system — componenti condivisi

Un solo posto per ogni pattern ricorrente. Le primitive vivono in
`components/ui/`; i componenti "di pagina" più generici in `components/`.

## Bottoni e form

- **Button** (`components/Button.tsx`) — L'UNICO bottone dell'app. Varianti
  `primary` / `secondary` / `danger` / `ghost` / `icon` (quest'ultima richiede
  `aria-label` o `title`), size `sm` / `xs`, prop `icon`. `type` è `"button"`
  di default: dentro `<Modal as="form">` passare `type="submit"` esplicitamente.
  `style` solo per override puntuali.
- **FormControls** (`ui/FormControls.tsx`) — `Input`, `Select`, `Textarea`,
  `FieldLabel`, `controlStyle`.
- **styles** (`ui/styles.ts`) — costanti di stile (`inputS`, `selectS`,
  `textareaS`, `labelS`, `activeCardStyle`…) per i punti che devono ancora
  spargere uno stile su un elemento nativo. `btnPrimary/btnSecondary/btnDanger`
  sono **deprecati**: esistono solo per i consumer non ancora migrati a `Button`.
  `pages/settings/shared/designerStyles.ts` li ri-esporta per compatibilità e
  tiene solo le costanti specifiche dei designer (`FIELD_TYPES`, `EnumTypeRef`).
- **Toggle** (`ui/Toggle.tsx`) — switch on/off accessibile (`role="switch"`,
  `aria-checked`, `label` obbligatorio).
- **Tabs** (`ui/Tabs.tsx`) — barra di tab (`role="tablist"`, frecce, `aria-selected`);
  il contenuto resta nella pagina.

## Dialoghi

- **Modal** (`components/Modal.tsx`) — dialog con focus trap, Escape, ritorno
  del focus; `as="form"` + `onSubmit` per i form (in quel caso il click
  sull'overlay NON chiude: `closeOnOverlay` default `false`).
- **ConfirmModal** (`ui/ConfirmModal.tsx`) + **useConfirm** (`hooks/useConfirm.tsx`)
  — conferma a promessa al posto di `window.confirm`:
  `if (await confirm({ title, body, danger: true })) …`. Il `ConfirmProvider`
  è montato una volta in `AppLayout`.

## Liste e pagine

- **PageContainer / PageTitle / ListPageHeader** — layout e testata di pagina.
- **SortableFilterTable** + **FilterBuilder** + **Pagination** — tabella
  ordinabile, filtri avanzati, paginazione (`Pagination` ha `aria-label` e
  testi tradotti).
- **useListQueryState** (`hooks/useListQueryState.ts`) — stato sort/filtri/pagina
  con `variables` pronte per le query `(filters, sortField, sortDirection)`,
  opzionale `persistInQuery` (URL). Sostituisce la quadrupla
  `sortField/sortDir/filterGroup/handleSort` copiata nelle pagine.
- **useCrudModal** (`hooks/useCrudModal.ts`) — stato del modal create/edit
  (`openCreate`, `openEdit`, `close`, `draft`, `patch`).
- **useMutationWithToast** (`hooks/useMutationWithToast.ts`) — `useMutation`
  con toast d'errore (messaggio reale del server), toast di successo opzionale
  e `refetch()` della query attiva.
- **EmptyState**, **QueryError**, **ExportCsvButton** — stati vuoto/errore e
  export CSV.
- **SectionCard / CollapsibleGroup** — sezioni collassabili con header
  `<button aria-expanded>`; `headerRight` resta fuori dal bottone.
- **DetailField**, **SimpleTable**, **Pill / badges** (`SeverityBadge`,
  `StatusBadge`, `RoleBadge`, `CountBadge`, `SlaBadge`…), **skeleton**,
  **sonner** (toast), **dropdown-menu**, **label** (queste ultime tre derivate
  da shadcn; le altre primitive shadcn non usate sono state rimosse).

## GraphQL

- I documenti vivono in `graphql/queries/*` e `graphql/mutations/*` per dominio
  (`users`, `teams`, `automation`, `notifications`, `reports`…); `admin.ts` è
  solo un barrel di compatibilità. Fragment condivisi in `graphql/fragments.ts`
  (`USER_REF`, `TEAM_REF`). Un documento, un posto: niente `gql` inline
  duplicati di operazioni già esportate.

## Regole

1. Nelle nuove pagine usare questi componenti; non introdurre nuovi stili
   inline per pattern già coperti. Se un pattern ricorre in più pagine,
   estrarlo qui invece di duplicarlo.
2. Ogni `<button>` nativo ha `type` esplicito; ogni elemento cliccabile è un
   `<button>` o un `<Link>`, mai un `<div onClick>`.
3. Colori e dimensioni via custom property (`var(--border)`, `var(--font-size-*)`,
   `layoutPalette` per Sidebar/Topbar/GlobalSearch), non hex hardcoded.
4. Testi utente via `t()` (chiavi allineate in `i18n/locales/{it,en}.json`).
5. Niente `window.confirm`: `useConfirm()`.

## i18n — regole del design system

- **Nessun letterale visibile** in `components/ui/**`, `Modal`, `Pagination`,
  `EmptyState`, `QueryError`, `PageLoader`, `ExportCsvButton`, `RichTextEditor`,
  `ErrorBoundary`, nei `RouteError` di `main.tsx` e nei toast: ogni testo passa
  da `t()` (`useTranslation`) o, fuori da React (util, class component, hook
  puri), da `i18n.t()` con `import i18n from '@/i18n/i18n'`.
- **Toast**: `toast.success(t('toast.<dominio>.<nome>', { … }))`. Mai
  `toast.error('stringa')`; il messaggio del server passa come interpolazione
  (`{ error: e.message }`) o direttamente (`toast.error(e.message)`), non in un
  template literal con testo fisso.
- **Chiavi**: sezione per dominio (`pages.<dir>.*`, `components.<nome>.*`,
  `toast.<dominio>.*`, `common.*` per i testi ricorrenti). Aggiungere in fondo
  alla sezione, stesso ordine in `it.json` ed `en.json`, mai riordinare.
  Plurali con `_one/_other` + `count`; enum visibili con una chiave per valore
  (`pages.anomalies.severity.critical`), non `t(variabile)` libero.
- **Date e durate**: `lib/datetime.ts` (`formatDateTime`, `timeAgo`,
  `formatDuration`) segue la lingua attiva (`i18n.resolvedLanguage`) e le
  chiavi `time.*`; niente `toLocaleString('it-IT')` nei componenti.
- **Guardia CI**: `node scripts/check-i18n.mjs` (root) — it/en allineati,
  chiavi usate esistenti, chiavi inutilizzate (warning), letterali nei toast e
  nei `<button>` delle directory migrate (`MIGRATED_DIRS` nello script: quando
  una directory finisce la migrazione, aggiungerla lì).

## Accessibilità — regole del design system

Lint: `jsx-a11y/recommended` + `<button>` senza `type` = errore
(`apps/web/.eslintrc.cjs`). In pratica:

- **Label ↔ controllo**: `<label htmlFor={id}>` + `id` sul controllo (id da
  `useId()`), oppure il controllo annidato nella label. `FieldLabel` accetta
  `htmlFor`. Un titolo di gruppo ("Condizioni", "Azioni") non è una `<label>`:
  `<div>`/`<span>`, o `<fieldset><legend>` per gruppi di radio/checkbox.
- **Cliccabile = bottone**: `<button type="button">` (reset di stile inline se
  serve). Solo dove un bottone non è ammesso (`<tr>`, contenitori con bottoni
  annidati): `role="button" tabIndex={0} onKeyDown={keyActivate(handler)}`
  (`lib/a11y.ts`). Mai `<div onClick>` nudo.
- **`autoFocus`**: ammesso solo su elementi montati in risposta a un'azione
  dell'utente (dialogo aperto, editor inline dopo "Modifica"), con
  `// eslint-disable-next-line jsx-a11y/no-autofocus -- <motivo>`; vietato sui
  form delle pagine caricate da route.
- **Dialoghi**: `role="dialog" aria-modal aria-labelledby` sul pannello, non
  sull'overlay; Escape e bottone "Chiudi" sono l'equivalente da tastiera del
  click sull'overlay (`Modal.tsx` è il riferimento).
- **Icone**: `aria-hidden="true"` sulle icone decorative; i bottoni solo-icona
  hanno `aria-label` (o `title`, che `Button variant="icon"` usa come nome).
- Ogni `eslint-disable` porta il motivo dopo ` -- `; niente disable a livello
  di file.

Nota: `Button.tsx` vive in `components/` (non in `ui/`) perché in passato
esisteva `ui/button.tsx` (shadcn) e il filesystem macOS è case-insensitive; il
percorso è rimasto stabile per i ~30 importer.
