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
       * LE DUE REGOLE NUOVE DI ESLINT 10, SPENTE QUI E ACCESE A PARTE.
       *
       * `recommended` della 10 ne porta due che la 8 non aveva, e insieme
       * fanno 69 segnalazioni su codice che non e' cambiato:
       *
       *   preserve-caught-error  47 — un `throw new Error(...)` dentro un
       *                               `catch` senza `{ cause: err }`: la
       *                               causa originale si perde
       *   no-useless-assignment  22 — un valore assegnato e mai riletto
       *
       * Sono ENTRAMBE sensate, e la prima e' persino importante per chi
       * legge un errore in produzione. Ma accenderle QUI vorrebbe dire che
       * questa migrazione cambia insieme il formato E le regole — e allora
       * non si potrebbe piu' verificare: davanti a un rosso non si saprebbe
       * se viene dal codice o dal passaggio alla configurazione piatta.
       *
       * Quindi qui si traduce e basta. Accenderle e sistemare le 69 e' un
       * lavoro suo, che si fa dopo e si legge da solo.
       */
      'preserve-caught-error': 'off',
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
     * Qui si accendono le CINQUE che il codice gia' citava — le uniche di cui
     * qualcuno, scrivendo, aveva gia' riconosciuto il bisogno — cosi' quelle
     * soppressioni tornano a voler dire qualcosa. I nove problemi veri che
     * emergevano accendendole sono stati sistemati prima (elementi non nativi
     * resi raggiungibili da tastiera), non zittiti.
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
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
    },
  },
)
