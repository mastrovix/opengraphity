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

Nota: `Button.tsx` vive in `components/` (non in `ui/`) perché in passato
esisteva `ui/button.tsx` (shadcn) e il filesystem macOS è case-insensitive; il
percorso è rimasto stabile per i ~30 importer.
