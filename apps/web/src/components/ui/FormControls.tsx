import { createContext, forwardRef, useContext, useId } from 'react'
import type { CSSProperties, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { colors, palette } from '@/lib/tokens'

/**
 * Shared form controls replicating the dominant inline style used across
 * the app (see CIDetailPage's inputStyle). Pass `style` for per-case
 * overrides; it is merged last.
 */
export const controlStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px',
  fontSize: 'var(--font-size-body)', borderRadius: 6,
  border: `1px solid ${palette.neutral.borderStrong}`, background: colors.white,
  fontFamily: 'var(--font-family)',
  outline: 'none',
}

/**
 * Inoltra il `ref` (terza revisione): senza, chi apre un campo in risposta a
 * un click non puo spostarci il fuoco. Nel Dizionario la rinomina compariva
 * col valore giusto e il fuoco restava dov'era — conseguenza dell'aver tolto
 * `autoFocus` per la regola eslint `jsx-a11y/no-autofocus` invece di gestire
 * il fuoco. Chi usa la tastiera attivava «Rinomina» e non raggiungeva il campo.
 */
/**
 * L'id del campo che contiene il controllo (secondo giro UI del 15 set 2026,
 * accessibilità). I pannelli dei disegnatori mettevano l'etichetta in un
 * `<span>` sopra il controllo: a schermo si leggeva «Label», per un lettore di
 * schermo il campo non aveva nome. `LabelledField` crea l'id, lo lega alla sua
 * `<label>` e lo passa qui: un `Input`/`Select`/`Textarea` senza `id` né
 * `aria-label` lo prende. Chi passa il proprio id o nome resta com'è.
 */
const FieldIdContext = createContext<string | null>(null)

type Naming = { id?: string; 'aria-label'?: string; 'aria-labelledby'?: string }
function useFieldId(props: Naming): string | undefined {
  const fromField = useContext(FieldIdContext)
  if (props.id || props['aria-label'] || props['aria-labelledby']) return props.id
  return fromField ?? undefined
}

/**
 * A disabled field looks disabled (26 Sep 2026): the pages used to paint it
 * grey one by one, and the ones that forgot showed a locked field as a white,
 * writable one.
 */
/**
 * The field that has the focus is outlined in the brand colour (26 Sep 2026):
 * the pages did it with onFocus/onBlur handlers, some of them, and a field on
 * one page lit up while the same field on the next did not. The rule is
 * `.og-field:focus` in index.css.
 */
const fieldClass = (own: string | undefined) => (own ? `og-field ${own}` : 'og-field')

const disabledStyle = (disabled: boolean | undefined): CSSProperties =>
  (disabled ? { background: palette.neutral.slateBg, cursor: 'not-allowed' } : {})

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ style, ...rest }, ref) {
    const id = useFieldId(rest)
    return <input ref={ref} {...rest} id={id} className={fieldClass(rest.className)} style={{ ...controlStyle, ...disabledStyle(rest.disabled), ...style }} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ style, children, ...rest }, ref) {
    const id = useFieldId(rest)
    return <select ref={ref} {...rest} id={id} className={fieldClass(rest.className)} style={{ ...controlStyle, ...disabledStyle(rest.disabled), ...style }}>{children}</select>
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ style, ...rest }, ref) {
    const id = useFieldId(rest)
    return <textarea ref={ref} {...rest} id={id} className={fieldClass(rest.className)} style={{ ...controlStyle, resize: 'vertical', lineHeight: 1.6, ...disabledStyle(rest.disabled), ...style }} />
  },
)

/**
 * Un'etichetta legata al controllo che contiene. `labelStyle` e l'aspetto
 * dell'etichetta; il controllo va scritto con `Input`/`Select`/`Textarea`.
 */
export function LabelledField({ label, labelStyle, style, children, after }: {
  label: React.ReactNode; labelStyle?: CSSProperties; style?: CSSProperties; children: React.ReactNode; after?: React.ReactNode
}) {
  const id = useId()
  return (
    <div style={style}>
      <label htmlFor={id} style={{ display: 'block', ...labelStyle }}>{label}</label>
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {after}
    </div>
  )
}

const fieldLabelStyle: CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 500, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4,
}

/**
 * Uppercase field label used above form controls in detail/edit views.
 *
 * Pass `htmlFor` (the control's `id`, e.g. from `useId()`) so the label is
 * announced with the control and clicking it focuses the field; without it the
 * label is a plain heading and the control needs its own `aria-label`.
 */
export function FieldLabel({ children, style, htmlFor }: { children: React.ReactNode; style?: CSSProperties; htmlFor?: string }) {
  if (htmlFor) {
    return <label htmlFor={htmlFor} style={{ ...fieldLabelStyle, ...style }}>{children}</label>
  }
  return <div style={{ ...fieldLabelStyle, ...style }}>{children}</div>
}
