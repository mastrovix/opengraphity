export interface CIPathRef {
  id: string
  type: string
}

export function ciPath(ci: CIPathRef): string {
  return `/ci/${ci.type}/${ci.id}`
}
