import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { C } from './SidebarNavItems'

interface SidebarUserMenuProps {
  collapsed: boolean
  onToggle:  () => void
}

export function SidebarCollapseButton({ collapsed, onToggle }: SidebarUserMenuProps) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onToggle}
      aria-label={collapsed ? t('sidebar.expand', 'Espandi sidebar') : t('sidebar.collapse', 'Comprimi sidebar')}
      style={{
        display:         'flex',
        alignItems:      'center',
        justifyContent:  collapsed ? 'center' : 'flex-start',
        gap:             8,
        padding:         collapsed ? '12px 0' : '12px 16px',
        background:      'none',
        border:          'none',
        borderTop:       `1px solid ${C.border}`,
        color:           C.textSection,
        cursor:          'pointer',
        width:           '100%',
        flexShrink:      0,
        fontSize:        12,
        transition:      'background 150ms',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
    >
      {collapsed
        ? <ChevronRight size={14} aria-hidden="true" />
        : <><ChevronLeft size={14} aria-hidden="true" /><span>{t('sidebar.collapse', 'Collapse')}</span></>
      }
    </button>
  )
}
