import { useState } from 'react'
import { Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

interface Props {
  initialValue?: string
  onSearch?: (q: string) => void
  large?: boolean
}

export function KBSearchBar({ initialValue = '', onSearch, large = false }: Props) {
  const { t }      = useTranslation()
  const navigate   = useNavigate()
  const [q, setQ]  = useState(initialValue)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!q.trim()) return
    if (onSearch) {
      onSearch(q.trim())
    } else {
      navigate(`/kb?search=${encodeURIComponent(q.trim())}`)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ position: 'relative', width: '100%' }}>
      <Search
        size={large ? 20 : 16}
        style={{
          position:  'absolute',
          left:      large ? 16 : 12,
          top:       '50%',
          transform: 'translateY(-50%)',
          color:     '#94A3B8',
          pointerEvents: 'none',
        }}
      />
      <input
        type="text"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={t('home.search')}
        style={{
          width:          '100%',
          padding:        large ? '14px 16px 14px 48px' : '9px 12px 9px 36px',
          border:         '1.5px solid #E2E8F0',
          borderRadius:   large ? 12 : 8,
          fontSize:       large ? 16 : 14,
          outline:        'none',
          boxShadow:      large ? '0 2px 12px rgba(0,0,0,0.06)' : 'none',
          transition:     'border-color 0.15s',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = '#0EA5E9' }}
        onBlur={e  => { e.currentTarget.style.borderColor = '#E2E8F0' }}
      />
      {q && (
        <button
          type="submit"
          style={{
            position:        'absolute',
            right:           8,
            top:             '50%',
            transform:       'translateY(-50%)',
            padding:         '6px 14px',
            backgroundColor: '#0EA5E9',
            color:           '#fff',
            border:          'none',
            borderRadius:    6,
            fontSize:        13,
            fontWeight:      600,
            cursor:          'pointer',
          }}
        >
          Cerca
        </button>
      )}
    </form>
  )
}
