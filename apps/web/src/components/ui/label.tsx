import * as React from "react"

/**
 * A label, styled by `og-label` in index.css since Tailwind left the web
 * (24 Sep 2026): its classes had never been compiled.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- primitiva generica: htmlFor/children arrivano dal chiamante via props
    <label data-slot="label" className={className ? `og-label ${className}` : "og-label"} {...props} />
  )
}

export { Label }
