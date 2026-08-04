import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

export type MarketplaceRole = 'publisher' | 'reviewer' | 'admin'
export type MarketplaceActorRole = 'user' | MarketplaceRole

export type MarketplaceActor = {
  actorId: string
  email: string
  role: MarketplaceActorRole
  roles: MarketplaceRole[]
  isTestActor?: boolean
}

export type MarketplaceAuth = { actor: MarketplaceActor }

const sessionCookie = 'miko_session'
const csrfCookie = 'miko_csrf'
const sessionLifetimeMs = 8 * 60 * 60 * 1000
const dummyPasswordHash = '$argon2id$v=19$m=65536,t=2,p=1$wpzH3xF3p7DiP/QDHCABWwxolLg7U5attSY1heINsSY$GX+FvoCVw+3/b1dnf6lrBbPnfCyvcA293t1NM8Ngyho'

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function sameToken(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCookies(req: Request) {
  const cookies = new Map<string, string>()
  for (const part of req.headers.get('cookie')?.split(';') || []) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name && value) cookies.set(name, decodeURIComponent(value))
  }
  return cookies
}

function cookie(name: string, value: string, secure: boolean, httpOnly: boolean, maxAge?: number) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax']
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`)
  return parts.join('; ')
}

function normalizeRoles(values: string[]): MarketplaceRole[] {
  return values.filter((role): role is MarketplaceRole => role === 'publisher' || role === 'reviewer' || role === 'admin')
}

export function createMarketplaceAuthStore(dbPath: string, options: { secureCookies?: boolean } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  chmodSync(dbPath, 0o600)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('publisher', 'reviewer', 'admin')),
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS publisher_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      publisher_name TEXT NOT NULL,
      description TEXT NOT NULL,
      website_url TEXT,
      resource_focus TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_id TEXT,
      review_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS publisher_applications_status_idx ON publisher_applications(status);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      email TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL,
      window_started_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS user_roles_user_idx ON user_roles(user_id);
  `)

  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production'

  function getUserById(id: string) {
    const user = db.query(`SELECT id, email, display_name, status FROM users WHERE id = ?`).get(id) as {
      id: string
      email: string
      display_name: string
      status: string
    } | null
    if (!user || user.status !== 'active') return null
    const roles = db.query(`SELECT role FROM user_roles WHERE user_id = ?`).all(id) as Array<{ role: string }>
    return { ...user, roles: normalizeRoles(roles.map(row => row.role)) }
  }

  function bootstrapAdmin(email: string | undefined, passwordHash: string | undefined) {
    if (!email || !passwordHash) return
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || db.query(`SELECT id FROM users WHERE email = ?`).get(normalizedEmail)) return
    const id = randomUUID()
    const now = new Date().toISOString()
    db.transaction(() => {
      db.query(`INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, normalizedEmail, passwordHash, normalizedEmail, now, now)
      db.query(`INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'admin', ?)`).run(id, now)
    })()
  }

  bootstrapAdmin(process.env.MARKETPLACE_BOOTSTRAP_ADMIN_EMAIL, process.env.MARKETPLACE_BOOTSTRAP_ADMIN_PASSWORD_HASH)

  function actorForUser(user: { id: string; email: string; roles: MarketplaceRole[] }): MarketplaceActor {
    const role: MarketplaceActorRole = user.roles.includes('admin')
      ? 'admin'
      : user.roles.includes('reviewer')
        ? 'reviewer'
        : user.roles.includes('publisher') ? 'publisher' : 'user'
    return { actorId: user.id, email: user.email, role, roles: user.roles }
  }

  function authenticate(req: Request): MarketplaceAuth | null {
    const token = parseCookies(req).get(sessionCookie)
    if (token) {
      const session = db.query(`SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?`).get(hashToken(token)) as {
        id: string
        user_id: string
        expires_at: string
      } | null
      if (session && Date.parse(session.expires_at) > Date.now()) {
        const user = getUserById(session.user_id)
        if (user) {
          db.query(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), session.id)
          return { actor: actorForUser(user) }
        }
      }
      if (session) db.query(`DELETE FROM sessions WHERE id = ?`).run(session.id)
    }

    if (process.env.NODE_ENV === 'production' || process.env.MARKETPLACE_ENABLE_TEST_AUTH !== '1') return null
    const role = req.headers.get('x-miko-role')?.trim().toLowerCase()
    if (role !== 'publisher' && role !== 'reviewer' && role !== 'admin') return null
    return {
      actor: {
        actorId: req.headers.get('x-miko-actor')?.trim() || `test-${role}`,
        email: `${role}@test.invalid`,
        role,
        roles: [role],
        isTestActor: true,
      },
    }
  }

  function csrfValid(req: Request, auth: MarketplaceAuth) {
    if (auth.actor.isTestActor) return process.env.NODE_ENV !== 'production' && process.env.MARKETPLACE_ENABLE_TEST_AUTH === '1'
    const cookies = parseCookies(req)
    const header = req.headers.get('x-csrf-token')
    const csrf = cookies.get(csrfCookie)
    const sessionToken = cookies.get(sessionCookie)
    if (!header || !csrf || !sessionToken || !sameToken(header, csrf)) return false
    const row = db.query(`SELECT csrf_hash FROM sessions WHERE token_hash = ?`).get(hashToken(sessionToken)) as { csrf_hash: string } | null
    return Boolean(row && sameToken(hashToken(header), row.csrf_hash))
  }

  async function login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase()
    const attempt = db.query(`SELECT attempt_count, window_started_at FROM login_attempts WHERE email = ?`).get(normalizedEmail) as {
      attempt_count: number
      window_started_at: string
    } | null
    const nowMs = Date.now()
    if (attempt && nowMs - Date.parse(attempt.window_started_at) < 15 * 60 * 1000 && attempt.attempt_count >= 8) return null
    const user = db.query(`SELECT id, password_hash, status FROM users WHERE email = ?`).get(normalizedEmail) as {
      id: string
      password_hash: string
      status: string
    } | null
    const passwordValid = await Bun.password.verify(password, user?.password_hash || dummyPasswordHash)
    if (!user || user.status !== 'active' || !passwordValid) {
      const windowStartedAt = !attempt || nowMs - Date.parse(attempt.window_started_at) >= 15 * 60 * 1000
        ? new Date(nowMs).toISOString()
        : attempt.window_started_at
      const attemptCount = windowStartedAt === attempt?.window_started_at ? attempt.attempt_count + 1 : 1
      db.query(`INSERT INTO login_attempts (email, attempt_count, window_started_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET attempt_count = excluded.attempt_count, window_started_at = excluded.window_started_at`)
        .run(normalizedEmail, attemptCount, windowStartedAt)
      return null
    }
    db.query(`DELETE FROM login_attempts WHERE email = ?`).run(normalizedEmail)
    const fullUser = getUserById(user.id)
    if (!fullUser) return null
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    const now = new Date()
    const expires = new Date(now.getTime() + sessionLifetimeMs)
    db.query(`INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), user.id, hashToken(token), hashToken(csrf), expires.toISOString(), now.toISOString(), now.toISOString())
    db.query(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).run(now.toISOString(), now.toISOString(), user.id)
    const headers = new Headers()
    headers.append('set-cookie', cookie(sessionCookie, token, secureCookies, true, Math.floor(sessionLifetimeMs / 1000)))
    headers.append('set-cookie', cookie(csrfCookie, csrf, secureCookies, false, Math.floor(sessionLifetimeMs / 1000)))
    return { actor: actorForUser(fullUser), csrfToken: csrf, headers }
  }

  async function registerUser(input: { email: string; displayName: string; password: string }) {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    if (!email || !email.includes('@') || !displayName || input.password.length < 12) {
      throw new Error('Email, display name, and a 12+ character password are required')
    }
    if (db.query(`SELECT id FROM users WHERE email = ?`).get(email)) {
      throw new Error('An account with this email already exists')
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const passwordHash = await Bun.password.hash(input.password)
    db.query(`INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, email, passwordHash, displayName, now, now)
    return getUserById(id)
  }

  function logout(req: Request) {
    const token = parseCookies(req).get(sessionCookie)
    if (token) db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token))
    const headers = new Headers()
    headers.append('set-cookie', cookie(sessionCookie, '', secureCookies, true, 0))
    headers.append('set-cookie', cookie(csrfCookie, '', secureCookies, false, 0))
    return headers
  }

  function listUsers() {
    const users = db.query(`SELECT id, email, display_name, status, created_at, updated_at, last_login_at FROM users ORDER BY created_at DESC`).all() as Array<Record<string, unknown> & { id: string }>
    const roleQuery = db.query(`SELECT role FROM user_roles WHERE user_id = ? ORDER BY role`)
    return users.map(user => ({
      ...user,
      roles: normalizeRoles((roleQuery.all(user.id) as Array<{ role: string }>).map(row => row.role)),
    }))
  }

  function getPublisherApplication(userId: string) {
    return db.query(`SELECT * FROM publisher_applications WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 1`).get(userId) as Record<string, unknown> | null
  }

  function listPublisherApplications() {
    return db.query(`
      SELECT applications.*, users.email, users.display_name
      FROM publisher_applications applications
      JOIN users ON users.id = applications.user_id
      ORDER BY applications.submitted_at DESC
    `).all() as Array<Record<string, unknown>>
  }

  function submitPublisherApplication(input: {
    userId: string
    publisherName: string
    description: string
    websiteUrl: string
    resourceFocus: string
  }) {
    const user = getUserById(input.userId)
    if (!user) throw new Error('Active user account required')
    if (user.roles.includes('publisher')) throw new Error('Account is already a publisher')
    const existing = getPublisherApplication(input.userId)
    if (existing?.status === 'pending') throw new Error('A publisher application is already pending')
    if (!input.publisherName.trim() || !input.description.trim() || !input.resourceFocus.trim()) {
      throw new Error('Publisher name, description, and resource focus are required')
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    db.query(`INSERT INTO publisher_applications (id, user_id, publisher_name, description, website_url, resource_focus, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.userId, input.publisherName.trim(), input.description.trim(), input.websiteUrl.trim() || null, input.resourceFocus.trim(), now)
    return db.query(`SELECT * FROM publisher_applications WHERE id = ?`).get(id)
  }

  function reviewPublisherApplication(id: string, status: 'approved' | 'rejected', reviewerId: string, notes: string) {
    if (!notes.trim()) throw new Error('Review notes are required')
    const application = db.query(`SELECT * FROM publisher_applications WHERE id = ?`).get(id) as { id: string; user_id: string; status: string } | null
    if (!application) return null
    if (application.status !== 'pending') throw new Error(`Application is already ${application.status}`)
    const now = new Date().toISOString()
    db.transaction(() => {
      db.query(`UPDATE publisher_applications SET status = ?, reviewed_at = ?, reviewer_id = ?, review_notes = ? WHERE id = ?`)
        .run(status, now, reviewerId, notes.trim(), id)
      if (status === 'approved') {
        db.query(`INSERT OR IGNORE INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'publisher', ?, ?)`)
          .run(application.user_id, reviewerId, now)
      }
    })()
    return db.query(`SELECT * FROM publisher_applications WHERE id = ?`).get(id)
  }

  async function createUser(input: { email: string; displayName: string; password: string; roles: MarketplaceRole[] }, grantedBy: string) {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    const roles = [...new Set(input.roles)]
    if (!email || !email.includes('@') || !displayName || input.password.length < 12 || roles.length === 0) {
      throw new Error('Invalid user: email, display name, 12+ character password, and at least one role are required')
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const passwordHash = await Bun.password.hash(input.password)
    db.transaction(() => {
      db.query(`INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, email, passwordHash, displayName, now, now)
      const insertRole = db.query(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)`)
      for (const role of roles) insertRole.run(id, role, grantedBy, now)
    })()
    return getUserById(id)
  }

  function updateUserRoles(userId: string, roles: MarketplaceRole[], grantedBy: string) {
    const normalized = [...new Set(roles)]
    if (normalized.length === 0) throw new Error('At least one role is required')
    if (userId === grantedBy) throw new Error('Administrators cannot change their own roles')
    const now = new Date().toISOString()
    db.transaction(() => {
      db.query(`DELETE FROM user_roles WHERE user_id = ?`).run(userId)
      const insertRole = db.query(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)`)
      for (const role of normalized) insertRole.run(userId, role, grantedBy, now)
      db.query(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
      db.query(`UPDATE users SET updated_at = ? WHERE id = ?`).run(now, userId)
    })()
    return getUserById(userId)
  }

  function updateUserStatus(userId: string, status: 'active' | 'disabled', changedBy: string) {
    if (userId === changedBy) throw new Error('Administrators cannot disable their own account')
    const now = new Date().toISOString()
    db.transaction(() => {
      db.query(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, userId)
      if (status === 'disabled') db.query(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
    })()
    return db.query(`SELECT id, email, display_name, status FROM users WHERE id = ?`).get(userId)
  }

  return {
    authenticate,
    csrfValid,
    login,
    registerUser,
    logout,
    getUserById,
    listUsers,
    getPublisherApplication,
    listPublisherApplications,
    submitPublisherApplication,
    reviewPublisherApplication,
    createUser,
    updateUserRoles,
    updateUserStatus,
    db,
    close: () => db.close(),
  }
}
