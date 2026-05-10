import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name?: string;
  version?: string;
}

let cachedPackage: PackageJson | undefined;

export function cliPackage(): PackageJson {
  cachedPackage ??= JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as PackageJson;
  return cachedPackage;
}

export function cliVersion(): string {
  return cliPackage().version ?? '0.0.0';
}

export function cliVersionText(): string {
  return `${cliPackage().name ?? 'gemma-cli'} ${cliVersion()}`;
}
