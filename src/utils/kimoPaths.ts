/**
 * kimo Paths — 中心路径模块
 *
 * 所有用户数据的「唯一真相源」。
 * 原则：data/ 是用户持久数据根；官方内置资源走 bundled-data/，缓存/运行时可走独立缓存根。
 *
 * 路径优先级：
 *   1. setDataDir(dir) 显式设置
 *   2. KIMO_DATA_ROOT 环境变量（用户数据根）
 *   3. KIMO_DATA_DIR 环境变量（legacy，自动追加 /data）
 *   4. CLAUDE_CONFIG_DIR 环境变量（legacy）
 *   5. exe 所在目录/data（生产兜底）
 *   6. cwd/data（开发回退）
 *
 * data/ 目录结构：
 *   skills/          技能
 *   agents/          Agent 定义
 *   commands/        命令
 *   workflows/       工作流
 *   output-styles/   输出样式
 *   rules/           规则
 *   mcp.json         MCP 服务器配置
 *   settings.json    全部设置
 *   providers.json   提供商列表
 *   oauth.json       OAuth 令牌
 *   desktop-ui.json  桌面端 UI 偏好
 *   keybindings.json 快捷键
 *   projects/        会话历史
 *   plugins/         插件
 *   cache/           缓存（legacy；新代码优先 getCacheRootDir()/cache）
 *   history.jsonl    全局历史
 *   plans/           计划文件
 *   file-history/    文件编辑历史
 *   scheduled_tasks.json 定时任务
 *   adapters.json    IM 适配器配置
 *   uploads/         上传附件
 *   backup/          配置备份
 *   runtime/         Python venv 等运行时
 *   .lock/           并发锁
 *   debug/           调试日志
 *   chrome/          Claude in Chrome
 *   telemetry/       遥测（可选）
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize, resolve } from 'path'
import { isInBundledMode } from './bundledMode.js'

// ─── data/ 根目录 ─────────────────────────────────────────────────────

let _dataDir: string | null = null

export function setDataDir(dir: string): void {
  _dataDir = dir
}

export function resetDataDirForTests(): void {
  _dataDir = null
}

/**
 * 获取 data/ 根目录（唯一真相源）。
 *
 * 核心规则：解析出来的就是"数据目录本身"——包含 settings.json / projects/ /
 * security/ 的那一层。任何分支都不得二次追加子目录，调用方也不得在外面再拼。
 *
 * 路径优先级：
 *   1. setDataDir(dir)        显式设置（测试 / 编程调用），原样
 *   2. KIMO_DATA_ROOT         主变量，直接指数据目录，原样（不追加 /data）
 *   3. KIMO_DATA_DIR          legacy：指应用根，自动追加 /data（bin/kimo、adapters 兼容）
 *   4. CLAUDE_CONFIG_DIR      legacy：可移植目录，原样（打包桌面端、测试兼容）
 *   5. 打包模式               exe 所在目录/data（process.execPath 是 kimo 二进制本身）
 *   6. 开发模式               cwd/data（bun 运行源码时 execPath 是 bun.exe，
 *                             绝不能用它的目录，否则数据会写进 bun 安装目录）
 *
 * 注意：第 5 条仅在 Bun 编译的独立二进制（isInBundledMode）下成立。
 * KIMO_DATA_ROOT vs KIMO_DATA_DIR 的区别是历史教训：前者直接指数据目录，
 * 后者会 +/data。两者喂同一路径会落到不同目录，曾导致会话数据分裂。
 * 新代码与启动器一律优先用 KIMO_DATA_ROOT。
 */
export function getDataDir(): string {
  if (_dataDir) return _dataDir
  return resolveDataDirFromEnv(process.env)
}

/**
 * 纯函数：按给定 env 解析数据根，逻辑与 getDataDir() 完全一致（不含 setDataDir 覆盖）。
 * 抽出来是为了让启动自检能算出"CLI 子进程拿到这份 env 会解析到哪个根"，
 * 与 server 自身解析结果对比，零逻辑漂移。
 */
export function resolveDataDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.KIMO_DATA_ROOT) return env.KIMO_DATA_ROOT
  if (env.KIMO_DATA_DIR) return join(env.KIMO_DATA_DIR, 'data')
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR
  // 打包模式：process.execPath 是 kimo 独立二进制，其目录旁的 data/ 才是数据根
  if (isInBundledMode()) {
    try {
      return join(dirname(process.execPath), 'data')
    } catch {
      // ignore，落到开发回退
    }
  }
  // 开发模式：用 bun 运行源码，execPath 是 bun.exe，只能回退到当前工作目录
  return join(process.cwd(), 'data')
}

