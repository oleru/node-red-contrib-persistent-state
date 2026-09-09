/**
 * The MIT License
 *
 * Copyright (c) 2026, node-red-contrib-persistent-state maintainers
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

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const persistentStore = require('./persistentStore');

const FACTORY_DEFAULTS_SCHEMA = 'persistent-state.factory-defaults.v1';
const FACTORY_DEFAULTS_FILE = 'factory-defaults.json';

function getFactoryDefaultsPath(sharedStateDir) {
  return path.join(sharedStateDir, FACTORY_DEFAULTS_FILE);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateStateName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) {
    throw new Error('Factory default state name must match ^[A-Za-z_][A-Za-z0-9_]*$: ' + name);
  }
}

function assertJsonCompatible(value, fieldPath) {
  persistentStore.buildPayload({
    name: 'factoryDefaultValue',
    value: value,
    previous: null,
    timestamp: 0,
    sequence: 0,
  });
}

function validateDocument(document) {
  if (!isPlainObject(document)) {
    throw new Error('factory-defaults.json must contain a JSON object');
  }
  if (document.schema !== FACTORY_DEFAULTS_SCHEMA) {
    throw new Error('factory-defaults.json schema must be ' + FACTORY_DEFAULTS_SCHEMA);
  }
  if (!isPlainObject(document.defaults)) {
    throw new Error('factory-defaults.json defaults must be an object');
  }

  Object.keys(document.defaults).forEach(function(stateName) {
    validateStateName(stateName);
    assertJsonCompatible(document.defaults[stateName], 'defaults.' + stateName);
  });

  return document;
}

function canonicalDocument(defaults) {
  let sortedDefaults = {};
  Object.keys(defaults || {}).sort().forEach(function(stateName) {
    sortedDefaults[stateName] = defaults[stateName];
  });
  return {
    schema: FACTORY_DEFAULTS_SCHEMA,
    defaults: sortedDefaults,
  };
}

function stringifyDocument(document) {
  return JSON.stringify(canonicalDocument(document.defaults), null, 2) + '\n';
}

async function readFactoryDefaults(sharedStateDir) {
  let filePath = getFactoryDefaultsPath(sharedStateDir);
  try {
    let content = await fsp.readFile(filePath, 'utf8');
    let document;
    try {
      document = JSON.parse(content);
    } catch (e) {
      return {
        ok: false,
        status: 'invalid',
        reason: 'invalid-json',
        message: e.message,
        path: filePath,
      };
    }
    try {
      return {
        ok: true,
        status: 'valid',
        path: filePath,
        document: validateDocument(document),
      };
    } catch (e) {
      return {
        ok: false,
        status: 'invalid',
        reason: 'invalid-format',
        message: e.message,
        path: filePath,
      };
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        status: 'missing',
        reason: 'missing',
        message: 'factory-defaults.json is missing',
        path: filePath,
      };
    }
    return {
      ok: false,
      status: 'unreadable',
      reason: 'unreadable',
      code: e.code,
      message: e.message,
      path: filePath,
    };
  }
}

async function writeFactoryDefaults(sharedStateDir, defaults) {
  let filePath = getFactoryDefaultsPath(sharedStateDir);
  let document = canonicalDocument(defaults || {});
  validateDocument(document);
  await fsp.mkdir(sharedStateDir, {recursive: true});
  await fsp.writeFile(filePath, stringifyDocument(document), 'utf8');
  return {
    ok: true,
    status: 'written',
    path: filePath,
    document: document,
  };
}

function hasDefault(document, stateName) {
  return !!(document && document.defaults &&
    Object.prototype.hasOwnProperty.call(document.defaults, stateName));
}

function getDefault(document, stateName) {
  return document.defaults[stateName];
}

function makeTemplate(states, existingDocument, missingOnly) {
  let defaults = {};
  if (missingOnly && existingDocument && existingDocument.defaults) {
    defaults = Object.assign({}, existingDocument.defaults);
  }

  (states || []).forEach(function(state) {
    if (!state || !state.enabled) {
      return;
    }
    validateStateName(state.name);
    if (missingOnly && Object.prototype.hasOwnProperty.call(defaults, state.name)) {
      return;
    }
    defaults[state.name] = state.value;
  });

  let document = canonicalDocument(defaults);
  validateDocument(document);
  return document;
}

module.exports = {
  FACTORY_DEFAULTS_FILE,
  FACTORY_DEFAULTS_SCHEMA,
  canonicalDocument,
  getDefault,
  getFactoryDefaultsPath,
  hasDefault,
  makeTemplate,
  readFactoryDefaults,
  stringifyDocument,
  validateDocument,
  writeFactoryDefaults,
};
