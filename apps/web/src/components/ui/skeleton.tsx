/**
 * The placeholder of a loading page. Styled by `og-skeleton` in index.css
 * since Tailwind left the web (24 Sep 2026): its classes had never been
 * compiled, and the placeholder had no background.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={className ? `og-skeleton ${className}` : "og-skeleton"} {...props} />
}

export { Skeleton }
