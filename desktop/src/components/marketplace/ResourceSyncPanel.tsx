import { useEffect } from 'react'
import { Button } from '../shared/Button'
import { useTranslation } from '../../i18n'
import { useResourceUpdateStore } from '../../stores/resourceUpdateStore'
import { useUIStore } from '../../stores/uiStore'
import type { ResourceUpdateStatus } from '../../types/resourceUpdate'

export function ResourceSyncPanel({
  onCatalogChanged,
}: {
  onCatalogChanged: () => Promise<void>
}) {
  const {
    manifest,
    status,
    isLoading,
    isRefreshing,
    isApplying,
    isRollingBack,
    error,
    fetchStatus,
    refreshManifest,
    applyUpdates,
    rollbackUpdates,
  } = useResourceUpdateStore()
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const effectiveManifest = status?.manifest ?? manifest
  const resources = effectiveManifest?.resources ?? []
  const hasResources = resources.length > 0
  const canRollback = status?.state === 'applied' || status?.state === 'error'

  const runRefresh = async () => {
    try {
      await refreshManifest()
      addToast({ type: 'success', message: t('settings.marketplace.resourceSync.toastRefreshed') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const runApply = async () => {
    try {
      await applyUpdates()
      await onCatalogChanged()
      addToast({ type: 'success', message: t('settings.marketplace.resourceSync.toastApplied') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const runRollback = async () => {
    try {
      await rollbackUpdates()
      await onCatalogChanged()
      addToast({ type: 'success', message: t('settings.marketplace.resourceSync.toastRolledBack') })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <section className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-[var(--color-brand)]">
              sync_saved_locally
            </span>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.marketplace.resourceSync.title')}
            </h3>
            <StatePill state={status?.state ?? 'idle'} />
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.marketplace.resourceSync.description')}
          </p>
          {error && (
            <p className="mt-2 text-xs leading-5 text-[var(--color-error)]">
              {error}
            </p>
          )}
          {status?.error && (
            <p className="mt-2 text-xs leading-5 text-[var(--color-error)]">
              {status.error}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="min-h-9"
            loading={isRefreshing}
            disabled={isLoading || isApplying || isRollingBack}
            onClick={() => void runRefresh()}
          >
            <span className="material-symbols-outlined text-[16px]">cloud_sync</span>
            {t('settings.marketplace.resourceSync.refresh')}
          </Button>
          <Button
            size="sm"
            className="min-h-9"
            loading={isApplying}
            disabled={isLoading || isRefreshing || isRollingBack || !hasResources}
            onClick={() => void runApply()}
          >
            <span className="material-symbols-outlined text-[16px]">system_update_alt</span>
            {t('settings.marketplace.resourceSync.apply')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="min-h-9"
            loading={isRollingBack}
            disabled={isLoading || isRefreshing || isApplying || !canRollback}
            onClick={() => void runRollback()}
          >
            <span className="material-symbols-outlined text-[16px]">history</span>
            {t('settings.marketplace.resourceSync.rollback')}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <SyncMetric
          label={t('settings.marketplace.resourceSync.source')}
          value={t(`settings.marketplace.resourceSync.source.${effectiveManifest?.source ?? 'empty'}`)}
        />
        <SyncMetric
          label={t('settings.marketplace.resourceSync.resources')}
          value={String(resources.length)}
        />
        <SyncMetric
          label={t('settings.marketplace.resourceSync.version')}
          value={effectiveManifest?.latestVersion || effectiveManifest?.bundledDataVersion || '-'}
        />
        <SyncMetric
          label={t('settings.marketplace.resourceSync.updatedAt')}
          value={formatTime(status?.updatedAt ?? effectiveManifest?.generatedAt)}
        />
      </div>

      {resources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {resources.map((resource) => (
            <span
              key={resource.id}
              className="rounded-md bg-[var(--color-surface)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-tertiary)]"
            >
              {t(`settings.marketplace.resourceSync.type.${resource.type}`)} · {resource.id} · v{resource.version}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function StatePill({ state }: { state: ResourceUpdateStatus['state'] }) {
  const t = useTranslation()
  const tone =
    state === 'applied' || state === 'rolled-back'
      ? 'success'
      : state === 'error'
        ? 'error'
        : state === 'applying'
          ? 'warning'
          : 'muted'
  const classes =
    tone === 'success'
      ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
      : tone === 'error'
        ? 'bg-[var(--color-error-container)] text-[var(--color-error)]'
        : tone === 'warning'
          ? 'bg-[var(--color-warning-container)] text-[var(--color-warning)]'
          : 'bg-[var(--color-surface)] text-[var(--color-text-tertiary)]'

  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${classes}`}>
      {t(`settings.marketplace.resourceSync.state.${state}`)}
    </span>
  )
}

function SyncMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">
        {value}
      </div>
    </div>
  )
}

function formatTime(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
