/** 输入框附件的前端草稿与纯函数。真正落盘只走后端 `attachment.put`。 */

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'error'

export interface ComposerAttachment {
  localId: string
  name: string
  mime: string
  size: number
  previewUrl?: string
  status: ComposerAttachmentStatus
  attachmentId?: string
  error?: string
}

export interface FileMeta {
  name: string
  mime: string
  size: number
}

export interface ReferenceEntry {
  name: string
  dir: boolean
}

export interface FileListing {
  path: string
  parent?: string
  entries: ReferenceEntry[]
}

/** 后端不接受的文件在选中的那一刻就说明原因，不等到发送时才失败。 */
export function attachmentProblem(file: FileMeta): string | undefined {
  if (!(IMAGE_MIMES as readonly string[]).includes(file.mime.toLowerCase())) {
    return '目前仅支持 PNG / JPEG / WebP / GIF 图片'
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return '附件超过 10MB，无法上传'
  if (file.size === 0) return '图片内容不能为空'
  return undefined
}

/** 浏览器目录没有 path.join；fs.list 在当前平台统一返回 `/` 分隔路径。 */
export function joinPath(dir: string, name: string): string {
  const base = dir.replace(/[\\/]+$/, '')
  return base === '' ? name : `${base}/${name}`
}

/** 传给模型的是相对工作区路径，不是本机绝对路径。 */
export function relativeToRoot(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '')
  if (path === base) return ''
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

/** 引用文件只插路径，不上传、不改写正文。 */
export function appendReference(value: string, path: string): string {
  if (path === '') return value
  if (value.trim() === '') return path
  return /\s$/.test(value) ? `${value}${path}` : `${value} ${path}`
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : ''
      const comma = raw.indexOf(',')
      resolve(comma === -1 ? '' : raw.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
