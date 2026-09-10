/**
 * Predicati sui ruoli, condivisi tra le rotte (main.tsx), la Sidebar e i
 * widget: un'unica lista di chi è "staff" (admin/operator/viewer) così una
 * voce di menu o un widget non portano mai a una pagina "accesso negato".
 * Gli end user del portale non vedono la console allarmi né la Salute CI.
 */
import type { UserRole } from '@/hooks/useMe'

export const STAFF_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer']

/** `role` è `me.role` (stringa dal DB) o null finché `me` non è caricato: null → false. */
export function isStaff(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && (STAFF_ROLES as readonly string[]).includes(role)
}
