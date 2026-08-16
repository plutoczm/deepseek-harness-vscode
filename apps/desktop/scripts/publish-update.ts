/** Validate and publish Desktop auto-update artifacts to the Beyondata OSS feed. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OSS from 'ali-oss'
import { load } from 'js-yaml'

const OSS_REGION = 'oss-cn-hangzhou'
const OSS_BUCKET = 'ml2022'
const RELEASE_PREFIX = 'deepseek-harness-desktop/releases'
const PUBLIC_ORIGIN = `https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`

type Platform = 'mac' | 'windows'
type PayloadKind = 'artifact' | 'blockmap' | 'metadata'

interface ReleaseFile {
  readonly url: string
  readonly sha512: string
  readonly size: number
}

interface ReleaseMetadata {
  readonly version: string
  readonly files: readonly ReleaseFile[]
  readonly path: string
  readonly sha512: string
}

/** One validated local file and its immutable OSS identity. */
export interface ReleasePayload {
  readonly kind: PayloadKind
  readonly localPath: string
  readonly objectKey: string
  readonly size: number
  readonly sha512: string
  readonly contentType: string
  readonly cacheControl: string
}

/** Complete set of files for one channel publication. */
export interface ReleaseBundle {
  readonly version: string
  readonly channel: string
  readonly payloads: readonly ReleasePayload[]
}

/** Minimal object-store operations used by the publisher and its tests. */
export interface ReleaseObjectStore {
  head(objectKey: string): Promise<{ readonly size: number; readonly sha512?: string } | undefined>
  put(payload: ReleasePayload): Promise<void>
}

interface CollectOptions {
  readonly currentVersion: string
  readonly allowCurrentBaseline: boolean
}

interface CliOptions extends CollectOptions {
  readonly directories: readonly string[]
  readonly dryRun: boolean
}

/**
 * Validate release metadata and all referenced files without contacting OSS.
 * @param directories - Build-output directories containing channel metadata.
 * @param options - Current application version and the explicit baseline exception.
 * @returns A publication bundle ordered independently of upload timing.
 */
export function collectReleaseBundle(directories: readonly string[], options: CollectOptions): ReleaseBundle {
  if (directories.length === 0) throw new Error('至少需要一个 --dir 发布目录。')
  const versions = new Set<string>()
  const channels = new Set<string>()
  const payloads = new Map<string, ReleasePayload>()

  for (const input of directories) {
    const directory = resolve(input)
    if (!statSync(directory).isDirectory()) throw new Error(`发布目录不是文件夹：${directory}`)
    const metadataNames = readdirSync(directory)
      .filter(name => name.endsWith('.yml') && !name.startsWith('builder-'))
    if (metadataNames.length === 0) throw new Error(`发布目录缺少渠道 yml：${directory}`)

    for (const metadataName of metadataNames) {
      if (metadataName.endsWith('-linux.yml')) {
        throw new Error(`Linux 在线更新发布尚未接入：${metadataName}`)
      }
      const platform: Platform = metadataName.endsWith('-mac.yml') ? 'mac' : 'windows'
      const channel = channelFromMetadataName(metadataName, platform)
      const metadataPath = join(directory, metadataName)
      const metadata = parseMetadata(metadataPath)
      versions.add(metadata.version)
      channels.add(channel)
      validatePrimaryEntry(metadata, metadataPath)

      const hasMacZip = metadata.files.some(file => extname(file.url).toLowerCase() === '.zip')
      if (platform === 'mac' && !hasMacZip) {
        if (!options.allowCurrentBaseline || metadata.version !== options.currentVersion) {
          throw new Error(`macOS 自动更新发布缺少 ZIP 载荷：${metadataPath}`)
        }
      }

      for (const file of metadata.files) {
        const artifactName = safeArtifactName(file.url, metadataPath)
        const artifactPath = join(directory, artifactName)
        validateReleaseFile(artifactPath, file)
        addPayload(payloads, payloadFor('artifact', artifactPath, artifactName))

        const blockmapName = `${artifactName}.blockmap`
        const blockmapPath = join(directory, blockmapName)
        if (!existsSync(blockmapPath)) throw new Error(`更新载荷缺少 blockmap：${blockmapPath}`)
        addPayload(payloads, payloadFor('blockmap', blockmapPath, blockmapName))
      }

      addPayload(payloads, payloadFor('metadata', metadataPath, metadataName))
    }
  }

  if (versions.size !== 1) throw new Error(`发布目录版本不一致：${[...versions].join(', ')}`)
  if (channels.size !== 1) throw new Error(`发布目录渠道不一致：${[...channels].join(', ')}`)
  const version = onlyValue(versions, '版本')
  if (version !== options.currentVersion) {
    throw new Error(`发布版本 ${version} 与 Desktop package.json ${options.currentVersion} 不一致。`)
  }
  return { version, channel: onlyValue(channels, '渠道'), payloads: [...payloads.values()] }
}

