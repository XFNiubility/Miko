import { useEffect, useMemo, useState } from 'react'
import { Button } from '../shared/Button'
import { Modal } from '../shared/Modal'
import { useMarketplaceStore, groupMarketplaceResources } from '../../stores/marketplaceStore'
import { useSkillStore } from '../../stores/skillStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import { ResourceSyncPanel } from './ResourceSyncPanel'
import type {
  InstalledMarketplaceResource,
  MarketplaceInstallPreview,
  MarketplaceResource,
  MarketplaceResourceType,
} from '../../types/marketplace'

const RESOURCE_ICON: Record<MarketplaceResourceType, string> = {
  skill: 'auto_awesome',
  mcp: 'dns',
  tool: 'build',
  agent: 'smart_toy',
}

export function MarketplaceSettings() {
  const {
    catalog,
    installed,
    isLoading,
    isApplying,
    activeOperationId,
    error,
    previewResource,
    fetchMarketplace,
    refreshRemoteCatalog,
    installResource,
    uninstallResource,
    enableResource,
    disableResource,
  } = useMarketplaceStore()
  const fetchSkills = useSkillStore((s) => s.fetchSkills)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const [installPreview, setInstallPreview] = useState<MarketplaceInstallPreview | null>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined

  useEffect(() => {
    void fetchMarketplace()
  }, [fetchMarketplace])

  const resources = catalog?.resources ?? []
  const installedMap = installed?.installed ?? {}
  const grouped = useMemo(() => groupMarketplaceResources(resources), [resources])
  const installedCount = Object.keys(installedMap).length
  const enabledCount = Object.values(installedMap).filter((entry) => entry.enabled).length

  const refreshSkillsIfNeeded = async (resource: MarketplaceResource) => {
    if (resource.type === 'skill') {
      await fetchSkills(currentWorkDir)
    }
  }

  const runAction = async (
    resource: MarketplaceResource,
    action: () => Promise<void>,
    successMessage: string,
  ) => {
    try {
      await action()
      await refreshSkillsIfNeeded(resource)
      addToast({ type: 'success', message: successMessage })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const requestInstall = async (resource: MarketplaceResource) => {
    try {
      setInstallPreview(await previewResource(resource.id))
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const confirmInstall = async () => {
    if (!installPreview) return
    const resource = installPreview.resource
    await runAction(
      resource,
      () => installResource(resource.id),
      t(
        installPreview.operation === 'update'
          ? 'settings.marketplace.toastUpdated'
          : 'settings.marketplace.toastInstalled',
        { name: resource.name },
      ),
    )
    setInstallPreview(null)
  }

  if (isLoading && !catalog) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
            {t('settings.marketplace.title')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--color-text-tertiary)]">
            {t('settings.marketplace.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-9 self-start"
          onClick={() => void fetchMarketplace()}
          loading={isLoading}
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
          {t('settings.marketplace.refresh')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-9 self-start"
          onClick={() =>
            void runCatalogRefresh(refreshRemoteCatalog, addToast, t('settings.marketplace.toastRefreshed'))
          }
          loading={isLoading}
        >
          <span className="material-symbols-outlined text-[16px]">cloud_sync</span>
          {t('settings.marketplace.refreshRemote')}
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-[var(--color-error)] bg-[var(--color-error-container)] px-4 py-3 text-sm text-[var(--color-on-error-container)]">
          {error}
        </div>
      )}

      <ResourceSyncPanel onCatalogChanged={fetchMarketplace} />

      <section className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-5">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <SummaryCard
            label={t('settings.marketplace.summary.catalog')}
            value={String(resources.length)}
            icon="storefront"
          />
          <SummaryCard
            label={t('settings.marketplace.summary.installed')}
            value={String(installedCount)}
            icon="download_done"
          />
          <SummaryCard
            label={t('settings.marketplace.summary.enabled')}
            value={String(enabledCount)}
            icon="check_circle"
          />
          <SummaryCard
            label={t('settings.marketplace.summary.source')}
            value={t(`settings.marketplace.source.${catalog?.source ?? 'empty'}`)}
            icon="dataset"
          />
          <SummaryCard
            label={t('settings.marketplace.summary.trustSource')}
            value={t(`settings.marketplace.trustSource.${catalog?.trust?.sourceType ?? 'unknown'}`)}
            icon="policy"
          />
          <SummaryCard
            label={t('settings.marketplace.summary.catalogSignature')}
            value={t(`settings.marketplace.catalogSignature.${catalog?.verification?.signature ?? 'missing'}`)}
            icon="verified_user"
          />
        </div>
      </section>

      {resources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-12 text-center">
          <span className="material-symbols-outlined mb-2 block text-[42px] text-[var(--color-text-tertiary)]">
            storefront
          </span>
          <p className="text-sm font-medium text-[var(--color-text-primary)]">
            {t('settings.marketplace.empty')}
          </p>
          <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.marketplace.emptyHint')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {(['skill', 'mcp', 'tool', 'agent'] as const).map((type) => {
            const items = grouped[type]
            if (items.length === 0) return null

            return (
              <section key={type} className="min-w-0">
                <div className="mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-[var(--color-brand)]">
                    {RESOURCE_ICON[type]}
                  </span>
                  <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    {t(`settings.marketplace.type.${type}`)}
                  </h3>
                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                    {items.length}
                  </span>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {items.map((resource) => (
                    (() => {
                      const installedResource = installedMap[resource.id]
                      return (
                        <MarketplaceResourceCard
                          key={resource.id}
                          resource={resource}
                          installed={installedResource}
                          isApplying={isApplying && activeOperationId === resource.id}
                          onInstall={() => void requestInstall(resource)}
                          onEnable={() =>
                            runAction(
                              resource,
                              () => enableResource(resource.id),
                              t('settings.marketplace.toastEnabled', { name: resource.name }),
                            )
                          }
                          onDisable={() =>
                            runAction(
                              resource,
                              () => disableResource(resource.id),
                              t('settings.marketplace.toastDisabled', { name: resource.name }),
                            )
                          }
                          onUninstall={() =>
                            runAction(
                              resource,
                              () => uninstallResource(resource.id),
                              t('settings.marketplace.toastUninstalled', { name: resource.name }),
                            )
                          }
                        />
                      )
                    })()
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <MarketplaceInstallConfirmModal
        preview={installPreview}
        loading={isApplying && activeOperationId === installPreview?.resource.id}
        onCancel={() => setInstallPreview(null)}
        onConfirm={() => void confirmInstall()}
      />
    </div>
  )
}

async function runCatalogRefresh(
  refreshRemoteCatalog: () => Promise<void>,
  addToast: (toast: { type: 'success' | 'error'; message: string }) => void,
  successMessage: string,
) {
  try {
    await refreshRemoteCatalog()
    addToast({ type: 'success', message: successMessage })
  } catch (err) {
    addToast({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function MarketplaceResourceCard({
  resource,
  installed,
  isApplying,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
}: {
  resource: MarketplaceResource
  installed?: InstalledMarketplaceResource
  isApplying: boolean
  onInstall: () => void
  onEnable: () => void
  onDisable: () => void
  onUninstall: () => void
}) {
  const t = useTranslation()
  const isInstalled = Boolean(installed)
  const isEnabled = installed?.enabled === true
  const isUpdateAvailable = Boolean(installed && installed.version !== resource.version)
  const isRuntimeReady = resource.type === 'skill' || resource.type === 'mcp'
  const permissions = resource.permissions ?? []

  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <span className="material-symbols-outlined text-[19px] text-[var(--color-brand)]">
            {RESOURCE_ICON[resource.type]}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="break-words text-sm font-semibold text-[var(--color-text-primary)]">
              {resource.name}
            </h4>
            <MetaPill>v{resource.version}</MetaPill>
            {isUpdateAvailable && installed && (
              <MetaPill>{t('settings.marketplace.installedVersion', { version: installed.version })}</MetaPill>
            )}
            <MetaPill>{t(`settings.marketplace.type.${resource.type}`)}</MetaPill>
            {resource.category && <MetaPill>{resource.category}</MetaPill>}
          </div>
          <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--color-text-secondary)]">
            {resource.description || t('settings.marketplace.noDescription')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill
          tone={isUpdateAvailable ? 'warning' : isInstalled ? (isEnabled ? 'success' : 'warning') : 'muted'}
          label={
            isUpdateAvailable
              ? t('settings.marketplace.status.updateAvailable')
              : isInstalled
              ? isEnabled
                ? t('settings.marketplace.status.enabled')
                : t('settings.marketplace.status.disabled')
              : t('settings.marketplace.status.notInstalled')
          }
        />
        <StatusPill
          tone={isRuntimeReady ? 'success' : 'muted'}
          label={
            isRuntimeReady
              ? t('settings.marketplace.runtimeReady')
              : t('settings.marketplace.runtimePending')
          }
        />
      </div>

      {permissions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {permissions.map((permission) => (
            <span
              key={permission}
              className="rounded-md bg-[var(--color-surface-container-low)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-tertiary)]"
            >
              {permission}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!isInstalled ? (
          <Button
            size="sm"
            disabled={!isRuntimeReady}
            loading={isApplying}
            onClick={onInstall}
          >
            <span className="material-symbols-outlined text-[15px]">download</span>
            {isRuntimeReady
              ? t('settings.marketplace.install')
              : t('settings.marketplace.installPending')}
          </Button>
        ) : (
          <>
            {isUpdateAvailable && (
              <Button
                size="sm"
                loading={isApplying}
                disabled={!isRuntimeReady}
                onClick={onInstall}
              >
                <span className="material-symbols-outlined text-[15px]">upgrade</span>
                {t('settings.marketplace.update')}
              </Button>
            )}
            {isEnabled ? (
              <Button
                size="sm"
                variant="secondary"
                loading={isApplying}
                onClick={onDisable}
              >
                <span className="material-symbols-outlined text-[15px]">toggle_off</span>
                {t('settings.marketplace.disable')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={isApplying}
                onClick={onEnable}
              >
                <span className="material-symbols-outlined text-[15px]">toggle_on</span>
                {t('settings.marketplace.enable')}
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              loading={isApplying}
              onClick={onUninstall}
            >
              <span className="material-symbols-outlined text-[15px]">delete</span>
              {t('settings.marketplace.uninstall')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined flex-shrink-0 text-[14px]">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 truncate text-lg font-semibold text-[var(--color-text-primary)]">
        {value}
      </div>
    </div>
  )
}

function MetaPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
      {children}
    </span>
  )
}

function StatusPill({
  tone,
  label,
}: {
  tone: 'success' | 'warning' | 'muted'
  label: string
}) {
  const classes =
    tone === 'success'
      ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
      : tone === 'warning'
        ? 'bg-[var(--color-warning-container)] text-[var(--color-warning)]'
        : 'bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]'

  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${classes}`}>
      {label}
    </span>
  )
}

function MarketplaceInstallConfirmModal({
  preview,
  loading,
  onCancel,
  onConfirm,
}: {
  preview: MarketplaceInstallPreview | null
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useTranslation()
  if (!preview) return null

  const resource = preview.resource
  const isMcp = resource.type === 'mcp'
  const title = t(
    preview.operation === 'update'
      ? 'settings.marketplace.confirm.updateTitle'
      : 'settings.marketplace.confirm.installTitle',
    { name: resource.name },
  )

  return (
    <Modal
      open
      title={title}
      width={720}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {t('settings.marketplace.confirm.cancel')}
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={loading}>
            {t(preview.operation === 'update' ? 'settings.marketplace.confirm.update' : 'settings.marketplace.confirm.install')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {t(`settings.marketplace.confirm.description.${resource.type}`)}
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <ConfirmField label={t('settings.marketplace.confirm.type')} value={t(`settings.marketplace.type.${resource.type}`)} />
          <ConfirmField label={t('settings.marketplace.confirm.version')} value={`v${resource.version}`} />
          <ConfirmField label={t('settings.marketplace.confirm.sha256')} value={t(`settings.marketplace.confirm.verification.${preview.verification.sha256}`)} />
          <ConfirmField label={t('settings.marketplace.confirm.signature')} value={t(`settings.marketplace.confirm.verification.${preview.verification.signature}`)} />
        </div>

        {preview.permissions.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {t('settings.marketplace.confirm.permissions')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preview.permissions.map((permission) => (
                <span
                  key={permission}
                  className="rounded-md bg-[var(--color-surface-container-low)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-tertiary)]"
                >
                  {permission}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {t('settings.marketplace.confirm.writes')}
          </div>
          <div className="space-y-1">
            {preview.writes.map((write) => (
              <div
                key={write}
                className="rounded-md bg-[var(--color-surface-container-low)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]"
              >
                {write}
              </div>
            ))}
          </div>
        </div>

        {isMcp && (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {t('settings.marketplace.confirm.mcpServers')}
            </div>
            {preview.mcpServers && preview.mcpServers.length > 0 ? (
              <div className="space-y-2">
                {preview.mcpServers.map((server) => (
                  <div
                    key={server.name}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                        {server.name}
                      </span>
                      <MetaPill>{server.type}</MetaPill>
                    </div>
                    <McpDetailRow label={t('settings.marketplace.confirm.command')} value={server.command} />
                    <McpDetailRow label={t('settings.marketplace.confirm.args')} value={server.args?.join(' ')} />
                    <McpDetailRow label={t('settings.marketplace.confirm.envKeys')} value={server.envKeys?.join(', ')} />
                    <McpDetailRow label={t('settings.marketplace.confirm.url')} value={server.url} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('settings.marketplace.confirm.mcpPreviewUnavailable')}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ConfirmField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-3">
      <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">
        {value}
      </div>
    </div>
  )
}

function McpDetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="mt-2 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 overflow-hidden text-ellipsis rounded-md bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
        {value}
      </div>
    </div>
  )
}
