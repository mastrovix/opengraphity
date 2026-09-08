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
  ],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "JSXOpeningElement[name.name='button']:not(:has(JSXAttribute[name.name='type'])):not(:has(JSXSpreadAttribute))",
        message:
          'Ogni <button> nativo deve avere un `type` esplicito ("button" | "submit" | "reset"); preferisci <Button> di components/Button.',
      },
    ],
  },
}