/**
 * Upload immutable files first and channel metadata last.
 * @param bundle - Fully validated release bundle.
 * @param store - OSS-compatible object store.
 * @param verifyMetadata - Public-read verification invoked after all uploads.
 * @returns Nothing after every object and public manifest verifies.
 */
export async function publishReleaseBundle(
  bundle: ReleaseBundle,
  store: ReleaseObjectStore,
  verifyMetadata: (payload: ReleasePayload) => Promise<void>,
): Promise<void> {
  const immutable = bundle.payloads.filter(payload => payload.kind !== 'metadata')
  const metadata = bundle.payloads.filter(payload => payload.kind === 'metadata')
  for (const payload of [...immutable, ...metadata]) {
    const existing = await store.head(payload.objectKey)
    if (payload.kind !== 'metadata' && existing !== undefined) {
      if (existing.size !== payload.size || existing.sha512 !== payload.sha512) {
        throw new Error(`版本化对象已存在但内容不同，请提升版本号：${payload.objectKey}`)
      }
      console.log(`已存在，跳过：${payload.objectKey}`)
      continue
    }
    await store.put(payload)
    const uploaded = await store.head(payload.objectKey)
    if (uploaded?.size !== payload.size || uploaded.sha512 !== payload.sha512) {
      throw new Error(`OSS 上传后校验失败：${payload.objectKey}`)
    }
    console.log(`已上传：${payload.objectKey} (${String(payload.size)} bytes)`)
  }
  for (const payload of metadata) await verifyMetadata(payload)
}

class AliyunReleaseStore implements ReleaseObjectStore {
  private readonly client: OSS

  constructor(accessKeyId: string, accessKeySecret: string) {
    this.client = new OSS({
      region: OSS_REGION,
      bucket: OSS_BUCKET,
      accessKeyId,
      accessKeySecret,
      authorizationV4: true,
      secure: true,
    })
  }

  async head(objectKey: string): Promise<{ readonly size: number; readonly sha512?: string } | undefined> {
    try {
      const result = await this.client.head(objectKey)
      const headers = result.res.headers as Record<string, unknown>
      const size = Number(headers['content-length'])
      const sha512 = headers['x-oss-meta-sha512']
      return { size, ...(typeof sha512 === 'string' ? { sha512 } : {}) }
    } catch (error) {
      if (errorStatus(error) === 404) return undefined
      throw error
    }
  }

  async put(payload: ReleasePayload): Promise<void> {
    const result = await this.client.put(payload.objectKey, payload.localPath, {
      headers: {
        'Content-Type': payload.contentType,
        'Cache-Control': payload.cacheControl,
        'x-oss-meta-sha512': payload.sha512,
      },
    })
    if (result.res.status !== 200) throw new Error(`OSS PutObject 返回 ${String(result.res.status)}：${payload.objectKey}`)
  }
}

function parseMetadata(path: string): ReleaseMetadata {
  const value: unknown = load(readFileSync(path, 'utf8'))
  if (!isRecord(value) || typeof value.version !== 'string' || !Array.isArray(value.files)
      || typeof value.path !== 'string' || typeof value.sha512 !== 'string') {
    throw new Error(`渠道元数据格式无效：${path}`)
  }
  const files = value.files.map((entry): ReleaseFile => {
    if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.sha512 !== 'string'
        || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`渠道元数据 files 条目无效：${path}`)
    }
    return { url: entry.url, sha512: entry.sha512, size: entry.size }
  })
  if (files.length === 0) throw new Error(`渠道元数据没有更新载荷：${path}`)
  return { version: value.version, files, path: value.path, sha512: value.sha512 }
}

function validatePrimaryEntry(metadata: ReleaseMetadata, metadataPath: string): void {
  const primary = metadata.files.find(file => file.url === metadata.path)
  if (primary === undefined || primary.sha512 !== metadata.sha512) {
    throw new Error(`渠道元数据 path/sha512 与 files 不一致：${metadataPath}`)
  }
}

