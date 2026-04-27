import path from 'path'

export function isManagedPendingAttachmentPath(
  assetDirectory: string,
  targetPath: string,
): boolean {
  const resolvedAssetDirectory = path.resolve(assetDirectory)
  const resolvedTargetPath = path.resolve(targetPath)
  const relative = path.relative(resolvedAssetDirectory, resolvedTargetPath)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}
