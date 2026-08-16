/** Narrow structural reader for the fixed Electron bridge. */

import type {
  CatalogDetailQuery,
  CatalogDetailResult,
  CatalogListQuery,
  CatalogListResult,
  CompatibilityDecision,
  CompatibilityRequest,
  InstalledPluginListResult,
  PluginInstallRequest,
  PluginManagementRequest,
  PluginOperationSnapshot,
  PluginOperationStartResult,
  PluginOwnedDataOffer,
  PluginOwnedDataRemovalRequest,
  PluginOwnedDataRemovalResult,
  PluginOwnedDataRetentionRequest,
  PluginOwnedDataRetentionResult,
  PluginDiagnosticExportRequest,
  PluginDiagnosticExportResult,
  PluginRecoveryRetryRequest,
  PluginRecoverySnapshot,
} from '@deepseek-ai/dsh-plugin-center-contracts'
import { developmentCatalogBridge } from './development-bridge.ts'

/** Fixed catalog and trusted-operation face consumed by this client plugin. */
export interface DesktopCatalogBridge {
  readonly catalog: {
    list(query: CatalogListQuery): Promise<CatalogListResult>
    refresh(query: CatalogListQuery): Promise<CatalogListResult>
    detail(query: CatalogDetailQuery): Promise<CatalogDetailResult>
    checkCompatibility(request: CompatibilityRequest): Promise<CompatibilityDecision>
  }
  readonly installedPlugins: {
    list(): Promise<InstalledPluginListResult>
  }
  readonly pluginOperations: {
    readonly mutationsEnabled: boolean
    install(request: PluginInstallRequest): Promise<PluginOperationStartResult>
    manage(request: PluginManagementRequest): Promise<PluginOperationStartResult>
    getOperation(): Promise<PluginOperationSnapshot | null>
    onState(listener: (operation: PluginOperationSnapshot) => void): () => void
  }
  readonly pluginOwnedData: {
    getOffer(): Promise<PluginOwnedDataOffer | null>
    remove(request: PluginOwnedDataRemovalRequest): Promise<PluginOwnedDataRemovalResult>
    retain(request: PluginOwnedDataRetentionRequest): Promise<PluginOwnedDataRetentionResult>
  }
  readonly pluginRecovery?: {
    getState(): Promise<PluginRecoverySnapshot | null>
    retry(request: PluginRecoveryRetryRequest): Promise<PluginRecoverySnapshot | null>
    exportDiagnostics(request: PluginDiagnosticExportRequest): Promise<PluginDiagnosticExportResult>
    onState(listener: (snapshot: PluginRecoverySnapshot) => void): () => void
  }
}

/** Selected catalog transport and whether it is the browser development fixture. */
export interface CatalogBridgeResolution {
  readonly bridge: DesktopCatalogBridge | undefined
  readonly development: boolean
}

/**
 * Read the optional bridge without owning or merging the global Window type.
 * @returns The Electron catalog bridge when preload installed it.
 */
export function desktopCatalogBridge(): DesktopCatalogBridge | undefined {
  return (window as unknown as { dshDesktop?: DesktopCatalogBridge }).dshDesktop
}

/**
 * Prefer the production Electron bridge, then the explicitly marked Web fixture.
 * @returns The selected bridge and whether it uses development data.
 */
export function resolveCatalogBridge(): CatalogBridgeResolution {
  const desktop = desktopCatalogBridge()
  if (desktop !== undefined) return { bridge: desktop, development: false }
  const development = developmentCatalogBridge()
  return { bridge: development, development: development !== undefined }
}