function validateReleaseFile(path: string, expected: ReleaseFile): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`渠道元数据引用的文件不存在：${path}`)
  const size = statSync(path).size
  if (size !== expected.size) throw new Error(`文件大小与渠道元数据不一致：${path}`)
  const sha512 = digest(path)
  if (sha512 !== expected.sha512) throw new Error(`文件 SHA-512 与渠道元数据不一致：${path}`)
}

function safeArtifactName(url: string, metadataPath: string): string {
  let decoded: string
  try {
    decoded = decodeURI(url)
  } catch {
    throw new Error(`渠道元数据包含无效 URL：${metadataPath}`)
  }
  if (decoded !== basename(decoded) || decoded === '.' || decoded === '..' || decoded.includes('\0')) {
    throw new Error(`渠道元数据只允许同目录文件名：${metadataPath}`)
  }
  return decoded
}

function channelFromMetadataName(name: string, platform: Platform): string {
  const suffix = platform === 'mac' ? '-mac.yml' : '.yml'
  const channel = name.slice(0, -suffix.length)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(channel)) throw new Error(`无效渠道文件名：${name}`)
  return channel
}

function payloadFor(kind: PayloadKind, localPath: string, objectName: string): ReleasePayload {
  const extension = extname(objectName).toLowerCase()
  return {
    kind,
    localPath,
    objectKey: `${RELEASE_PREFIX}/${objectName}`,
    size: statSync(localPath).size,
    sha512: digest(localPath),
    contentType: kind === 'metadata'
      ? 'application/yaml; charset=utf-8'
      : extension === '.zip' ? 'application/zip' : 'application/octet-stream',
    cacheControl: kind === 'metadata'
      ? 'no-cache, max-age=0, must-revalidate'
      : 'public, max-age=31536000, immutable',
  }
}

function addPayload(payloads: Map<string, ReleasePayload>, payload: ReleasePayload): void {
  const existing = payloads.get(payload.objectKey)
  if (existing !== undefined && existing.sha512 !== payload.sha512) {
    throw new Error(`多个发布目录给出同名不同内容对象：${payload.objectKey}`)
  }
  payloads.set(payload.objectKey, payload)
}

function digest(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function onlyValue(values: Set<string>, label: string): string {
  const value = values.values().next().value
  if (typeof value !== 'string') throw new Error(`未找到${label}。`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function parseCli(argv: readonly string[], currentVersion: string): CliOptions {
  const directories: string[] = []
  let allowCurrentBaseline = false
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      continue
    } else if (argument === '--dir') {
      const directory = argv[index + 1]
      if (directory === undefined) throw new Error('--dir 后必须提供发布目录。')
      directories.push(directory)
      index += 1
    } else if (argument === '--allow-current-baseline') {
      allowCurrentBaseline = true
    } else if (argument === '--dry-run') {
      dryRun = true
    } else {
      throw new Error(`未知参数：${String(argument)}`)
    }
  }
  return { directories, allowCurrentBaseline, dryRun, currentVersion }
}

async function verifyPublicMetadata(payload: ReleasePayload): Promise<void> {
  const url = new URL(`/${payload.objectKey}`, PUBLIC_ORIGIN)
  url.searchParams.set('published', String(Date.now()))
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`公网渠道清单不可读：${url.origin}${url.pathname} (${String(response.status)})`)
  const actual = Buffer.from(await response.arrayBuffer())
  const expected = readFileSync(payload.localPath)
  if (!actual.equals(expected)) throw new Error(`公网渠道清单与本地不一致：${url.origin}${url.pathname}`)
  console.log(`公网校验通过：${url.origin}${url.pathname}`)
}

async function main(): Promise<void> {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const packageValue: unknown = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
  if (!isRecord(packageValue) || typeof packageValue.version !== 'string') {
    throw new Error('Desktop package.json 缺少 version。')
  }
  const options = parseCli(process.argv.slice(2), packageValue.version)
  const bundle = collectReleaseBundle(options.directories, options)
  console.log(`发布校验通过：channel=${bundle.channel} version=${bundle.version} files=${String(bundle.payloads.length)}`)
  if (options.dryRun) return
  const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET
  if (accessKeyId === undefined || accessKeySecret === undefined) {
    throw new Error('缺少 ALIYUN_OSS_ACCESS_KEY_ID 或 ALIYUN_OSS_ACCESS_KEY_SECRET。')
  }
  const store = new AliyunReleaseStore(accessKeyId, accessKeySecret)
  await publishReleaseBundle(bundle, store, verifyPublicMetadata)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
