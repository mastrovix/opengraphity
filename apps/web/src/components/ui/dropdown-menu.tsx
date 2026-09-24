/**
 * THE MENU of the header (user menu), on Base UI's Menu.
 *
 * Rewritten with the tokens on 24 Sep 2026, when Tailwind left the web (review
 * of 23 Sep 2026, decided by the owner). Its classes had never been compiled:
 * the popup had a look only from the inline style its one caller gives it,
 * the separator had no height, an item under the pointer or the keyboard
 * showed nothing. The styles are now `og-menu*` in index.css.
 *
 * Only what the product uses is here: menu, trigger, content, item,
 * separator. The other shadcn wrappers (sub-menus, checkbox and radio items,
 * labels, shortcuts) had no caller.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

/** A caller's class goes after the base one: it adds, it does not replace. */
const withClass = (base: string, extra: string | undefined) => (extra ? `${base} ${extra}` : base)

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: Omit<MenuPrimitive.Popup.Props, "className"> & { className?: string } &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="og-menu-positioner" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup data-slot="dropdown-menu-content" className={withClass("og-menu", className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: Omit<MenuPrimitive.Item.Props, "className"> & { className?: string; variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={withClass("og-menu-item", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: Omit<MenuPrimitive.Separator.Props, "className"> & { className?: string }) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={withClass("og-menu-separator", className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
}
