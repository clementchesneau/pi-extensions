import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFakePi } from './fixtures/fake-pi.mjs';

const root = fileURLToPath(new URL('../packages/', import.meta.url));
const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
const packages = await Promise.all(
  directories.map(async ({ name }) => ({
    directory: join(root, name),
    manifest: JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8')),
  })),
);
const builtins = new Set(builtinModules);
const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu;
const packageName = specifier =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

test('every bare import of a package is declared by that package', async () => {
  const undeclared = [];
  for (const { directory, manifest } of packages) {
    const declared = new Set([
      manifest.name,
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const files = (await readdir(directory)).filter(name => name.endsWith('.js'));
    for (const file of files) {
      // JSDoc `import('…')` types are not runtime dependencies.
      const source = (await readFile(join(directory, file), 'utf8')).replace(/\/\*[\s\S]*?\*\//gu, '');
      for (const match of source.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith('.') || specifier.startsWith('node:') || builtins.has(specifier)) continue;
        if (!declared.has(packageName(specifier))) undeclared.push(`${manifest.name}/${file}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(undeclared, []);
});

test('each extension package loads alone and registers its capabilities', async () => {
  // An explicit empty key keeps video from reading the developer's real configuration file.
  process.env.GEMINI_API_KEY ??= '';
  const extensionPackages = packages.filter(({ manifest }) => manifest.pi?.extensions?.length);
  assert.equal(extensionPackages.length, 10);
  for (const { directory, manifest } of extensionPackages) {
    for (const entry of manifest.pi.extensions) {
      const { default: extension } = await import(pathToFileURL(join(directory, entry)).href);
      const fake = createFakePi();
      await extension(fake.pi);
      const registered = fake.tools.size + fake.commands.size + fake.handlers.size;
      assert.ok(registered > 0, `${manifest.name} registered nothing`);
    }
  }
});

test('every package is publishable under the MIT license with its own README and license file', async () => {
  const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
  for (const { directory, manifest } of packages) {
    const folder = directory.split('/').at(-1);
    assert.match(manifest.name, /^@clement_chsn\/pi-/u);
    assert.equal(manifest.license, 'MIT', manifest.name);
    assert.equal(manifest.publishConfig?.access, 'public', manifest.name);
    assert.equal(manifest.repository?.directory, `packages/${folder}`, manifest.name);
    assert.equal(await readFile(join(directory, 'LICENSE'), 'utf8'), license, `${manifest.name} LICENSE`);
    assert.ok((await readFile(join(directory, 'README.md'), 'utf8')).trim(), `${manifest.name} README`);
  }
});
