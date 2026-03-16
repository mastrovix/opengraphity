export interface CIPathRef {
  id: string
  type: string
}

export function ciPath(ci: CIPathRef): string {
  switch (ci.type) {
    case 'application':       return `/applications/${ci.id}`
    case 'database':          return `/databases/${ci.id}`
    case 'database_instance': return `/database-instances/${ci.id}`
    case 'server':            return `/servers/${ci.id}`
    case 'certificate':       return `/certificates/${ci.id}`
    default:                  return `/cmdb/${ci.id}`
  }
}
