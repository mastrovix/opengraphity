/** Minimal logger surface shared by the Apollo link, token refresh and apps. */
export interface ClientLogger {
  error(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
}

/** Console-backed logger — explicit default for apps without a remote log sink. */
export const consoleLogger: ClientLogger = {
  error: (message, data) => console.error(message, data ?? ''),
  warn:  (message, data) => console.warn(message, data ?? ''),
  info:  (message, data) => console.info(message, data ?? ''),
}
