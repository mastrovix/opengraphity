export type UserRole =
  | 'TENANT_ADMIN'
  | 'OPERATOR'
  | 'APPROVER'
  | 'VIEWER'

export interface User {
  id: string
  tenant_id: string
  email: string
  name: string
  role: UserRole
  active: boolean
  created_at: string
}
