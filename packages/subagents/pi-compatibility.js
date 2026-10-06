import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const REQUIRED_FUNCTIONS = [
  'createAgentSessionServices',
  'createAgentSessionFromServices',
  'createAgentSessionRuntime',
  'runRpcMode',
  'getAgentDir',
];
// Keep the launch baseline across extension reloads, keyed by a host SDK export.
const baselineKey = Symbol.for('pi-extensions.subagents.host-runtime-baselines');
const parentBaselines = (globalThis[baselineKey] ??= new WeakMap());
// A CLI process has one host, even when its launcher later points elsewhere.
const cliBaselineKey = Symbol.for('pi-extensions.subagents.cli-runtime-baseline');
const cliBaseline = (globalThis[cliBaselineKey] ??= {});
const fileFingerprints = new Map();

function fileFingerprint(path) {
  // Avoid rereading the whole distribution on every admission. ctime and inode
  // detect same-length rewrites even when the original mtime is restored.
  const stat = statSync(path, { bigint: true });
  const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const cached = fileFingerprints.get(path);
  if (cached?.identity === identity) return cached.digest;
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  fileFingerprints.set(path, { identity, digest });
  return digest;
}
const REQUIRED_METHODS = { SessionManager: ['create', 'open', 'inMemory'], SettingsManager: ['create', 'inMemory'] };

function readHostManifest(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Host Pi package is unavailable: ${directory}`, { cause: error });
  }
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`Not a valid host Pi package: ${directory}`);
  }
  const exported = manifest.exports?.['.']?.import;
  if (manifest.type !== 'module' || typeof exported !== 'string' || !exported.startsWith('./')) {
    throw new Error('Host Pi package has no accessible ESM import entry; compiled runtimes are not supported');
  }
  return { manifest, exported };
}

/** Canonical ESM entry of the package, which must be a file inside it. */
function packageEntry(directory, exported) {
  try {
    const entry = realpathSync(join(directory, exported));
    const path = relative(directory, entry);
    if (!statSync(entry).isFile() || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error('entry outside package');
    return entry;
  } catch (error) {
    throw new Error(`Host Pi SDK entry is unavailable: ${join(directory, exported)}`, { cause: error });
  }
}

/** Digest of the manifest and of every regular file and binding under `roots`. */
function packageFingerprint(directory, roots) {
  const hash = createHash('sha256');
  hash.update(fileFingerprint(join(directory, 'package.json')));
  const visited = new Set();
  // Conservatively cover every regular file in the SDK distribution: suffixes
  // cannot identify extensionless ESM imports or resources read by runtime code.
  // This also means changing a distribution asset requires a host restart.
  const fingerprintTree = path => {
    const canonical = realpathSync(path);
    const metadata = statSync(path);
    const isDirectory = metadata.isDirectory();
    const isSymlink = lstatSync(path).isSymbolicLink();
    const isRuntimeFile = metadata.isFile();
    // Record every logical binding before deduplicating target contents. A
    // retargeted alias must not disappear merely because both targets were seen.
    if (isDirectory || isSymlink || isRuntimeFile) {
      hash.update(
        JSON.stringify([relative(directory, path), canonical, isDirectory, isSymlink ? readlinkSync(path) : null]),
      );
      hash.update('\0');
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (isDirectory) {
      for (const name of readdirSync(path).sort()) fingerprintTree(join(path, name));
    } else if (isRuntimeFile) {
      hash.update(fileFingerprint(path));
      hash.update('\0');
    }
  };
  for (const root of roots) fingerprintTree(root);
  return hash.digest('hex');
}

function packageAt(directory) {
  const { manifest, exported } = readHostManifest(directory);
  const entry = packageEntry(directory, exported);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
  // The bundled CLI contains its own virtual SDK; include it in the baseline.
  const roots = [dirname(entry), ...(bin ? [join(directory, bin)] : [])];
  return { entry, version: manifest.version, fingerprint: packageFingerprint(directory, roots) };
}

function packageDirectory(entry) {
  let directory = dirname(realpathSync(entry));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === PACKAGE_NAME) return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No host Pi package found for ${entry}`);
    directory = parent;
  }
}

