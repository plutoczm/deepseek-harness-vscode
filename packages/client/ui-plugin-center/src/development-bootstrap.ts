/** Host-rendered marker enabling the deterministic browser development bridge. */

const DEVELOPMENT_MARKER = '<script>window.__DSH_PLUGIN_CENTER_DEV__ = Object.freeze({ version: 1 })</script>'

/**
 * Insert the development marker before the browser plugin tree starts.
 * @param html - Raw application index HTML.
 * @returns HTML with the explicit development marker.
 */
export function injectPluginCenterDevelopment(html: string): string {
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${DEVELOPMENT_MARKER}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${DEVELOPMENT_MARKER}${html.slice(at)}`
}
