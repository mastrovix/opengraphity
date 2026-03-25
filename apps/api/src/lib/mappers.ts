export type Props = Record<string, unknown>

export function mapUser(props: Props) {
  return {
    id:        props['id']         as string,
    tenantId:  props['tenant_id']  as string,
    email:     props['email']      as string,
    name:      props['name']       as string,
    role:      props['role']       as string,
    active:    (props['active']    ?? true)  as boolean,
    createdAt: (props['created_at'] ?? null) as string | null,
  }
}

export function mapTeam(props: Props) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    description: (props['description'] ?? null) as string | null,
    type:        (props['type']        ?? null) as string | null,
    createdAt:   props['created_at']  as string,
  }
}