/**
 * 返回当前 data 根的解析来源（用于启动日志 / 自检）。
 * 不读 _dataDir 之外的副作用，纯判定优先级命中了哪条。
 */
export function getDataDirSource(): string {
  if (_dataDir) return 'setDataDir()'
  if (process.env.KIMO_DATA_ROOT) return 'KIMO_DATA_ROOT'
  if (process.env.KIMO_DATA_DIR) return 'KIMO_DATA_DIR(+/data)'
  if (process.env.CLAUDE_CONFIG_DIR) return 'CLAUDE_CONFIG_DIR'
  if (isInBundledMode()) return 'bundled-execPath'
  return 'cwd/data(dev)'
}

// ─── 官方内置资源 / 缓存 / 工作区根 ────────────────────────────────────

export function getBundledDataDir(): string {
  const envDir = process.env.KIMO_BUNDLED_DATA_ROOT
  if (envDir && envDir.trim()) return envDir.trim()

  if (isInBundledMode()) {
    try {
      return join(dirname(process.execPath), 'bundled-data')
    } catch {
      // ignore，落到开发回退
    }
  }

  return join(process.cwd(), 'bundled-data')
}

function getBundledSubDir(name: string, envName: string, userFallback: string): string {
  const envDir = process.env[envName]
  if (envDir && envDir.trim()) return envDir.trim()

  const bundledRoot = process.env.KIMO_BUNDLED_DATA_ROOT
  if (bundledRoot && bundledRoot.trim()) {
    const candidate = join(bundledRoot.trim(), name)
    return existsSync(candidate) ? candidate : userFallback
  }

  // 开发态第一阶段不强制搬目录，继续回退到当前 data/<resource>。
  if (!isInBundledMode()) return userFallback

  const candidate = join(getBundledDataDir(), name)
  return existsSync(candidate) ? candidate : userFallback
}

export function getBuiltinSkillsDir(): string {
  return getBundledSubDir('skills', 'KIMO_BUILTIN_SKILLS_DIR', getSkillsDir())
}

export function getBuiltinAgentsDir(): string {
  return getBundledSubDir('agents', 'KIMO_BUILTIN_AGENTS_DIR', getAgentsDir())
}

export function getMcpTemplatesDir(): string {
  return join(getBundledDataDir(), 'mcp-templates')
}

export function getMarketplaceDir(): string {
  return getSubDir('marketplace')
}

export function getMarketplaceInstalledFile(): string {
  return join(getMarketplaceDir(), 'installed.json')
}

export function getMarketplaceCatalogCacheFile(): string {
  return join(getMarketplaceDir(), 'catalog-cache.json')
}

export function getMarketplaceLocalCatalogFile(): string {
  return join(getMarketplaceDir(), 'catalog.local.json')
}

export function getBundledMarketplaceDir(): string {
  return join(getBundledDataDir(), 'marketplace')
}

export function getBundledMarketplaceLocalCatalogFile(): string {
  return join(getBundledMarketplaceDir(), 'catalog.local.json')
}

export function getMarketplacePackagesDir(): string {
  return join(getMarketplaceDir(), 'packages')
}

export function getUpdatesDir(): string {
  return getSubDir('updates')
}

export function getLocalUpdateManifestFile(): string {
  return join(getUpdatesDir(), 'update.local.json')
}

export function getUpdateManifestCacheFile(): string {
  return join(getUpdatesDir(), 'manifest-cache.json')
}

export function getCacheRootDir(): string {
  const envDir = process.env.KIMO_CACHE_ROOT
  if (envDir && envDir.trim()) return envDir.trim()
  return getDataDir()
}

export function getDefaultWorkspaceDir(): string {
  const configuredDir = getConfiguredDefaultWorkspaceDir()
  if (configuredDir) return configuredDir

  const envDir = process.env.KIMO_WORKSPACE_ROOT
  if (envDir && envDir.trim()) return envDir.trim()
  return join(dirname(getDataDir()), 'mikospace')
}

export function getConfiguredDefaultWorkspaceDir(): string | null {
  try {
    const raw = readFileSync(getSettingsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { defaultWorkspaceDir?: unknown }
    return normalizeDefaultWorkspaceDir(parsed.defaultWorkspaceDir)
  } catch {
    return null
  }
}

function normalizeDefaultWorkspaceDir(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  if (trimmed === '~') return normalize(homedir()).normalize('NFC')
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2)).normalize('NFC')
  }

  return (isAbsolute(trimmed) ? normalize(trimmed) : resolve(dirname(getDataDir()), trimmed)).normalize('NFC')
}

// ─── 通用子目录 ─────────────────────────────────────────────────────────

export function getSubDir(name: string): string {
  return join(getDataDir(), name)
}

