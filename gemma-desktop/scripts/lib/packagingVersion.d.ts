export interface PackagingVersionInput {
  rootVersion: string
  productName: string
  distDir?: string
}

export interface ResolvePackagedVersionInput extends PackagingVersionInput {
  incrementInstallerVersion: boolean
}

export function parseNumericVersion(version: string): {
  major: number
  minor: number
  patch: number
}

export function formatNumericVersion(version: {
  major: number
  minor: number
  patch: number
}): string

export function deriveInstallerVersion(input: PackagingVersionInput): string

export function resolvePackagedVersion(
  input: ResolvePackagedVersionInput,
): string
