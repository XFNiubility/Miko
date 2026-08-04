import { describe, expect, it } from 'bun:test'

import {
  assertReleaseVersion,
  compareSemver,
  type ReleaseVersionPolicy,
} from './release-version.js'

const policy: ReleaseVersionPolicy = {
  schemaVersion: 1,
  product: 'Miko',
  historicalPublicVersionFloor: '1.2.0',
  canonicalTagPrefix: 'v',
  artifactPrefix: 'Miko_',
}

describe('release version policy', () => {
  it('compares semantic versions numerically', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareSemver('1.3.0', '1.3.0')).toBe(0)
  })

  it('accepts the first release above the public v1.2 line', () => {
    expect(() => assertReleaseVersion('0.3.4', '1.3.0', policy)).not.toThrow()
  })

  it('rejects source-version downgrades and repeated versions', () => {
    expect(() => assertReleaseVersion('1.3.0', '1.2.9', policy)).toThrow('must be greater')
    expect(() => assertReleaseVersion('1.3.0', '1.3.0', policy)).toThrow('must be greater')
  })

  it('rejects candidates that do not advance beyond the public v1.2 line', () => {
    expect(() => assertReleaseVersion('0.3.4', '1.2.0', policy)).toThrow(
      'historical public version 1.2.0',
    )
  })
})
