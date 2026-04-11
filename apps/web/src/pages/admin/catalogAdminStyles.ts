export const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
export const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
export const labelS: React.CSSProperties = { display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4 }
export const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: '#38bdf8',
  color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}
export const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}
export const badgeS = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 'var(--font-size-table)', fontWeight: 600, background: bg, color: fg,
})
export const tabS = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px', fontSize: 'var(--font-size-body)', fontWeight: active ? 600 : 400, cursor: 'pointer',
  borderBottom: active ? '2px solid var(--color-brand)' : '2px solid transparent',
  color: active ? 'var(--color-brand)' : 'var(--color-slate)',
  background: 'none', border: 'none', borderBottomStyle: 'solid', borderBottomWidth: 2,
  borderBottomColor: active ? 'var(--color-brand)' : 'transparent',
})