// ─── 数据目录 ──────────────────────────────────────────────────────────

export function getSkillsDir(): string {
  return getSubDir('skills')
}

export function getAgentsDir(): string {
  return getSubDir('agents')
}

export function getCommandsDir(): string {
  return getSubDir('commands')
}

export function getWorkflowsDir(): string {
  return getSubDir('workflows')
}

export function getOutputStylesDir(): string {
  return getSubDir('output-styles')
}

export function getRulesDir(): string {
  return getSubDir('rules')
}

export function getAgentMemoryDir(): string {
  return getSubDir('agent-memory')
}

export function getWorktreesDir(): string {
  return getSubDir('worktrees')
}

export function getProjectsDir(): string {
  return getSubDir('projects')
}

export function getPluginsDir(): string {
  return getSubDir('plugins')
}

export function getCacheDir(): string {
  return join(getCacheRootDir(), 'cache')
}

export function getPlansDir(): string {
  return getSubDir('plans')
}

export function getFileHistoryDir(): string {
  return getSubDir('file-history')
}

export function getUploadsDir(): string {
  return getSubDir('uploads')
}

export function getRuntimeDir(): string {
  return join(getCacheRootDir(), 'runtime')
}

export function getBackupDir(): string {
  return getSubDir('backup')
}

export function getLockDir(): string {
  return getSubDir('.lock')
}

export function getDebugDir(): string {
  return join(getCacheRootDir(), 'debug')
}

export function getChromeDir(): string {
  return join(getCacheRootDir(), 'chrome')
}

// ─── 配置文件（文件路径） ───────────────────────────────────────────────

export function getMcpFile(): string {
  return getSubDir('mcp.json')
}

export function getSettingsFile(): string {
  return getSubDir('settings.json')
}

export function getProvidersFile(): string {
  return getSubDir('providers.json')
}

export function getOAuthFile(): string {
  return getSubDir('oauth.json')
}

export function getOpenAIOAuthFile(): string {
  return getSubDir('openai-oauth.json')
}

export function getDesktopUiFile(): string {
  return getSubDir('desktop-ui.json')
}

export function getKeybindingsFile(): string {
  return getSubDir('keybindings.json')
}

export function getScheduledTasksFile(): string {
  return getSubDir('scheduled_tasks.json')
}

export function getAdaptersFile(): string {
  return getSubDir('adapters.json')
}

export function getAdapterSessionsFile(): string {
  return getSubDir('adapter-sessions.json')
}

export function getHistoryFile(): string {
  return join(getDataDir(), 'history.jsonl')
}

export function getStatsCacheFile(): string {
  return join(getCacheDir(), 'stats-cache.json')
}

export function getChangelogCacheFile(): string {
  return join(getCacheDir(), 'changelog.md')
}

export function getCredentialsFile(): string {
  return join(getDataDir(), '.credentials.json')
}

export function getMagicDocsPromptFile(): string {
  return join(getDataDir(), 'magic-docs', 'prompt.md')
}

export function getTeamsDir(): string {
  return getSubDir('teams')
}

export function getTasksDir(): string {
  return getSubDir('tasks')
}

export function getSessionsDir(): string {
  return getSubDir('sessions')
}

export function getMcpNeedsAuthCacheFile(): string {
  return join(getCacheDir(), 'mcp-needs-auth-cache.json')
}

export function getUpdateLockFile(): string {
  return join(getDataDir(), '.update.lock')
}

export function getIdeDir(): string {
  return getSubDir('ide')
}

export function getTracesDir(): string {
  return getSubDir('traces')
}

export function getUsageDataDir(): string {
  return getSubDir('usage-data')
}

export function getLocalInstallerDir(): string {
  return getSubDir('local')
}

export function getShellSnapshotsDir(): string {
  return getSubDir('shell-snapshots')
}

export function getImDownloadsDir(): string {
  return getSubDir('im-downloads')
}

export function getCoWorkPluginsDir(): string {
  return getSubDir('cowork_plugins')
}

export function getProfileDir(): string {
  return getSubDir('profile')
}

export function getComputerUseConfigFile(): string {
  return getSubDir('computer-use-config.json')
}

// ─── 废弃兼容函数（供 Phase 2 过渡期使用） ────────────────────────────

/** @deprecated 返回用户 data/ 目录自身，待调用方迁移到更明确的路径函数。 */
export function getUserConfigDir(): string {
  return getDataDir()
}

export function getUserSkillsDir(): string {
  return getSkillsDir()
}

export function getUserAgentsDir(): string {
  return getAgentsDir()
}

export function getUserToolsDir(): string {
  return getSubDir('tools')
}
