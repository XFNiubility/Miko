import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { createMarketplaceAuthStore } from './marketplace-auth.ts'

const originalTestAuth = process.env.MARKETPLACE_ENABLE_TEST_AUTH
const originalAdminEmail = process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL
const originalAdminHash = process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH
const originalNodeEnv = process.env.NODE_ENV
const roots: string[] = []

afterEach(() => {
  if (originalTestAuth === undefined) delete process.env.MARKETPLACE_ENABLE_TEST_AUTH
  else process.env.MARKETPLACE_ENABLE_TEST_AUTH = originalTestAuth
  if (originalAdminEmail === undefined) delete process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL
  else process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL = originalAdminEmail
  if (originalAdminHash === undefined) delete process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH
  else process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH = originalAdminHash
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('marketplace authentication', () => {
  it('does not accept spoofed role headers unless the explicit test adapter is enabled', () => {
    delete process.env.MARKETPLACE_ENABLE_TEST_AUTH
    const root = mkdtempSync(join(tmpdir(), 'miko-auth-'))
    roots.push(root)
    const store = createMarketplaceAuthStore(join(root, 'auth.db'), { secureCookies: false })
    expect(store.authenticate(new Request('http://localhost/', { headers: { 'x-miko-role': 'admin' } }))).toBeNull()
    store.close()
  })

  it('hard-disables the test role adapter in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.MARKETPLACE_ENABLE_TEST_AUTH = '1'
    const root = mkdtempSync(join(tmpdir(), 'miko-auth-'))
    roots.push(root)
    const store = createMarketplaceAuthStore(join(root, 'auth.db'), { secureCookies: false })
    expect(store.authenticate(new Request('http://localhost/', { headers: { 'x-miko-role': 'admin' } }))).toBeNull()
    store.close()
  })

  it('creates a server-derived admin session and rejects missing csrf', async () => {
    delete process.env.MARKETPLACE_ENABLE_TEST_AUTH
    process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test'
    process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH = await Bun.password.hash('correct horse battery staple')
    const root = mkdtempSync(join(tmpdir(), 'miko-auth-'))
    roots.push(root)
    const store = createMarketplaceAuthStore(join(root, 'auth.db'), { secureCookies: false })
    const login = await store.login('admin@example.test', 'correct horse battery staple')
    expect(login?.actor.roles).toEqual(['admin'])
    const cookieHeader = login?.headers.get('set-cookie') || ''
    const request = new Request('http://localhost/', { headers: { cookie: cookieHeader } })
    const auth = store.authenticate(request)
    expect(auth?.actor.actorId).toBeString()
    expect(store.csrfValid(request, auth!)).toBe(false)
    store.close()
  })

  it('lets admins create and disable scoped users without changing their own role', async () => {
    delete process.env.NODE_ENV
    process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test'
    process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH = await Bun.password.hash('correct horse battery staple')
    const root = mkdtempSync(join(tmpdir(), 'miko-auth-'))
    roots.push(root)
    const store = createMarketplaceAuthStore(join(root, 'auth.db'), { secureCookies: false })
    const admin = (await store.login('admin@example.test', 'correct horse battery staple'))!.actor
    const publisher = await store.createUser({
      email: 'publisher@example.test',
      displayName: 'Publisher',
      password: 'publisher password 123',
      roles: ['publisher'],
    }, admin.actorId)
    expect(publisher?.roles).toEqual(['publisher'])
    expect(store.updateUserRoles(publisher!.id, ['reviewer'], admin.actorId)?.roles).toEqual(['reviewer'])
    expect(() => store.updateUserRoles(admin.actorId, ['publisher'], admin.actorId)).toThrow('cannot change their own roles')
    expect(store.updateUserStatus(publisher!.id, 'disabled', admin.actorId)).toMatchObject({ status: 'disabled' })
    store.close()
  })

  it('upgrades an existing authentication database without losing users', async () => {
    const root = mkdtempSync(join(tmpdir(), 'miko-auth-upgrade-'))
    roots.push(root)
    const dbPath = join(root, 'auth.db')
    const passwordHash = await Bun.password.hash('existing admin password 123')
    const legacy = new Database(dbPath)
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE user_roles (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      CREATE TABLE login_attempts (email TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL, window_started_at TEXT NOT NULL);
    `)
    const now = new Date().toISOString()
    legacy.query(`INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('existing-admin', 'existing-admin@example.test', passwordHash, 'Existing Admin', now, now)
    legacy.query(`INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'admin', ?)`).run('existing-admin', now)
    legacy.close()

    const store = createMarketplaceAuthStore(dbPath, { secureCookies: false })
    expect(store.listUsers()).toHaveLength(1)
    expect(store.listUsers()[0]).toMatchObject({ email: 'existing-admin@example.test', roles: ['admin'] })
    expect(store.listPublisherApplications()).toEqual([])
    store.close()
  })
})
