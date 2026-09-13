import type { ReactNode } from 'react'
import { PageTitle } from './PageTitle'

interface ListPageHeaderProps {
  /** Icon element passed to PageTitle (e.g. <AlertCircle size={22} color="var(--color-icon-accent)" />) */
  icon: ReactNode
  title: string
  /** Ready-made count paragraph node (caller keeps its own loading logic) */
  subtitle?: ReactNode
  /** Action button(s) rendered on the right */
  actions?: ReactNode
}

/**
 * Standard list-page header: title + count subtitle on the left,
 * action buttons on the right.
 */
export function ListPageHeader({ icon, title, subtitle, actions }: ListPageHeaderProps) {
  return (
    /*
      `og-page-header` invece delle misure inline: aggiunge il `gap` e il
      ritorno a capo. Senza, il titolo arrivava a toccare il primo bottone
      (misurato: bordo destro del titolo = bordo sinistro del bottone, 0px) e
      su schermo stretto sembrava sovrapposto. Vedi index.css.
    */
    <div className="og-page-header" style={{ marginBottom: 24 }}>
      <div>
        <PageTitle icon={icon}>{title}</PageTitle>
        {subtitle}
      </div>
      {actions}
    </div>
  )
}
