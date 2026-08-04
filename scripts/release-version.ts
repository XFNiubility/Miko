export type ReleaseVersionPolicy = {
  schemaVersion: number
  product: string
  historicalPublicVersionFloor: string
  canonicalTagPrefix: string
  artifactPrefix: string
}

type Semver = {
  major: number
  minor: number
  patch: number
}

export function parseSemver(version: string): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)

  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function assertReleaseVersion(
  current: string,
  next: string,
  policy: ReleaseVersionPolicy,
): void {
  parseSemver(current)
  parseSemver(next)
  parseSemver(policy.historicalPublicVersionFloor)

  if (compareSemver(next, current) <= 0) {
    throw new Error(`Release version ${next} must be greater than current source version ${current}`)
  }

  if (compareSemver(next, policy.historicalPublicVersionFloor) <= 0) {
    throw new Error(
      `Release version ${next} must be greater than historical public version ${policy.historicalPublicVersionFloor}`,
    )
  }
}
