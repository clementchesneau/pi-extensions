import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const packagesRoot = new URL('../../packages/', import.meta.url);

/**
 * Lays out a workspace package as npm installs it: its files at `target` and its
 * workspace dependencies under `target/node_modules`. Host packages stay absent.
 */
export async function copyPublishedPackage(folder, target) {
  const source = new URL(`${folder}/`, packagesRoot);
  await cp(source, target, { recursive: true, filter: path => !path.split(/[\\/]/u).includes('node_modules') });
  const manifest = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!range.startsWith('workspace:')) continue;
    const dependency = name.split('/').at(-1).replace(/^pi-/u, '');
    await copyPublishedPackage(dependency, join(target, 'node_modules', name));
  }
}
