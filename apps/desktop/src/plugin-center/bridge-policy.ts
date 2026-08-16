/** Pure ownership check for Plugin Center IPC requests. */

/** Minimal invoke identity projected from Electron for deterministic tests. */
export interface CatalogInvokeIdentity {
  readonly senderId: number
  readonly senderFrameUrl: string | undefined
}

/** Current Desktop renderer authority. */
export interface CatalogRendererOwner {
  readonly webContentsId: number
  readonly origin: string | undefined
}

/** Reject stale Host generations, unrelated WebContents, and malformed frame URLs. */
export function assertCatalogRequestOwner(identity: CatalogInvokeIdentity, owner: CatalogRendererOwner): void {
  if (owner.origin === undefined || identity.senderId !== owner.webContentsId || identity.senderFrameUrl === undefined) {
    throw new Error('plugin catalog request is not owned by the current Desktop renderer')
  }
  let origin: string
  try { origin = new URL(identity.senderFrameUrl).origin } catch {
    throw new Error('plugin catalog request has an invalid renderer URL')
  }
  if (origin !== owner.origin) throw new Error('plugin catalog request origin is not current')
}
