/** Zod schemas for the provider-selectable vision-enhancement API. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const imageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const visionProviderSchema = z.enum(['bailian', 'openrouter'])
const visionProviderValueSchema = z.object({
  id: visionProviderSchema,
  name: z.string().min(1),
  configured: z.boolean(),
  defaultModel: z.string().min(1),
  apiKeyUrl: z.url(),
  modelEditable: z.boolean(),
})

export const visionStatusRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'vision.status'>>>
export const visionStatusValueSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  provider: visionProviderSchema,
  model: z.string().min(1),
  apiKeyUrl: z.url(),
  providers: z.array(visionProviderValueSchema).length(2),
}) satisfies z.ZodType<Wire<ResponseValue<'vision.status'>>>

export const visionTestRequestSchema = z.object({
  mediaType: imageMediaTypeSchema,
  data: z.string().min(1).max(14_000_000),
  question: z.string().max(2_000).optional(),
  name: z.string().max(255).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'vision.test'>>>

export const visionEnableRequestSchema = visionTestRequestSchema.extend({
  apiKey: z.string().min(1).max(16_384).optional(),
  provider: visionProviderSchema.optional(),
  model: z.string().trim().min(1).max(255).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'vision.enable'>>>

export const visionTestValueSchema = z.object({
  provider: visionProviderSchema,
  model: z.string().min(1),
  description: z.string().min(1),
}) satisfies z.ZodType<Wire<ResponseValue<'vision.test'>>>

export const visionEnableValueSchema = visionTestValueSchema satisfies z.ZodType<Wire<ResponseValue<'vision.enable'>>>
