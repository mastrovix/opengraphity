import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { CategoryTab } from '@/pages/admin/CategoryTab'
import { EntryTab } from '@/pages/admin/EntryTab'
import { tabS } from '@/pages/admin/catalogAdminStyles'

export function ChangeCatalogAdminPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'categories' | 'entries'>('categories')

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <PageTitle icon={<BookOpen size={22} color="#38bdf8" />}>
          {t('pages.changeCatalogAdmin.title')}
        </PageTitle>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        <button style={tabS(tab === 'categories')} onClick={() => setTab('categories')}>
          {t('pages.changeCatalogAdmin.categories')}
        </button>
        <button style={tabS(tab === 'entries')} onClick={() => setTab('entries')}>
          {t('pages.changeCatalogAdmin.entries')}
        </button>
      </div>

      {tab === 'categories' ? <CategoryTab /> : <EntryTab />}
    </PageContainer>
  )
}
