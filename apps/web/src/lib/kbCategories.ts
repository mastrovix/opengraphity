/**
 * Categorie della Knowledge Base: colori e icone — una sola copia
 * (prima CATEGORY_COLORS era duplicata in KnowledgeBasePage e KBArticlePage).
 */
import { lookupOrError } from '@/lib/tokens'

export const KB_CATEGORY_COLORS: Record<string, string> = {
  hardware: '#3b82f6', software: '#8b5cf6', network: '#06b6d4',
  security: 'var(--color-danger)', 'how-to': '#22c55e', faq: 'var(--color-warning)', general: 'var(--color-slate-light)',
}

export const KB_CATEGORY_ICONS: Record<string, string> = {
  hardware: '🖥️', software: '💿', network: '🌐', security: '🔐',
  'how-to': '📖', faq: '❓', general: '📋',
}

export function kbCategoryColor(category: string): string {
  return lookupOrError(KB_CATEGORY_COLORS, category, 'KB_CATEGORY_COLORS', 'var(--color-danger)')
}

export function kbCategoryIcon(category: string): string {
  return lookupOrError(KB_CATEGORY_ICONS, category, 'KB_CATEGORY_ICONS', '❌')
}
