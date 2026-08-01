import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

export type ResourceSignatureVerificationResult = 'missing' | 'verified'

export class ResourceSignatureVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResourceSignatureVerificationError'
  }
}

export function getConfiguredResourcePublicKeys(): string[] {
  return [
    process.env.KIMO_RESOURCE_SIGNATURE_PUBLIC_KEY?.trim(),
    process.env.MIKO_RESOURCE_SIGNATURE_PUBLIC_KEY?.trim(),
  ].filter((key): key is string => Boolean(key))
}

function getConfiguredPrivateKey(): string | undefined {
  return process.env.KIMO_RESOURCE_SIGNATURE_PRIVATE_KEY?.trim()
    || process.env.MIKO_RESOURCE_SIGNATURE_PRIVATE_KEY?.trim()
}

function parsePublicKey(raw: string) {
  if (raw.includes('-----BEGIN')) {
    return createPublicKey(raw)
  }

  try {
    return createPublicKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new ResourceSignatureVerificationError('Resource signature public key is invalid')
  }
}

function parsePrivateKey(raw: string) {
  if (raw.includes('-----BEGIN')) {
    return createPrivateKey(raw)
  }

  try {
    return createPrivateKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    throw new ResourceSignatureVerificationError('Resource signature private key is invalid')
  }
}

function parseSignature(raw: string): Buffer {
  const value = raw.trim()
  const base64 = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new ResourceSignatureVerificationError('Resource signature must be base64 encoded')
  }
  return Buffer.from(base64, 'base64')
}

export function verifyResourceSignature(
  data: Uint8Array,
  signature: string | undefined,
  label: string,
): ResourceSignatureVerificationResult {
  return verifyResourceSignatureWithPublicKeys(data, signature, label, getConfiguredResourcePublicKeys())
}

export function verifyResourceSignatureWithPublicKeys(
  data: Uint8Array,
  signature: string | undefined,
  label: string,
  publicKeys: string[],
): ResourceSignatureVerificationResult {
  const trimmedSignature = signature?.trim()
  if (!trimmedSignature) return 'missing'

  if (publicKeys.length === 0) {
    throw new ResourceSignatureVerificationError(
      `Resource signature is present for ${label}, but no trusted public key is configured`,
    )
  }

  const parsedSignature = parseSignature(trimmedSignature)
  for (const publicKey of publicKeys) {
    const ok = verify(
      null,
      Buffer.from(data),
      parsePublicKey(publicKey),
      parsedSignature,
    )
    if (ok) return 'verified'
  }

  throw new ResourceSignatureVerificationError(`Resource signature verification failed for ${label}`)
}

export function signResourceData(data: Uint8Array): string | undefined {
  const privateKey = getConfiguredPrivateKey()
  if (!privateKey) return undefined
  const signature = sign(null, Buffer.from(data), parsePrivateKey(privateKey)).toString('base64')
  return `ed25519:${signature}`
}

export function canonicalizeSignedJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeJsonValue(value))}\n`
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalizeJsonValue((value as Record<string, unknown>)[key])]),
  )
}
