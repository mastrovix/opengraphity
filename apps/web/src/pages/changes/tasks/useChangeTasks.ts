// This hook is intentionally thin — the actual mutation calls live in the parent
// ChangeDetail page. This file exists for future extraction if needed.
// For now, it re-exports the TaskHandlers type for convenience.
export type { TaskHandlers } from './types'
