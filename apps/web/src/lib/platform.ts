/**
 * THE KEY THAT SENDS (D13, tour of 23 Sep 2026).
 *
 * The internal chat sent with Ctrl+Enter only, and said so: on a Mac, where
 * the shortcuts are made with ⌘, nothing happened. The chat now accepts both,
 * and the hint names the one of the viewer's platform.
 */
type PlatformHints = { platform?: string; userAgent?: string; userAgentData?: { platform?: string } }

/** macOS, iOS, iPadOS: the command key plays the part of Ctrl. */
export function isApplePlatform(nav: PlatformHints = navigator as PlatformHints): boolean {
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(nav.userAgent ?? '')
}

/** How the «send» shortcut is written for this platform. */
export function sendShortcutLabel(nav?: PlatformHints): string {
  return isApplePlatform(nav) ? '⌘+Enter' : 'Ctrl+Enter'
}
