/** Provider-selectable vision-enhancement API contract. */

import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { RpcRequest, RpcResponse } from './rpc.ts'

export type VisionProvider = 'bailian' | 'openrouter'

export interface VisionProviderView {
  id: VisionProvider
  name: string
  configured: boolean
  defaultModel: string
  apiKeyUrl: string
  modelEditable: boolean
}

export interface VisionStatusView {
  enabled: boolean
  configured: boolean
  provider: VisionProvider
  model: string
  apiKeyUrl: string
  providers: readonly VisionProviderView[]
}

export interface VisionTestView {
  provider: VisionProvider
  model: string
  description: string
}

export interface VisionApi {
  status(request: RpcRequest<{}>): Promise<RpcResponse<VisionStatusView>>
  test(request: RpcRequest<{
    mediaType: ImageMediaType
    data: string
    question?: string
    name?: string
  }>, signal?: AbortSignal): Promise<RpcResponse<VisionTestView>>
  enable(request: RpcRequest<{
    apiKey?: string
    provider?: VisionProvider
    model?: string
    mediaType: ImageMediaType
    data: string
    question?: string
    name?: string
  }>, signal?: AbortSignal): Promise<RpcResponse<VisionTestView>>
}
