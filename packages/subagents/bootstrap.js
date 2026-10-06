// Worker bootstrap: what the parent sends to a child Pi session, and how the worker must answer.
import { validatePiRuntimeDescriptor } from './pi-compatibility.js';

/** @typedef {{version: 1, piRuntime: {entry: string, version: string, fingerprint: string}, instanceId: string, parentSessionId?: string|null, cwd: string, agentDir: string, model: {provider: string, id: string}, thinkingLevel: string, allowedTools: string[], resources: {extensionPaths?: string[], skillPaths?: string[], promptTemplatePaths?: string[], contextFiles?: boolean}, capabilitySnapshot?: object, privateCapabilities?: {runtimeApiKeys?: Record<string,string>, providerRegistrations?: object[]}, sessionDir?: string, sessionFile?: string, auth?: Record<string, string>}} SubagentBootstrap */

const fail = message => {
  throw new TypeError(`Invalid subagent bootstrap: ${message}`);
};

const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validateIdentity(value) {
  for (const key of ['instanceId', 'cwd', 'agentDir', 'thinkingLevel']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) fail(`${key} must be a non-empty string`);
  }
  if (!value.model || typeof value.model.provider !== 'string' || typeof value.model.id !== 'string')
    fail('model is required');
  if (!isStringArray(value.allowedTools)) fail('allowedTools must be strings');
  if (!value.resources || typeof value.resources !== 'object') fail('resources are required');
  if (value.sessionFile !== undefined && (typeof value.sessionFile !== 'string' || !value.sessionFile))
    fail('sessionFile must be a non-empty string');
}

function validateCapabilitySnapshot(snapshot, value) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tools)) fail('capabilitySnapshot v1 is required');
  if (snapshot.cwd !== value.cwd || snapshot.agentDir !== value.agentDir)
    fail('capabilitySnapshot directories must match bootstrap');
  if (snapshot.model?.provider !== value.model.provider || snapshot.model?.id !== value.model.id)
    fail('capabilitySnapshot model must match bootstrap');
  if (snapshot.thinkingLevel !== value.thinkingLevel) fail('capabilitySnapshot thinking level must match bootstrap');
  if (!Array.isArray(snapshot.extensionPaths)) fail('capabilitySnapshot.extensionPaths must be an array');
  if ('runtimeApiKeys' in snapshot || 'providerRegistrations' in snapshot)
    fail('secrets and private provider registrations must not be stored in capabilitySnapshot');
  if (JSON.stringify(snapshot.tools.map(tool => tool.name)) !== JSON.stringify(value.allowedTools))
    fail('capabilitySnapshot tools must match allowedTools');
}

/** Returns `value` when it is a complete v1 bootstrap; throws a TypeError naming the first defect otherwise. */
export function validateBootstrap(value) {
  if (!value || typeof value !== 'object') fail('expected an object');
  if (value.version !== 1) fail('unsupported version');
  validatePiRuntimeDescriptor(value.piRuntime);
  validateIdentity(value);
  if (value.capabilitySnapshot !== undefined) validateCapabilitySnapshot(value.capabilitySnapshot, value);
  for (const key of ['extensionPaths', 'skillPaths', 'promptTemplatePaths']) {
    if (value.resources[key] !== undefined && !isStringArray(value.resources[key]))
      fail(`resources.${key} must be strings`);
  }
  return value;
}

/**
 * Reads a worker IPC message during startup: `undefined` while it says nothing about
 * readiness, `null` once the worker is ready as `bootstrap`, otherwise the rejection.
 */
export function workerReadiness(message, bootstrap) {
  if (message?.type === 'subagent-bootstrap-error') {
    return new Error(`Subagent capability bootstrap failed: ${message.message ?? 'unknown incompatibility'}`);
  }
  if (message?.type !== 'subagent-ready') return undefined;
  if (message.instanceId !== bootstrap.instanceId) return new Error('Worker readiness identity mismatch');
  if (
    message.piRuntime?.entry !== bootstrap.piRuntime.entry ||
    message.piRuntime?.version !== bootstrap.piRuntime.version ||
    message.piRuntime?.fingerprint !== bootstrap.piRuntime.fingerprint
  ) {
    return new Error('Worker Pi runtime identity mismatch');
  }
  return null;
}

/** Throws unless the worker's RPC state is an idle session configured as `bootstrap`. */
export function assertWorkerMatchesBootstrap(state, bootstrap) {
  if (state?.sessionId !== bootstrap.instanceId) throw new Error('Worker session identity mismatch');
  if (state?.isStreaming !== false || state?.pendingMessageCount !== 0)
    throw new Error('Worker RPC is not idle at startup');
  if (state?.model?.provider !== bootstrap.model.provider || state?.model?.id !== bootstrap.model.id) {
    throw new Error('Worker effective model does not match the bootstrap');
  }
  if (state?.thinkingLevel !== bootstrap.thinkingLevel) {
    throw new Error('Worker effective thinking level does not match the bootstrap');
  }
}
