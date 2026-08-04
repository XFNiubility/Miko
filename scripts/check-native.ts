import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')
const desktopRoot = path.join(repoRoot, 'desktop')
const tauriRoot = path.join(desktopRoot, 'src-tauri')
const cargoHome = process.env.CARGO_HOME || path.join(homedir(), '.cargo')
const bunHome = process.env.BUN_INSTALL || path.join(homedir(), '.bun')
const cargoBin = path.join(cargoHome, 'bin')
const bunBin = path.join(bunHome, 'bin')
const env = {
  ...process.env,
  PATH: [cargoBin, bunBin, process.env.PATH].filter(Boolean).join(path.delimiter),
}
if (process.platform === 'win32' && !env.CLAUDE_CODE_BUN_TARGET) {
  env.CLAUDE_CODE_BUN_TARGET = 'bun-windows-x64'
}

await run([process.execPath, 'run', 'build:sidecars'], desktopRoot)

const cargoExecutable = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
await run([existsSync(cargoExecutable) ? cargoExecutable : 'cargo', 'check'], tauriRoot)

async function run(command: string[], cwd: string) {
  console.log(`[check-native] ${command.join(' ')}`)
  const process = Bun.spawn(command, {
    cwd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) {
    throw new Error(`[check-native] command failed with exit ${exitCode}: ${command.join(' ')}`)
  }
}
