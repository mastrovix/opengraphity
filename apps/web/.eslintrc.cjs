/**
 * Config ESLint dell'app web — si somma a quella di root (`/.eslintrc.json`,
 * `root: true`): qui vivono solo le regole specifiche del frontend.
 *
 * - `jsx-a11y/recommended`: accessibilità del markup (label, alt, ruoli,
 *   tastiera sugli elementi cliccabili, aria-* coerenti).
 * - `<button>` senza `type` esplicito è un errore (equivalente di
 *   `react/button-has-type`, che richiederebbe eslint-plugin-react): un bottone
 *   nativo dentro un form fa submit per default. `<Button>` (components/Button)
 *   ha già `type="button"` di default.
 */
const BUTTON_TYPE_RULE = {
  selector:
    "JSXOpeningElement[name.name='button']:not(:has(JSXAttribute[name.name='type'])):not(:has(JSXSpreadAttribute))",
  message:
    'Ogni <button> nativo deve avere un `type` esplicito ("button" | "submit" | "reset"); preferisci <Button> di components/Button.',
}

/**
 * Colori scritti a mano (esadecimali, rgb/rgba) fuori dalla sorgente dei
 * token: ogni colore dell'interfaccia passa da index.css → lib/tokens.ts
 * (`colors`, `palette`, `alpha`, `vendorColors`), così una nuova tavolozza o
 * un tema si applicano da soli. Nei canvas (ECharts) si usa cssVar().
 */
const HEX = '#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?\\b'
const NO_HARDCODED_COLOR_RULES = [
  { selector: `Literal[value=/${HEX}/]`, message: 'Colore esadecimale scritto a mano: usa i token di lib/tokens.ts (colors/palette/alpha/vendorColors) o var(--color-…) di index.css.' },
  { selector: `TemplateElement[value.raw=/${HEX}/]`, message: 'Colore esadecimale scritto a mano in un template: usa var(--color-…) di index.css.' },
  { selector: 'Literal[value=/rgba?\\(/]', message: 'rgba() scritto a mano: usa alpha.* di lib/tokens.ts.' },
  { selector: 'TemplateElement[value.raw=/rgba?\\(/]', message: 'rgba() scritto a mano in un template: usa var(--color-*-a…) di index.css.' },
]

/**
 * Il FONT scritto a mano, come i colori: `fontFamily: 'monospace'` prende il
 * carattere predefinito del BROWSER, che non e quello del prodotto — e a
 * schermo si vede, perche la riga accanto ha un altro carattere. Il sistema di
 * design ha il suo token, `--font-mono` in index.css, e ogni punto
 * dell'interfaccia deve passare da li: cambiarlo una volta cambia tutto.
 * Trovato guardando la pagina delle code: 14 punti lo scrivevano a mano.
 */
const NO_HARDCODED_FONT_RULES = [
  { selector: "Literal[value='monospace']", message: "Font scritto a mano: usa var(--font-mono) (index.css), non il monospace del browser." },
  { selector: 'TemplateElement[value.raw=/monospace/]', message: 'Font scritto a mano in un template: usa var(--font-mono) di index.css.' },
]

module.exports = {
  plugins: ['jsx-a11y'],
  extends: ['plugin:jsx-a11y/recommended'],
  settings: {
    'jsx-a11y': {
      // Il design system: la regola control-has-associated-label & co. vedono
      // questi componenti come i loro equivalenti nativi.
      components: {
        Button: 'button',
        Input: 'input',
        Select: 'select',
        Textarea: 'textarea',
        FieldLabel: 'label',
      },
    },
  },
  overrides: [
    {
      // I test rendono di proposito markup non valido (ruoli ARIA inventati,
      // valori fuori tavolozza) per pinnare il fail-fast: le regole a11y del
      // markup non si applicano alle fixture.
      files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**'],
      rules: { 'jsx-a11y/aria-role': 'off', 'jsx-a11y/no-autofocus': 'off' },
    },
    {
      // Sorgente unica dei colori: index.css (:root) esposta da lib/tokens.ts
      // e lib/eventPalette.ts. Solo lì possono comparire esadecimali e rgba;
      // le fixture dei test restano libere (valori d'esempio).
      files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**', 'src/lib/tokens.ts', 'src/lib/eventPalette.ts'],
      rules: { 'no-restricted-syntax': ['error', BUTTON_TYPE_RULE] },
    },
  ],
  rules: {
    'no-restricted-syntax': ['error', BUTTON_TYPE_RULE, ...NO_HARDCODED_COLOR_RULES, ...NO_HARDCODED_FONT_RULES],
  },
}
