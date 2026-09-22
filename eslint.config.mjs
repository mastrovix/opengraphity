/**
 * CONFIGURAZIONE PIATTA (21 set 2026, eslint 10).
 *
 * `.eslintrc.json` non viene piu' letto: eslint 9 ha reso la configurazione
 * piatta il default e la 10 ha tolto del tutto il formato vecchio. Questo file
 * e' la traduzione fedele di quello, regola per regola — NIENTE e' stato
 * aggiunto, tolto o ammorbidito nel passaggio: una migrazione che cambia anche
 * le regole non si puo' verificare, perche' non si sa piu' se un rosso nuovo
 * viene dal codice o dalla configurazione.
 *
 * Le due differenze di FORMA, non di sostanza:
 *
 *  - gli `overrides` diventano blocchi in coda: in configurazione piatta vince
 *    l'ultimo che combacia, quindi l'ordine di questo array E' la precedenza;
 *  - `excludedFiles` non esiste piu': si scrive `ignores` dentro il blocco.
 *
 * L'ambiente (`env: node, browser, es2022`) diventa `languageOptions.globals`,
 * presi da `globals` invece che elencati a mano.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
    },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-constant-condition': ['error', { checkLoops: false }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': 'error',

      /*
       * LE DUE REGOLE NUOVE DI ESLINT 10.
       *
       * `recommended` della 10 ne porta due che la 8 non aveva, e all'arrivo
       * facevano 69 segnalazioni su codice che non era cambiato. Restarono
       * spente perche' accenderle NELLA migrazione avrebbe cambiato insieme
       * il formato E le regole: davanti a un rosso non si sarebbe saputo da
       * dove veniva.
       *
       * `preserve-caught-error` e' accesa dal 22 set 2026, e le sue 47 sono
       * sistemate: ogni `throw new Error(...)` dentro un `catch` porta
       * `{ cause: err }`. Il messaggio conteneva gia' il TESTO della causa —
       * si perdeva la causa come OGGETTO, cioe' la sua pila e i suoi campi,
       * che in produzione sono quello che serve davvero.
       *
       * `no-useless-assignment` resta spenta: 22 segnalazioni, e ognuna va
       * guardata da sola perche' «assegnato e mai riletto» a volte e'
       * un'inizializzazione voluta. E' lavoro suo, non un rinvio.
       */
      'preserve-caught-error': 'error',
      'no-useless-assignment': 'off',
    },
  },
  {
    // `no-console` acceso solo dove un console.log e' un difetto: l'API in
    // produzione. Altrove (browser, pacchetti, script, test) e' uno strumento.
    files: [
      'apps/web/**', 'apps/portal/**', 'packages/**',
      'apps/api/src/scripts/**', '**/__tests__/**', '**/*.test.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    /*
     * I COLORI SI PRENDONO DAI TOKEN, NON SI SCRIVONO A MANO.
     *
     * Vale sul portale, dove il cliente cambia il tema: un `#3b82f6` scritto
     * in una pagina non segue il suo marchio, e non lo scopre nessuno finche'
     * non lo vede lui.
     */
    files: ['apps/portal/src/**/*.ts', 'apps/portal/src/**/*.tsx'],
    ignores: [
      '**/*.test.ts', '**/*.test.tsx',
      'apps/portal/src/test/**', 'apps/portal/src/lib/tokens.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'Literal[value=/#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?\\b/]',
          message: 'Colore esadecimale scritto a mano: usa i token di lib/tokens.ts (colors/palette/alpha) o var(--color-…) di index.css.' },
        { selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?\\b/]',
          message: 'Colore esadecimale scritto a mano in un template: usa var(--color-…) di index.css.' },
        { selector: 'Literal[value=/rgba?\\(/]',
          message: 'rgba() scritto a mano: usa alpha.* di lib/tokens.ts.' },
        { selector: 'TemplateElement[value.raw=/rgba?\\(/]',
          message: 'rgba() scritto a mano in un template: usa var(--color-*-a…) di index.css.' },
      ],
    },
  },
  {
    /*
     * LE REGOLE DI ACCESSIBILITA', ACCESE (21 set 2026).
     *
     * `eslint-plugin-jsx-a11y` era installato in `apps/web` da tempo ma non
     * era mai stato collegato alla configurazione: venticinque file avevano
     * `// eslint-disable-next-line jsx-a11y/...` che non sopprimeva niente,
     * perche' quelle regole non giravano. Chi le ha scritte credeva di avere
     * una rete che non c'era. Se n'e' accorto eslint 10, che le direttive
     * verso regole sconosciute non le ignora piu'.
     *
     * Si accesero prima le CINQUE che il codice gia' citava — le uniche di cui
     * qualcuno, scrivendo, aveva gia' riconosciuto il bisogno — cosi' quelle
     * soppressioni tornavano a voler dire qualcosa. I nove problemi veri che
     * emergevano accendendole sono stati sistemati, non zittiti.
     *
     * ## Le altre ventisette, accese il 22 set 2026
     * `recommended` del plugin ne porta trentaquattro. Accendendole TUTTE per
     * misurare, ventisette non segnalavano NIENTE: `alt-text`, `aria-props`,
     * `aria-role`, `role-has-required-aria-props`, `interactive-supports-focus`,
     * `no-noninteractive-tabindex`, `tabindex-no-positive` e le altre. Erano
     * spente non perche' costassero, ma perche' nessuno le aveva accese. Ora
     * `recommended` entra per intero e le eccezioni si dichiarano qui sotto.
     *
     * ## Le sette che restano spente, col motivo
     *
     * `label-has-for` (263 segnalazioni) — DEPRECATA dal plugin, che indica
     * come sostituta `label-has-associated-control`: e' accesa qui sopra. Sta
     * ancora dentro `recommended`, ed e' l'unica ragione per cui va spenta a
     * mano: accendere una regola deprecata che duplica una attiva vuol dire
     * duecentosessantatre errori per un parere gia' espresso.
     *
     * `control-has-associated-label` (163) — non capisce `<label htmlFor>`.
     * Cinquantotto delle sue segnalazioni erano controlli legati a una label
     * per `htmlFor`, cioe' corretti: un terzo di falsi positivi insegna a non
     * credere alla regola. Il caso VERO che nascondeva — un controllo senza
     * alcun nome — l'ha preso `scripts/check-etichette-controlli.mjs`, che
     * guarda anche gli antenati e su questo repository trovava quarantadue
     * controlli muti. Sistemati tutti e quarantadue.
     *
     * `prefer-tag-over-role` (100) — fuori da `recommended`, e chiede di
     * sostituire `role="listbox"`/`"dialog"`/`"status"` con i tag nativi. Su
     * una combobox costruita a mano `<select>` non e' equivalente, e la
     * sostituzione sarebbe una riscrittura dei componenti, non
     * un'accessibilita' guadagnata. Da decidere guardando i cento casi, non da
     * qui.
     *
     * `no-onchange` (58) e `accessible-emoji` (8) — DEPRECATE e fuori da
     * `recommended`. La prima diceva di preferire `onBlur` a `onChange`, che in
     * React e' sbagliato: `onChange` di React e' l'evento `input` del DOM.
     *
     * `lang`, `no-aria-hidden-on-focusable` e `anchor-ambiguous-text` — fuori
     * da `recommended` (l'ultima ci sta dentro ma spenta) e senza segnalazioni
     * qui: accese insieme alle altre.
     *
     * `no-autofocus` resta la piu' citata (27 volte): portare il fuoco da
     * soli e' giusto quando si apre una finestra modale o un campo di
     * ricerca, ed e' li' che le soppressioni stanno.
     */
    files: ['apps/web/src/**/*.tsx', 'apps/portal/src/**/*.tsx'],
    // I test restano fuori, come per la regola dei colori del portale: un test
    // che verifica «un campo con autoFocus tiene il fuoco» DEVE poter scrivere
    // quel campo. Qui si guarda l'interfaccia che il cliente usa.
    ignores: ['**/*.test.tsx', 'apps/web/src/test/**', 'apps/portal/src/test/**'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Spente in `recommended`, ma senza segnalazioni qui: si accendono.
      // `anchor-ambiguous-text` e' quella che vieta «clicca qui» come testo di
      // un link — chi naviga saltando da link a link sente solo quello.
      'jsx-a11y/lang': 'error',
      'jsx-a11y/no-aria-hidden-on-focusable': 'error',
      'jsx-a11y/anchor-ambiguous-text': 'error',
      // Le cinque che il codice gia' citava: da 'warn' di recommended a 'error'.
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      // Le due spente, col motivo per esteso qui sopra.
      'jsx-a11y/label-has-for': 'off',
      'jsx-a11y/control-has-associated-label': 'off',
    },
  },
)
