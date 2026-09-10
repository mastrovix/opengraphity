/**
 * Categorie della Knowledge Base: colori e icone — una sola copia
 * (prima CATEGORY_COLORS era duplicata in KnowledgeBasePage e KBArticlePage).
 */
import { lookupOrError, colors, palette } from '@/lib/tokens'

export const KB_CATEGORY_COLORS: Record<string, string> = {
  hardware: colors.brand, software: palette.purple.light, network: palette.teal.light,
  security: 'var(--color-danger)', 'how-to': colors.success, faq: 'var(--color-warning)', general: 'var(--color-slate-light)',
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
