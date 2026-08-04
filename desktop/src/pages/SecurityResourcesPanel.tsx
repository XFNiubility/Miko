import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, MessageSquare, Plus, RefreshCw, Save, Search, Trash2, Upload, X } from 'lucide-react'
import { useSecurityStore } from '../stores/securityStore'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { selectNativeFileAttachments } from '../lib/composerAttachments'
import { sessionsApi } from '../api/sessions'
import type { SessionListItem } from '../types/session'
import type { ResourceExtraction, ResourceReference, SecurityResource, SecurityResourceInput, SecurityResourceKind, SecurityResourceMeta, SecurityResourceUploadFile } from '../api/security'
import { buildSecurityResourcePresentation } from './securityResourcePresentation'

const KIND_LABEL: Record<SecurityResourceKind, string> = {
  asset_note: '资产清单',
  scope_policy: '范围约束',
  recon_result: '信息收集',
  credential_note: '账号环境',
  manual_note: '手动备注',
  report_import: '报告导入',
}

const KIND_OPTIONS = Object.entries(KIND_LABEL) as Array<[SecurityResourceKind, string]>

const EXTRACTION_STATUS_LABEL: Partial<Record<ResourceExtraction['status'], string>> = {
  idle: '未提取',
  running: '提取中',
  waiting_for_permission: '等待授权',
  done: '已提取',
  failed: '提取失败',
}

const REFERENCE_TYPE_LABEL: Record<ResourceReference['type'], string> = {
  local_file: '本地文件',
  local_directory: '本地目录',
  url: 'URL',
  git_repo: 'Git 仓库',
  domain: '域名',
  ip: 'IP',
  note: '备注',
}

