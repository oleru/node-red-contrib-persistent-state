/**
 * The MIT License
 *
 * Copyright (c) 2020, Loren West and other contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 **/

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const VALUE_SCHEMA = 'persistent-state.value.v1';
const CHECKSUM_ALGORITHM = 'sha256';
const CHECKSUM_ENCODING = 'hex';

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + canonicalStringify(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function assertJsonCompatible(value, fieldPath, seen) {
  if (value === null) {
    return;
  }
  let valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(fieldPath + ' must be a finite JSON number');
    }
    return;
  }
  if (valueType !== 'object') {
    throw new Error(fieldPath + ' must be JSON-compatible');
  }

  let refs = seen || new WeakSet();
  if (refs.has(value)) {
    throw new Error(fieldPath + ' must not contain circular references');
  }
  refs.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonCompatible(value[i], fieldPath + '[' + i + ']', refs);
    }
    refs.delete(value);
    return;
  }

  let prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(fieldPath + ' must be a plain JSON object');
  }
  Object.keys(value).forEach(function(key) {
    assertJsonCompatible(value[key], fieldPath + '.' + key, refs);
  });
  refs.delete(value);
}

function checksumPayload(payload) {
  return crypto
    .createHash(CHECKSUM_ALGORITHM)
    .update(canonicalStringify(payload))
    .digest(CHECKSUM_ENCODING);
}

function payloadWithoutChecksum(generation) {
  let payload = Object.assign({}, generation);
  delete payload.checksum;
  return payload;
}

function wrapPayload(payload) {
  let generation = Object.assign({}, payload);
  generation.checksum = checksumPayload(payload);
  return generation;
}

function validateStateName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('State name is required');
  }
  if (name === '.' || name === '..' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
    throw new Error('State name must not contain path separators');
  }
}

function getValueDir(sharedStateDir, stateName, valueRoot) {
  validateStateName(stateName);
  return path.join(valueRoot || path.join(sharedStateDir, '.values'), stateName);
}

function getStorePaths(valueDir) {
  return {
    valueDir: valueDir,
    active: path.join(valueDir, 'active.json'),
    previous: path.join(valueDir, 'previous.json'),
    staged: path.join(valueDir, 'staged.json.tmp'),
    previousTmp: path.join(valueDir, 'previous.json.tmp'),
    commitTmp: path.join(valueDir, 'commit.json.tmp'),
  };
}

function buildPayload(options) {
  if (options.name) {
    validateStateName(options.name);
  }
  let sequence = Number(options.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('sequence must be a non-negative safe integer');
  }
  assertJsonCompatible(options.value, 'value');
  let previous = options.previous !== undefined ? options.previous : options.prev;
  previous = previous === undefined ? null : previous;
  assertJsonCompatible(previous, 'previous');
  return {
    value: options.value,
    previous: previous,
    timestamp: Number(options.timestamp || 0),
    sequence: sequence,
  };
}

async function removeIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}