function currentCliPackageDirectory() {
  try {
    return packageDirectory(process.argv[1]);
  } catch (error) {
    if (cliBaseline.descriptor)
      throw new Error('Host Pi CLI launcher no longer resolves to its initialized runtime; restart Pi', {
        cause: error,
      });
    return undefined;
  }
}

/** Whether this process is the Pi CLI itself, so its command line is Pi's own arguments. */
export function isPiCliProcess() {
  return currentCliPackageDirectory() !== undefined;
}

function pinCliRuntime(descriptor) {
  const initial = cliBaseline.descriptor;
  if (
    initial &&
    (initial.entry !== descriptor.entry ||
      initial.version !== descriptor.version ||
      initial.fingerprint !== descriptor.fingerprint)
  ) {
    throw new Error('Host Pi CLI runtime changed since process initialization; restart Pi');
  }
  cliBaseline.descriptor ??= Object.freeze({ ...descriptor });
}

export function assertPiCapabilities(sdk) {
  if (typeof sdk?.VERSION !== 'string' || !sdk.VERSION) throw new Error('Host Pi SDK is missing VERSION');
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof sdk[name] !== 'function') throw new Error(`Host Pi SDK is missing required capability ${name}`);
  }
  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    for (const method of methods) {
      if (typeof sdk[name]?.[method] !== 'function')
        throw new Error(`Host Pi SDK is missing required capability ${name}.${method}`);
    }
  }
}

/** Binds `descriptor` to the SDK this process runs: same CLI package and same files as at initialization. */
function pinRunningHost(sdk, descriptor, directory) {
  // A bundled CLI's virtual exports are not native ESM object references.
  // Bind its resource candidate to the actual executable package instead.
  const executablePackage = currentCliPackageDirectory();
  if (executablePackage && realpathSync(executablePackage) !== directory) {
    throw new Error('Host Pi SDK package differs from the running CLI; restart Pi');
  }
  if (executablePackage) pinCliRuntime(descriptor);
  const baseline = parentBaselines.get(sdk.SessionManager);
  if (baseline && (baseline.entry !== descriptor.entry || baseline.fingerprint !== descriptor.fingerprint)) {
    throw new Error('Host Pi runtime files changed since initialization; restart Pi');
  }
  parentBaselines.set(sdk.SessionManager, baseline ?? descriptor);
  if (executablePackage) cliBaseline.sdk ??= sdk;
}

/** @param {{ sdk?: typeof import('@earendil-works/pi-coding-agent'), entryPoint?: string, packageDir?: string }} [source] */
export function resolveHostPiRuntime({ sdk, entryPoint, packageDir } = {}) {
  if (sdk) assertPiCapabilities(sdk);
  const candidate = packageDir ?? (sdk ? sdk.getPackageDir?.() : entryPoint ? packageDirectory(entryPoint) : undefined);
  if (!candidate) throw new Error('Host Pi SDK cannot be established; an accessible Node ESM installation is required');
  let directory;
  try {
    directory = realpathSync(candidate);
  } catch (error) {
    throw new Error(`Host Pi SDK package is unavailable: ${candidate}`, { cause: error });
  }
  const descriptor = packageAt(directory);
  if (sdk && descriptor.version !== sdk.VERSION) {
    throw new Error(
      `Host Pi runtime ${sdk.VERSION} differs from the installation on disk ${descriptor.version}; restart Pi`,
    );
  }
  if (sdk) pinRunningHost(sdk, descriptor, directory);
  return descriptor;
}