const REFERENCE_STATUS_LABEL: Record<ResourceReference['permissionStatus'], string> = {
  not_required: '无需授权',
  pending: '待授权',
  allowed: '已授权',
  denied: '已忽略',
  failed: '读取失败',
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDateTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function tagText(tags: string[]): string {
  return tags.join(', ')
}

function parseTags(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.includes(',') ? result.split(',').pop() ?? '' : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取文件：${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function browserFilesToUploadFiles(fileList: FileList | File[]): Promise<SecurityResourceUploadFile[]> {
  const files = Array.from(fileList)
  return Promise.all(files.map(async (file) => ({
    name: file.name,
    dataBase64: await readFileAsBase64(file),
    mimeType: file.type || undefined,
    size: file.size,
  })))
}

function SessionExtractDialog({
  open,
  sessions,
  selectedIds,
  loading,
  busy,
  error,
  onToggle,
  onRefresh,
  onCancel,
  onConfirm,
}: {
  open: boolean
  sessions: SessionListItem[]
  selectedIds: string[]
  loading: boolean
  busy: boolean
  error: string | null
  onToggle: (sessionId: string) => void
  onRefresh: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <div className="flex max-h-[min(720px,90vh)] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">从会话提取资源</div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">选择历史会话，将其中的用户输入、助手结论整理成一份可复用资源。</div>
          </div>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="px-3 py-10 text-center text-sm text-[var(--color-text-tertiary)]">加载会话中...</div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-[var(--color-text-tertiary)]">暂无可提取的历史会话</div>
          ) : (
            <div className="space-y-1.5">
              {sessions.map((session) => {
                const checked = selectedIds.includes(session.id)
                return (
                  <button
                    key={session.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onToggle(session.id)}
                    className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${checked ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/8' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'} disabled:opacity-60`}
                  >
                    <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--color-border)]'}`}>
                      {checked && <span className="material-symbols-outlined text-[13px]">check</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{session.title}</span>
                      <span className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--color-text-tertiary)]">
                        <span>{session.messageCount} 条消息</span>
                        <span>{formatDateTime(session.modifiedAt)}</span>
                        {session.workDir && <span className="max-w-full truncate font-mono">{session.workDir}</span>}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {error && <div className="border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-error)]">{error}</div>}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] p-3">
          <button type="button" onClick={onRefresh} disabled={loading || busy} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button>
            <button type="button" disabled={busy || selectedIds.length === 0} onClick={onConfirm} className="rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40">生成资源</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ResourceForm({
  resource,
  busy,
  onCancel,
  onSubmit,
}: {
  resource?: SecurityResource | null
  busy: boolean
  onCancel: () => void
  onSubmit: (data: SecurityResourceInput) => void
}) {
  const [title, setTitle] = useState(resource?.meta.title ?? '')
  const [kind, setKind] = useState<SecurityResourceKind>(resource?.meta.kind ?? 'manual_note')
  const [tags, setTags] = useState(resource ? tagText(resource.meta.tags) : '')
  const [summary, setSummary] = useState(resource?.meta.summary ?? '')
  const [content, setContent] = useState(resource?.content ?? '')
  const canSubmit = title.trim().length > 0 && !busy

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">{resource ? '编辑资源' : '新增资源'}</div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm outline-none focus:border-[var(--color-border-focus)]"
            placeholder="例如：目标资产清单"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">类型</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as SecurityResourceKind)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm outline-none focus:border-[var(--color-border-focus)]"
          >
            {KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">标签</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm outline-none focus:border-[var(--color-border-focus)]"
            placeholder="asset, recon, prod"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">摘要</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            className="min-h-[82px] w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm outline-none focus:border-[var(--color-border-focus)]"
            placeholder="这份资源会作为会话上下文摘要提供给 agent"
          />
        </label>
        <label className="flex min-h-[220px] flex-1 flex-col space-y-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">正文</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-[220px] flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-[var(--color-border-focus)]"
            placeholder="可填写 Markdown、目标范围、历史信息收集结果、账号环境说明等"
          />
        </label>
      </div>
      <div className="flex gap-2 border-t border-[var(--color-border)] p-4">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit({ title: title.trim(), kind, tags: parseTags(tags), summary, content })}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          <Save className="h-4 w-4" />
          保存
        </button>
      </div>
    </div>
  )
}

function ResourceListItem({
  resource,
  active,
  onClick,
}: {
  resource: SecurityResourceMeta
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/8'
          : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{resource.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            <span className="rounded bg-[var(--color-surface-container-high)] px-1.5 py-0.5">{KIND_LABEL[resource.kind]}</span>
            <span>{formatTime(resource.updatedAt)}</span>
          </div>
          {resource.summary && <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-text-secondary)]">{resource.summary}</div>}
        </div>
      </div>
    </button>
  )
}

function ResourceProcessBanner({
  extraction,
  pendingCount,
}: {
  extraction: ResourceExtraction | null
  pendingCount: number
}) {
  const status = extraction?.status ?? 'idle'
  if (status === 'idle') return null
  const label = status === 'queued'
    ? '等待整理资源内容'
    : status === 'running'
      ? '正在整理资源内容'
      : status === 'waiting_for_permission'
        ? `发现 ${pendingCount} 个需要授权读取的引用`
        : status === 'done'
          ? '资源已准备好'
          : '资源提取失败'
  const tone = status === 'failed'
    ? 'border-[var(--color-error)]/30 bg-[var(--color-error-container)] text-[var(--color-error)]'
    : status === 'waiting_for_permission'
      ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning-container)] text-[var(--color-warning)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)]'
  return (
    <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        {(status === 'queued' || status === 'running') && <RefreshCw className="h-4 w-4 animate-spin" />}
        <span className="font-medium">{label}</span>
      </div>
      {extraction?.error && <div className="mt-1 text-xs">{extraction.error}</div>}
    </div>
  )
}

function ExtractionSection({
  extraction,
  busy,
  onRun,
}: {
  extraction: ResourceExtraction | null
  busy: boolean
  onRun: () => void
}) {
  const status = extraction?.status ?? 'idle'
  return (
    <section className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">AI 提取</h3>
          <div className="mt-1 text-sm font-medium text-[var(--color-text-primary)]">{EXTRACTION_STATUS_LABEL[status] ?? status}</div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onRun}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${status === 'running' ? 'animate-spin' : ''}`} />
          重新提取
        </button>
      </div>
      {extraction?.summary ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">{extraction.summary}</p>
      ) : (
        <p className="text-sm text-[var(--color-text-tertiary)]">保存资源后会自动提取；也可以手动重新提取。</p>
      )}
      {extraction?.content && (
        <div className="mt-4">
          <h4 className="mb-2 text-xs font-semibold text-[var(--color-text-tertiary)]">整理后的前置资源</h4>
          <pre className="whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
            {extraction.content}
          </pre>
        </div>
      )}
      {extraction?.items && extraction.items.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {extraction.items.slice(0, 8).map((item, index) => (
            <div key={`${item.type}-${item.value}-${index}`} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="rounded bg-[var(--color-surface-container-high)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">{item.type || 'item'}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">{item.value}</span>
              </div>
              {item.description && <div className="mt-1 line-clamp-2 text-[var(--color-text-secondary)]">{item.description}</div>}
            </div>
          ))}
        </div>
      )}
      {extraction?.warnings && extraction.warnings.length > 0 && (
        <div className="mt-3 rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-warning)]">
          {extraction.warnings.join('；')}
        </div>
      )}
      {extraction?.error && <div className="mt-3 text-xs text-[var(--color-error)]">{extraction.error}</div>}
    </section>
  )
}

function ReferencesSection({
  references,
  busy,
  onAllow,
  onDeny,
  onRead,
}: {
  references: ResourceReference[]
  busy: boolean
  onAllow: (referenceId: string) => void
  onDeny: (referenceId: string) => void
  onRead: (referenceId: string) => void
}) {
  if (references.length === 0) return null
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">资源引用</h3>
      <div className="space-y-1.5">
        {references.map((reference) => (
          <div key={reference.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-[var(--color-surface-container-high)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                    {REFERENCE_TYPE_LABEL[reference.type]}
                  </span>
                  <span className="rounded bg-[var(--color-surface-container-high)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                    {REFERENCE_STATUS_LABEL[reference.permissionStatus]}
                  </span>
                </div>
                <div className="mt-1 break-all font-mono text-xs text-[var(--color-text-primary)]">{reference.value}</div>
                {reference.sourceText && <div className="mt-1 line-clamp-2 text-xs text-[var(--color-text-tertiary)]">{reference.sourceText}</div>}
                {reference.lastError && <div className="mt-1 text-xs text-[var(--color-error)]">{reference.lastError}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                {reference.permissionStatus === 'pending' && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onAllow(reference.id)}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                    >
                      允许
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDeny(reference.id)}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                    >
                      忽略
                    </button>
                  </>
                )}
                {reference.permissionStatus === 'allowed' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRead(reference.id)}
                    className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    读取
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ResourceDetail({
  resource,
  extraction,
  references,
  loading,
  busy,
  onEdit,
  onDelete,
  onRunExtraction,
  onAllowReference,
  onDenyReference,
  onReadReference,
}: {
  resource: SecurityResource | null
  extraction: ResourceExtraction | null
  references: ResourceReference[]
  loading: boolean
  busy: boolean
  onEdit: () => void
  onDelete: () => void
  onRunExtraction: () => void
  onAllowReference: (referenceId: string) => void
  onDenyReference: (referenceId: string) => void
  onReadReference: (referenceId: string) => void
}) {
  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-tertiary)]">加载中...</div>
  }
  if (!resource) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <FileText className="mb-3 h-8 w-8 text-[var(--color-text-tertiary)]" />
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">选择或新增一份资源</div>
        <div className="mt-1 max-w-sm text-xs leading-5 text-[var(--color-text-tertiary)]">
          资源会关联到会话上下文，普通对话和探索模式都可以读取，但不会直接写入运行时状态。
        </div>
      </div>
    )
  }

  const presentation = buildSecurityResourcePresentation(resource, extraction)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-[var(--color-text-primary)]">{resource.meta.title}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
              <span className="rounded bg-[var(--color-surface-container-high)] px-2 py-1">{KIND_LABEL[resource.meta.kind]}</span>
              <span>更新于 {formatTime(resource.meta.updatedAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
            >
              编辑
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-error)] hover:bg-[var(--color-error-container)] disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              删除
            </button>
          </div>
        </div>
        {resource.meta.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {resource.meta.tags.map((tag) => (
              <span key={tag} className="rounded bg-[var(--color-surface-container-high)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{tag}</span>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <ResourceProcessBanner
          extraction={extraction}
          pendingCount={references.filter((reference) => reference.permissionStatus === 'pending').length}
        />
        <ExtractionSection
          extraction={extraction}
          busy={busy}
          onRun={onRunExtraction}
        />
        <ReferencesSection
          references={references}
          busy={busy}
          onAllow={onAllowReference}
          onDeny={onDenyReference}
          onRead={onReadReference}
        />
        {resource.meta.summary && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">摘要</h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">{resource.meta.summary}</p>
          </section>
        )}
        <details open={resource.meta.sourceType !== 'session_ref'}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">
            {presentation.sourceLabel}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
            {presentation.sourceContent || '暂无内容'}
          </pre>
        </details>
        {resource.files.length > 0 && (
          <section className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">文件</h3>
            <div className="space-y-1.5">
              {resource.files.map((file) => (
                <div key={file.path} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
                  <FileText className="h-4 w-4 text-[var(--color-text-tertiary)]" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export function SecurityResourcesPanel() {
  const {
    resources,
    selectedResourceId,
    selectedResource,
    resourceExtractions,
    resourceReferences,
    isResourcesLoading,
    isResourceDetailLoading,
    isMutating,
    listError,
    detailError,
    fetchResources,
    selectResource,
    clearResourceSelection,
    createResource,
    updateResource,
    deleteResource,
    importResource,
    createResourceFromSession,
    runResourceExtraction,
    updateResourceReference,
    readResourceReference,
  } = useSecurityStore()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SecurityResourceMeta | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const browserFileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void fetchResources()
  }, [fetchResources])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return resources
    return resources.filter((resource) => {
      return [
        resource.title,
        resource.summary,
        KIND_LABEL[resource.kind],
        ...resource.tags,
      ].some((item) => item.toLowerCase().includes(q))
    })
  }, [query, resources])

  async function handleSubmit(data: SecurityResourceInput) {
    if (editing === 'edit' && selectedResourceId) {
      await updateResource(selectedResourceId, data)
    } else {
      await createResource(data)
    }
    setEditing(null)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    await deleteResource(pendingDelete.id)
    setPendingDelete(null)
  }

  async function handleImportFiles() {
    setImportError(null)
    const attachments = await selectNativeFileAttachments()
    if (!attachments) {
      browserFileInputRef.current?.click()
      return
    }
    const paths = attachments.map((attachment) => attachment.path).filter((path): path is string => Boolean(path))
    if (paths.length === 0) return
    const importedId = await importResource({
      paths,
      kind: paths.length === 1 ? 'report_import' : 'recon_result',
      tags: ['import'],
    })
    if (importedId) setEditing(null)
  }

  async function handleBrowserFileSelect(files: FileList | null) {
    setImportError(null)
    if (!files || files.length === 0) return
    try {
      const uploadedFiles = await browserFilesToUploadFiles(files)
      const importedId = await importResource({
        files: uploadedFiles,
        kind: uploadedFiles.length === 1 ? 'report_import' : 'recon_result',
        tags: ['import'],
      })
      if (importedId) setEditing(null)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    } finally {
      if (browserFileInputRef.current) {
        browserFileInputRef.current.value = ''
      }
    }
  }

  async function loadSessionsForExtract() {
    setSessionsLoading(true)
    setSessionError(null)
    try {
      const result = await sessionsApi.list({ limit: 80 })
      setSessions(result.sessions.filter((session) => session.messageCount > 0))
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSessionsLoading(false)
    }
  }

  function openSessionExtractDialog() {
    setSessionDialogOpen(true)
    setSelectedSessionIds([])
    void loadSessionsForExtract()
  }

  function toggleSessionForExtract(sessionId: string) {
    setSelectedSessionIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId])
  }

  async function confirmSessionExtract() {
    if (selectedSessionIds.length === 0) return
    setSessionError(null)
    const createdId = await createResourceFromSession({
      sessionIds: selectedSessionIds,
      kind: 'recon_result',
      tags: ['session'],
    })
    if (createdId) {
      setSessionDialogOpen(false)
      setSelectedSessionIds([])
      setEditing(null)
    }
  }

  const showForm = editing !== null
  const selectedExtraction = selectedResourceId ? resourceExtractions[selectedResourceId] ?? null : null
  const selectedReferences = selectedResourceId ? resourceReferences[selectedResourceId] ?? [] : []

  function handleRunExtraction() {
    if (selectedResourceId) void runResourceExtraction(selectedResourceId)
  }

  function handleAllowReference(referenceId: string) {
    if (selectedResourceId) void readResourceReference(selectedResourceId, referenceId)
  }

  function handleDenyReference(referenceId: string) {
    if (selectedResourceId) void updateResourceReference(selectedResourceId, referenceId, 'denied')
  }

  function handleReadReference(referenceId: string) {
    if (selectedResourceId) void readResourceReference(selectedResourceId, referenceId)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="border-b border-[var(--color-border)] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">资源</div>
              <div className="text-xs text-[var(--color-text-tertiary)]">{resources.length} 份会话上下文资料</div>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void handleImportFiles()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                title="导入文件"
              >
                <Upload className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={openSessionExtractDialog}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                title="从会话提取"
              >
                <MessageSquare className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => { clearResourceSelection(); setEditing('new') }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-brand)] text-white"
                title="新增资源"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-text-tertiary)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-3 text-sm outline-none focus:border-[var(--color-border-focus)]"
              placeholder="搜索资源"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isResourcesLoading ? (
            <div className="px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">暂无资源</div>
          ) : (
            <div className="space-y-1">
              {filtered.map((resource) => (
                <ResourceListItem
                  key={resource.id}
                  resource={resource}
                  active={selectedResourceId === resource.id}
                  onClick={() => { setEditing(null); void selectResource(resource.id) }}
                />
              ))}
            </div>
          )}
        </div>
        {(listError || importError) && <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-error)]">{listError || importError}</div>}
      </aside>

      <main className="flex min-w-0 flex-1 self-stretch">
        {showForm ? (
          <ResourceForm
            resource={editing === 'edit' ? selectedResource : null}
            busy={isMutating}
            onCancel={() => setEditing(null)}
            onSubmit={handleSubmit}
          />
        ) : (
          <ResourceDetail
            resource={selectedResource}
            extraction={selectedExtraction}
            references={selectedReferences}
            loading={isResourceDetailLoading}
            busy={isMutating}
            onEdit={() => setEditing('edit')}
            onDelete={() => {
                if (selectedResource) setPendingDelete(selectedResource.meta)
              }}
            onRunExtraction={handleRunExtraction}
            onAllowReference={handleAllowReference}
            onDenyReference={handleDenyReference}
            onReadReference={handleReadReference}
          />
        )}
      </main>

      <input
        ref={browserFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void handleBrowserFileSelect(event.currentTarget.files)}
      />

      {detailError && (
        <div className="pointer-events-none absolute bottom-4 right-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-error)] shadow-lg">
          {detailError}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="删除资源"
        body={`确定删除“${pendingDelete?.title ?? ''}”？已关联该资源的会话会保留 ID，但上下文注入会自动跳过缺失资源。`}
        confirmLabel="删除"
        cancelLabel="取消"
        confirmVariant="danger"
        loading={isMutating}
      />
      <SessionExtractDialog
        open={sessionDialogOpen}
        sessions={sessions}
        selectedIds={selectedSessionIds}
        loading={sessionsLoading}
        busy={isMutating}
        error={sessionError || listError}
        onToggle={toggleSessionForExtract}
        onRefresh={loadSessionsForExtract}
        onCancel={() => setSessionDialogOpen(false)}
        onConfirm={confirmSessionExtract}
      />
    </div>
  )
}