async function renameIfExists(from, to) {
  try {
    await fsp.rename(from, to);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}

async function copyFileSyncedIfExists(from, to) {
  try {
    let content = await fsp.readFile(from, 'utf8');
    await writeFileSynced(to, content);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}

async function writeFileSynced(filePath, data) {
  let handle = await fsp.open(filePath, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(dirPath) {
  if (process.platform === 'win32') {
    return false;
  }
  let handle;
  try {
    handle = await fsp.open(dirPath, 'r');
    await handle.sync();
    return true;
  } catch (e) {
    return false;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

async function writeGeneration(options) {
  validateStateName(options.name);
  let payload = buildPayload(options);
  let paths = getStorePaths(options.valueDir);
  let wrapped = wrapPayload(payload);
  let json = canonicalStringify(wrapped);

  await fsp.mkdir(paths.valueDir, {recursive: true});
  await removeIfExists(paths.staged);
  await removeIfExists(paths.previousTmp);
  await writeFileSynced(paths.staged, json);
  await copyFileSyncedIfExists(paths.active, paths.previousTmp);
  await fsp.rename(paths.staged, paths.active);
  await syncDirectoryBestEffort(paths.valueDir);
  await removeIfExists(paths.previous);
  await renameIfExists(paths.previousTmp, paths.previous);
  await syncDirectoryBestEffort(paths.valueDir);

  return {
    status: 'written',
    source: 'active',
    payload: payload,
    paths: paths,
  };
}

function invalidGeneration(source, reason, error) {
  return {
    ok: false,
    source: source,
    reason: reason,
    code: error && error.code,
    message: error && error.message,
  };
}

function validateWrappedGeneration(wrapped, options, source) {
  if (!wrapped || typeof wrapped !== 'object') {
    return invalidGeneration(source, 'not-object');
  }

  if (wrapped.payload && typeof wrapped.payload === 'object') {
    return validateLegacyWrappedGeneration(wrapped, options, source);
  }

  if (!wrapped.checksum || typeof wrapped.checksum !== 'string') {
    return invalidGeneration(source, 'missing-checksum');
  }
  let payload = payloadWithoutChecksum(wrapped);
  if (wrapped.checksum !== checksumPayload(payload)) {
    return invalidGeneration(source, 'checksum-mismatch');
  }

  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
    return invalidGeneration(source, 'invalid-sequence');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'value')) {
    return invalidGeneration(source, 'missing-value');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'previous')) {
    return invalidGeneration(source, 'missing-previous');
  }

  return {
    ok: true,
    source: source,
    payload: payload,
  };
}

function validateLegacyWrappedGeneration(wrapped, options, source) {
  if (!wrapped.checksum || typeof wrapped.checksum !== 'object') {
    return invalidGeneration(source, 'missing-checksum');
  }
  if (wrapped.checksum.algorithm !== CHECKSUM_ALGORITHM ||
      wrapped.checksum.encoding !== CHECKSUM_ENCODING) {
    return invalidGeneration(source, 'unsupported-checksum');
  }
  if (wrapped.checksum.value !== checksumPayload(wrapped.payload)) {
    return invalidGeneration(source, 'checksum-mismatch');
  }

  let payload = wrapped.payload;
  if (payload.schema !== VALUE_SCHEMA) {
    return invalidGeneration(source, 'wrong-schema');
  }
  if (payload.name !== options.name) {
    return invalidGeneration(source, 'wrong-name');
  }
  if (options.type !== undefined && options.type !== null &&
      options.type !== '' && payload.type !== options.type) {
    return invalidGeneration(source, 'wrong-type');
  }
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
    return invalidGeneration(source, 'invalid-sequence');
  }

  return {
    ok: true,
    source: source,
    payload: {
      value: payload.value,
      previous: payload.previous !== undefined ? payload.previous : payload.prev,
      timestamp: Number(payload.timestamp || 0),
      sequence: payload.sequence,
    },
  };
}

async function readGeneration(filePath, options, source) {
  try {
    let content = await fsp.readFile(filePath, 'utf8');
    let wrapped;
    try {
      wrapped = JSON.parse(content);
    } catch (e) {
      return invalidGeneration(source, 'invalid-json', e);
    }
    return validateWrappedGeneration(wrapped, options, source);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return invalidGeneration(source, 'missing', e);
    }
    return invalidGeneration(source, 'unreadable', e);
  }
}

function selectBestGeneration(candidates) {
  let valid = candidates.filter(function(candidate) {
    return candidate.ok;
  });
  if (valid.length === 0) {
    return null;
  }
  valid.sort(function(a, b) {
    if (b.payload.sequence !== a.payload.sequence) {
      return b.payload.sequence - a.payload.sequence;
    }
    if (a.source === 'active') {
      return -1;
    }
    if (b.source === 'active') {
      return 1;
    }
    return 0;
  });
  return valid[0];
}

async function recover(options) {
  validateStateName(options.name);
  let paths = getStorePaths(options.valueDir);
  let candidates = await Promise.all([
    readGeneration(paths.active, options, 'active'),
    readGeneration(paths.previous, options, 'previous'),
  ]);
  let selected = selectBestGeneration(candidates);
  return {
    status: selected ? 'recovered' : 'missing',
    source: selected && selected.source,
    payload: selected && selected.payload,
    diagnostics: candidates,
    ignoredTempFiles: [
      paths.staged,
      paths.previousTmp,
      paths.commitTmp,
    ],
    paths: paths,
  };
}

module.exports = {
  VALUE_SCHEMA,
  CHECKSUM_ALGORITHM,
  CHECKSUM_ENCODING,
  buildPayload,
  canonicalStringify,
  checksumPayload,
  getStorePaths,
  getValueDir,
  readGeneration,
  recover,
  validateWrappedGeneration,
  wrapPayload,
  writeGeneration,
};