export function validatePiRuntimeDescriptor(descriptor) {
  if (
    !descriptor ||
    !isAbsolute(descriptor.entry ?? '') ||
    typeof descriptor.version !== 'string' ||
    !descriptor.version ||
    !/^[a-f0-9]{64}$/u.test(descriptor.fingerprint ?? '')
  ) {
    throw new TypeError('Host Pi runtime descriptor requires an absolute SDK entry, version and SHA-256 fingerprint');
  }
  let current;
  try {
    current = packageAt(packageDirectory(descriptor.entry));
  } catch (error) {
    throw new Error(`Host Pi SDK entry cannot be validated: ${descriptor.entry}`, { cause: error });
  }
  if (current.entry !== descriptor.entry)
    throw new Error('Host Pi SDK entry is not the canonical package import entry');
  if (current.version !== descriptor.version) {
    throw new Error(
      `Host Pi runtime ${descriptor.version} differs from the installation on disk ${current.version}; restart Pi`,
    );
  }
  if (current.fingerprint !== descriptor.fingerprint)
    throw new Error('Host Pi runtime files changed since initialization; restart Pi');
  return current;
}

export async function loadParentPiHost({ loadSdk = () => import('@earendil-works/pi-coding-agent') } = {}) {
  // Native .js extension loading can bypass Pi's aliases when devDependencies
  // exist. In a CLI parent, select its installation before importing any SDK.
  let sdk;
  let error;
  let sdkLoadAttempted = false;
  const loadDefaultSdk = () => {
    sdkLoadAttempted = true;
    return loadSdk();
  };
  try {
    const directory = currentCliPackageDirectory();
    if (directory) {
      const descriptor = resolveHostPiRuntime({ packageDir: directory });
      // Pin before import: a fresh SDK class must not establish a fresh host.
      pinCliRuntime(descriptor);
      sdk = await loadHostPiRuntime(descriptor);
    } else {
      sdk = await loadDefaultSdk();
    }
    resolveHostPiRuntime({ sdk });
  } catch (failure) {
    error = failure;
    // Retain the original namespace for archives/UI, never as a worker fallback.
    sdk ??= cliBaseline.sdk;
    if (!sdk) {
      // A failed host import is not retried from the same missing local package.
      if (sdkLoadAttempted) throw failure;
      sdk = await loadDefaultSdk();
    }
  }
  return { sdk, error };
}

/**
 * @param {{ entry: string, version: string, fingerprint: string }} descriptor validated before use
 * @param {{ expectedSdk?: typeof import('@earendil-works/pi-coding-agent') }} [options]
 */
export async function loadHostPiRuntime(descriptor, { expectedSdk } = {}) {
  validatePiRuntimeDescriptor(descriptor);
  if (expectedSdk) {
    assertPiCapabilities(expectedSdk);
    const parent = resolveHostPiRuntime({ sdk: expectedSdk });
    if (parent.entry !== descriptor.entry || parent.fingerprint !== descriptor.fingerprint) {
      throw new Error('Host Pi SDK package differs from the running parent; restart Pi');
    }
    const cliPackage = currentCliPackageDirectory();
    // The CLI already owns its SDK (virtual exports in the bundled build).
    // Do not load a second native SDK into that parent to compare object refs.
    // The worker validates the native entry before accepting any mission.
    if (cliPackage) return expectedSdk;
  }
  const sdk = await import(pathToFileURL(descriptor.entry).href);
  assertPiCapabilities(sdk);
  if (sdk.VERSION !== descriptor.version)
    throw new Error(`Loaded worker Pi runtime ${sdk.VERSION} differs from parent ${descriptor.version}; restart Pi`);
  // Recheck after import, before publishing readiness (including cached imports).
  validatePiRuntimeDescriptor(descriptor);
  if (expectedSdk) {
    // Native SDK embeddings share exports; CLI bundles intentionally do not.
    for (const name of [...REQUIRED_FUNCTIONS, ...Object.keys(REQUIRED_METHODS)]) {
      if (sdk[name] !== expectedSdk[name])
        throw new Error(`Host Pi SDK source differs from the running parent (${name}); restart Pi`);
    }
  }
  return sdk;
}
