/** Sandboxed renderer bridge: fixed methods only, no generic IPC escape hatch. */

import { contextBridge, ipcRenderer } from 'electron'
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
import {
  DESKTOP_CHANNELS,
  type DesktopAppearanceSettings,
  type DesktopBridge,
  type DesktopUpdateState,
} from './desktop-bridge-contract.ts'

const bridge: DesktopBridge = Object.freeze({
  platform: process.platform,
  appearance: Object.freeze({
    get: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appearanceGet) as Promise<DesktopAppearanceSettings>,
    save: (settings: DesktopAppearanceSettings) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.appearanceSave, settings) as Promise<DesktopAppearanceSettings>,
    reset: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appearanceReset) as Promise<DesktopAppearanceSettings>,
  }),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updatesGet) as Promise<DesktopUpdateState>,
    check: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updatesCheck) as Promise<DesktopUpdateState>,
    download: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updatesDownload) as Promise<DesktopUpdateState>,
    install: () => ipcRenderer.invoke(DESKTOP_CHANNELS.updatesInstall) as Promise<void>,
    onState: (listener: (state: DesktopUpdateState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_CHANNELS.updatesState, receive)
      return () => { ipcRenderer.off(DESKTOP_CHANNELS.updatesState, receive) }
    },
  }),
  catalog: Object.freeze({
    list: (query: CatalogListQuery) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.catalogList, query) as Promise<CatalogListResult>,
    refresh: (query: CatalogListQuery) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.catalogRefresh, query) as Promise<CatalogListResult>,
    detail: (query: CatalogDetailQuery) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.catalogDetail, query) as Promise<CatalogDetailResult>,
    checkCompatibility: (request: CompatibilityRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.catalogCheckCompatibility, request) as Promise<CompatibilityDecision>,
  }),
  installedPlugins: Object.freeze({
    list: () => ipcRenderer.invoke(DESKTOP_CHANNELS.installedPluginsList) as Promise<InstalledPluginListResult>,
  }),
  pluginOperations: Object.freeze({
    mutationsEnabled: true,
    install: (request: PluginInstallRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOperationStart, request) as Promise<PluginOperationStartResult>,
    manage: (request: PluginManagementRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOperationStart, request) as Promise<PluginOperationStartResult>,
    getOperation: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOperationGet) as Promise<PluginOperationSnapshot | null>,
    onState: (listener: (operation: PluginOperationSnapshot) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, operation: PluginOperationSnapshot): void => {
        listener(operation)
      }
      ipcRenderer.on(DESKTOP_CHANNELS.pluginOperationState, receive)
      return () => { ipcRenderer.off(DESKTOP_CHANNELS.pluginOperationState, receive) }
    },
  }),
  pluginOwnedData: Object.freeze({
    getOffer: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOwnedDataGetOffer) as Promise<PluginOwnedDataOffer | null>,
    remove: (request: PluginOwnedDataRemovalRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOwnedDataRemove, request) as Promise<PluginOwnedDataRemovalResult>,
    retain: (request: PluginOwnedDataRetentionRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginOwnedDataRetain, request) as Promise<PluginOwnedDataRetentionResult>,
  }),
  pluginRecovery: Object.freeze({
    getState: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginRecoveryGet) as Promise<PluginRecoverySnapshot | null>,
    retry: (request: PluginRecoveryRetryRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginRecoveryRetry, request) as Promise<PluginRecoverySnapshot | null>,
    exportDiagnostics: (request: PluginDiagnosticExportRequest) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.pluginRecoveryExport, request) as Promise<PluginDiagnosticExportResult>,
    onState: (listener: (snapshot: PluginRecoverySnapshot) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: PluginRecoverySnapshot): void => {
        listener(snapshot)
      }
      ipcRenderer.on(DESKTOP_CHANNELS.pluginRecoveryState, receive)
      return () => { ipcRenderer.off(DESKTOP_CHANNELS.pluginRecoveryState, receive) }
    },
  }),
})

contextBridge.exposeInMainWorld('dshDesktop', bridge)
