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

/**
 * State
 * Node-Red Config Node: state
 * Node-Red Package: shared-state
 *
 * Attributes:
 *   initialized  - Don't rely on state until after the `change` event
 *   value        - Current state value
 *   prev         - Previous state value
 *   timestamp    - Date object of the last state change
 *   history      - Deprecated compatibility field. Kept as an empty array.
 *
 * Methods:
 *   update(newState) - Change the state value. If this is different from the 
 *                      current state it will be persisted and a change event emitted.
 *
 * Events:
 *   init   - The state is being initialized on program load.
 *   change - State has changed. This object is passed with the event.
 */
const fs = require('fs')
const { promisify } = require('util')
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const rename = promisify(fs.rename)
const path = require('path')
const persistentStore = require('./persistentStore')
const mkdirp = require('mkdirp');
const convertUnits = require('convert-units');
const _ = require('lodash');

let RED;
const state = module.exports = function(red) {
  RED = red;
  RED.nodes.registerType("shared-state", stateNode);
  stateNode.registerEndpoints(RED);
}

// The Node-RED node for state
class stateNode {

  constructor(config) {
    let node = this;
    RED.nodes.createNode(node, config);
    let globalContext = node.context().global;
    node.id = config.id;
    node.name = config.name;
    node.config = config;

    node.initialized = false;
    node.value = "";
    node.prev = "";
    node.timestamp = 0;
    node.history = [];
    node.persistenceError = null;
    node.lastPersistedTimestamp = 0;
    node.lastPersistedValue = undefined;
    node.runtimeStreamPersistence = {};
    node.pendingPersistTimer = null;
    node.persistInFlight = false;
    node.persistAgain = false;
    node.sequence = 0;

    let sharedStateDir = globalContext.get('sharedStateDir') || './shared-state';
    node.sharedStateDir = sharedStateDir;
    node.stateDir = persistentStore.getStateDir(sharedStateDir, node.name);
    try {
      node.moveLegacyFileBlockingStateDir();
      if (mkdirp.sync) {
        mkdirp.sync(node.stateDir);
      } else {
        mkdirp(node.stateDir);
      }
    }
    catch (e) {
      node.error('Unable to create storage directory: ' + node.stateDir);
      node.error(e);
      node.setPersistenceError('mkdir', e, node.stateDir);
    }
    node.stateFile = path.join(node.stateDir, 'config.json');
    node.valueDir = persistentStore.getValueDir(sharedStateDir, node.name);

    // Initialize from global context if available
    if (globalContext.keys().indexOf('state') < 0) {
      globalContext.set('state', {});
    }
    node.globalState = globalContext.get('state');
    let thisState = node.globalState[node.name];
    if (thisState) {
      node.initFromObj(thisState);
    }

    // Initialize from the filesystem on Node-RED reboot
    if (!node.initialized) {
      node.initFromFS();
    }

    // Set pre-initialized global state
    if (!node.initialized) {
      node.globalState[node.name] = node.exposedState();
    }

    node.on('close', function() {
      node.cancelPendingPersist();
    });
  }

  moveLegacyFileBlockingStateDir() {
    let node = this;
    let legacyPath = node.stateDir;
    if (!fs.existsSync(legacyPath)) {
      return;
    }
    let stat = fs.statSync(legacyPath);
    if (stat.isDirectory()) {
      return;
    }
    let suffix = new Date().toISOString().replace(/[:.]/g, '-');
    let migratedPath = legacyPath + '.legacy.' + suffix + '.json';
    fs.renameSync(legacyPath, migratedPath);
    node.warn('Moved legacy state file aside before creating state directory: ' + migratedPath);
  }

  // Produce an object to be shared as state
  exposedState() {
    let node = this;
    return {
      value: node.value,
      prev: node.prev,
      timestamp: node.timestamp,
      history: node.history,
      config: node.config,
      persistenceError: node.persistenceError,
    };
  }

  // Update the state
  async update(newState, fromMsg) {
    let node = this;
    node.applyStreamPersistenceOverrides(fromMsg);
    let typedNewState;
    try {
      typedNewState = node.getTypedValue(newState, fromMsg);
    } catch (e) {
      node.status({fill:"red", shape:"ring", text:e.message});
      node.error('Invalid value for shared-state "' + node.name + '": ' + e.message);
      return;
    }
    let newvalstr;
    let currentvalstr;
    try {
      newvalstr = JSON.stringify(typedNewState);
      if (newvalstr === undefined) {
        throw new Error('value is not JSON-compatible: undefined');
      }
      currentvalstr = JSON.stringify(node.value);
    } catch (e) {
      node.status({fill:"red", shape:"ring", text:e.message});
      node.error('Invalid value for shared-state "' + node.name + '": ' + e.message);
      return;
    }
			// @colincoder Changes to deal with issues when the node type is Object
    if (newvalstr == currentvalstr) { 
		return;
	}

	// With objects this makes prev and value share the same memory which 
	// makes the .prev value and .value value point to the same Object. 
	// So create new objects so that the comparison above detects an actual change.
	// This fix will work for non-objects too.
	//    node.prev = node.value;
	//    node.value = typedNewState;
    node.prev = JSON.parse(currentvalstr);
    node.value = JSON.parse(newvalstr);
			// @colincoder End of changes to deal with issues when the node type is Object
    node.timestamp = Date.now();
    node.initialized = true;
    try {
      await node.handlePersistenceAfterUpdate();
      node.globalState[node.name] = node.exposedState();
      node.emit('change', node.exposedState());
    } 
    catch (e) {
      node.error('Error writing state file: ' + node.stateFile);
      node.error(e);
    }

  }

  getSaveInterval() {
    let node = this;
    let interval = parseInt(node.config.saveInterval, 10);
    if (isNaN(interval) || interval < 0) {
      return 0;
    }
    return interval;
  }

  isStreamPersistenceEnabled() {
    let node = this;
    return node.config.dataType == 'num' &&
      (node.config.streamValues === true || node.config.streamValues === 'true');
  }

  getMinPersistDelta() {
    let node = this;
    let delta = node.getRuntimeNumberConfig('minPersistDelta', node.config.minPersistDelta);
    if (!Number.isFinite(delta) || delta < 0) {
      return 1;
    }
    return delta;
  }

  getStreamSaveInterval() {
    let node = this;
    let interval = node.getRuntimeNumberConfig('streamSaveInterval', node.config.streamSaveInterval);
    if (isNaN(interval) || interval < 0) {
      return 3000;
    }
    return Math.floor(interval);
  }

  getStreamStableDelay() {
    let node = this;
    let delay = node.getRuntimeNumberConfig('streamStableDelay', node.config.streamStableDelay);
    if (isNaN(delay) || delay < 0) {
      return 1000;
    }
    return Math.floor(delay);
  }

  getRuntimeNumberConfig(name, configuredValue) {
    let node = this;
    if (Object.prototype.hasOwnProperty.call(node.runtimeStreamPersistence, name)) {
      return node.runtimeStreamPersistence[name];
    }
    return parseFloat(configuredValue);
  }

  applyStreamPersistenceOverrides(fromMsg) {
    let node = this;
    if (!fromMsg || !fromMsg.streamPersistence ||
        typeof fromMsg.streamPersistence !== 'object' ||
        Array.isArray(fromMsg.streamPersistence)) {
      return;
    }

    let source = fromMsg.streamPersistence;
    node.applyRuntimeStreamNumber(source, ['minPersistDelta', 'minimumDelta']);
    node.applyRuntimeStreamNumber(source, ['streamSaveInterval', 'streamInterval']);
    node.applyRuntimeStreamNumber(source, ['streamStableDelay', 'stableDelay']);
  }

  applyRuntimeStreamNumber(source, aliases) {
    let node = this;
    for (let i = 0; i < aliases.length; i++) {
      let alias = aliases[i];
      if (!Object.prototype.hasOwnProperty.call(source, alias)) {
        continue;
      }
      let value = parseFloat(source[alias]);
      if (Number.isFinite(value) && value >= 0) {
        node.runtimeStreamPersistence[aliases[0]] = value;
      } else {
        node.warn('Ignored invalid stream persistence override "' + alias + '": ' + source[alias]);
      }
      return;
    }
  }

  async handlePersistenceAfterUpdate() {
    let node = this;
    if (node.isStreamPersistenceEnabled()) {
      await node.handleStreamPersistenceAfterUpdate();
      return;
    }

    let prev_ts = node.lastPersistedTimestamp || 0;
    let elapsed = node.timestamp - prev_ts;
    let clockMovedBackwards = node.timestamp < prev_ts;
    let saveInterval = node.getSaveInterval();
    if (clockMovedBackwards || elapsed >= saveInterval) {
      await node.persistCurrentState();
    } else {
      node.schedulePersist(saveInterval - elapsed);
    }
  }

  async handleStreamPersistenceAfterUpdate() {
    let node = this;
    let prev_ts = node.lastPersistedTimestamp || 0;
    let elapsed = node.timestamp - prev_ts;
    let clockMovedBackwards = node.timestamp < prev_ts;
    let interval = node.getStreamSaveInterval();
    let minDelta = node.getMinPersistDelta();
    let delta = node.getDeltaFromLastPersistedValue();
    let stableDelay = node.getStreamStableDelay();

    if (clockMovedBackwards ||
        node.lastPersistedValue === undefined) {
      await node.persistCurrentState();
      return;
    }

    if (interval === 0) {
      if (stableDelay > 0 && !node.jsonEquals(node.value, node.lastPersistedValue)) {
        node.schedulePersist(stableDelay, true);
      }
      return;
    }

    if (delta >= minDelta && elapsed >= interval) {
      await node.persistCurrentState();
      return;
    }

    if (delta >= minDelta) {
      node.schedulePersist(interval - elapsed);
      return;
    }

    if (stableDelay > 0 && !node.jsonEquals(node.value, node.lastPersistedValue)) {
      node.schedulePersist(stableDelay, true);
    }
  }

  getDeltaFromLastPersistedValue() {
    let node = this;
    if (typeof node.value !== 'number' || typeof node.lastPersistedValue !== 'number') {
      return Infinity;
    }
    return Math.abs(node.value - node.lastPersistedValue);
  }

  markHistoryForPersist() {
    let node = this;
    node.history = [];
  }

  cancelPendingPersist() {
    let node = this;
    if (node.pendingPersistTimer) {
      clearTimeout(node.pendingPersistTimer);
      node.pendingPersistTimer = null;
    }
  }

  schedulePersist(delayMs, replaceExisting) {
    let node = this;
    if (node.pendingPersistTimer) {
      if (!replaceExisting) {
        return;
      }
      node.cancelPendingPersist();
    }
    if (delayMs === Infinity) {
      return;
    }
    node.pendingPersistTimer = setTimeout(async function() {
      node.pendingPersistTimer = null;
      try {
        await node.persistCurrentState();
        node.globalState[node.name] = node.exposedState();
      } catch (e) {
        node.error('Error writing delayed state file: ' + node.stateFile);
        node.error(e);
      }
    }, Math.max(0, delayMs));
  }

  async persistCurrentState() {
    let node = this;
    node.cancelPendingPersist();
    if (node.persistInFlight) {
      node.persistAgain = true;
      return;
    }

    node.persistInFlight = true;
    try {
      do {
        node.persistAgain = false;
        let snapshot = node.makePersistSnapshot();
        await node.writeStateSnapshot(snapshot);
        node.sequence = Math.max(node.sequence, snapshot.sequence);
        node.lastPersistedTimestamp = snapshot.timestamp;
        node.lastPersistedValue = node.cloneJson(snapshot.value);
      } while (node.persistAgain);
    } finally {
      node.persistInFlight = false;
    }
  }

  setPersistenceError(operation, error, filePath) {
    let node = this;
    node.persistenceError = {
      operation: operation,
      code: error && error.code,
      name: error && error.name,
      message: error && error.message,
      path: filePath || node.stateFile,
      timestamp: Date.now(),
    };
    if (node.status) {
      node.status({fill:"red", shape:"ring", text:operation + ": " + (node.persistenceError.code || node.persistenceError.name || "error")});
    }
    if (node.globalState) {
      node.globalState[node.name] = node.exposedState();
    }
  }

  clearPersistenceError(operation) {
    let node = this;
    if (node.persistenceError &&
        (!operation || node.persistenceError.operation == operation)) {
      node.persistenceError = null;
      if (node.status) {
        node.status({});
      }
      if (node.globalState) {
        node.globalState[node.name] = node.exposedState();
      }
    }
  }

  cloneJson(value) {
    if (value === undefined) {
      return null;
    }
    return JSON.parse(JSON.stringify(value));
  }

  makePersistSnapshot() {
    let node = this;
    node.markHistoryForPersist();
    return {
      value: node.cloneJson(node.value),
      prev: node.cloneJson(node.prev),
      timestamp: node.timestamp,
      history: [],
      config: node.config,
      sequence: node.sequence + 1,
    };
  }

  jsonEquals(a, b) {
    return JSON.stringify(a) == JSON.stringify(b);
  }

  async writeStateFile() {
    let node = this;
    return node.writeStateSnapshot(node.makePersistSnapshot());
  }

  async writeStateSnapshot(snapshot) {
    let node = this;
    let configState = node.makeConfigSnapshot(snapshot);
    let stateJson = JSON.stringify(configState);
    let valueGenerationWritten = false;
    try {
      let valueResult = await node.writeValueGeneration(snapshot);
      node.sequence = valueResult.payload.sequence;
      valueGenerationWritten = true;
      await writeFile(node.stateFile, stateJson);
      node.clearPersistenceError('write');
      return;
    } catch (e) {
      if (e.code == 'ENOENT') {
        try {
          if (mkdirp.sync) {
            mkdirp.sync(node.stateDir);
          } else {
            mkdirp(node.stateDir);
          }
          if (!valueGenerationWritten) {
            let valueResult = await node.writeValueGeneration(snapshot);
            node.sequence = valueResult.payload.sequence;
          }
          await writeFile(node.stateFile, stateJson);
          node.clearPersistenceError('write');
          return;
        } catch (retryError) {
          node.setPersistenceError('write', retryError, node.stateFile);
          throw retryError;
        }
      }
      node.setPersistenceError('write', e, node.stateFile);
      throw e;
    }
  }

  makeConfigSnapshot(snapshot) {
    let node = this;
    return {
      schema: 'persistent-state.config.v1',
      name: node.name,
      valueStore: {
        layout: 'state-directory-v1',
      },
      history: [],
      config: node.cleanConfigForFile(snapshot.config),
    };
  }

  cleanConfigForFile(config) {
    let cleanConfig = Object.assign({}, config || {});
    delete cleanConfig.__context;
    delete cleanConfig.legacyValueUpdates;
    return cleanConfig;
  }

  async writeValueGeneration(snapshot) {
    let node = this;
    let source = snapshot || node.makePersistSnapshot();
    let result = await persistentStore.writeGeneration({
      valueDir: node.valueDir,
      name: node.name,
      value: source.value,
      previous: source.prev,
      timestamp: source.timestamp,
      sequence: source.sequence,
    });
    return result;
  }

  // Perform simple data type conversions
  getTypedValue(newState, fromMsg) {
    let node = this;
    let fnName = "getTypedValue_" + node.config.dataType;
    let fromConfig = (fromMsg && fromMsg.state && fromMsg.state.config) ? fromMsg.state.config : {};
    if (!node[fnName]) {return newState}
    return node[fnName](newState, fromConfig);
  }

  getTypedValue_str(newState, fromConfig) {
    let node = this;
    let val = '' + newState;
    if (val[0] == '[' && val.match(/^\[object Object\].*/)) {
      try {
        return JSON.stringify(newState);
      } catch(e){};
    }
    return val;
  }

  getTypedValue_bool(newState, fromConfig) {
    let node = this;
    let boolType = node.config.boolType; // bool, num, str
    let boolStrTrue = node.config.boolStrTrue || 'on'; // On, Active, ...
    let boolStrFalse = node.config.boolStrFalse || 'off';  // Off, Inactive, ...

    // Convert newState to boolean if coming from another boolean state node
    if (fromConfig.dataType == 'bool' && fromConfig.boolType == 'str' && fromConfig.boolStrTrue) {
      newState = (newState == fromConfig.boolStrTrue);
    }

    // Assign to boolean if coming in as a number or number-like string
    if (Number(newState) + '' == (newState + '').trim()) {
      newState = Number(newState);
    }
    if ((typeof newState) === 'number') {
      newState = !!newState;
    }

    // Assign to boolean if coming in as a string
    if ((typeof newState) === 'string') {
      newState = newState.trim().toLowerCase();
      // Try the known string first
      if (boolType == 'str' && (newState == boolStrTrue.toLowerCase() || newState == boolStrFalse.toLowerCase())) {
        newState = (newState == boolStrTrue.toLowerCase());
      }
      // Process the only sane string conversions ("1" and "0" processed as numbers earlier)
      else if (newState == 'true' || newState == 'false') {
        newState = (newState == 'true');
      }
      // Fallback to regular javascript string->boolean mapping
      else {
        newState = !!newState;
      }
    }

    // Assign to correct boolean mapping
    if (boolType == 'str') {
      return (newState ? boolStrTrue : boolStrFalse);
    }
    else if (boolType == 'num') {
      return (newState ? 1 : 0);
    }
    return !!newState;
  }

  getTypedValue_num(newState, fromConfig) {
    let node = this;
    let rawState = newState;
    newState = parseFloat(newState); // Force a number
    if (!Number.isFinite(newState)) {
      throw new Error('expected a finite number, got ' + node.describeValue(rawState));
    }

    // Convert units if coming from another numeric node
    if (node.config.unit && fromConfig.dataType == 'num' && fromConfig.unit) {
      try {
        newState = convertUnits(newState).from(fromConfig.unit).to(node.config.unit);
        newState = Number(newState.toFixed(10)); // Don't convert to extremely large precisions
      } catch(e){
        // Don't create a number if it can't be used.
        throw new Error('cannot convert numeric unit from ' + fromConfig.unit + ' to ' + node.config.unit);
      }
    }

    // Round to precision
    if (node.config.precision) {
      newState = Number(newState.toFixed(node.config.precision));
    }

    // Apply min/max
    if (node.config.numMin && newState < node.config.numMin) {
      newState = node.config.numMin;
    }
    if (node.config.numMax && newState > node.config.numMax) {
      newState = node.config.numMax;
    }

    return newState;
  }

  describeValue(value) {
    if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        return 'NaN';
      }
      if (!Number.isFinite(value)) {
        return value > 0 ? 'Infinity' : '-Infinity';
      }
    }
    try {
      return JSON.stringify(value);
    } catch(e) {}
    return String(value);
  }

  getTypedValue_obj(newState, fromConfig) {
    let node = this;
    // Try JSON parsing a string
    if (typeof newState === 'string') {
      try {
        newState = JSON.parse(newState);
      } catch(e) {}
    }
    return newState;
  }

  hasConfiguredDefaultValue() {
    let node = this;
    return node.config.defaultValue !== undefined &&
      node.config.defaultValue !== null &&
      node.config.defaultValue !== '';
  }

  getDefaultRawValue() {
    let node = this;
    if (node.hasConfiguredDefaultValue()) {
      if (node.config.dataType == 'obj' && typeof node.config.defaultValue === 'string') {
        return JSON.parse(node.config.defaultValue);
      }
      return node.config.defaultValue;
    }

    if (node.config.dataType == 'num') {
      return 0;
    }
    if (node.config.dataType == 'bool') {
      return false;
    }
    if (node.config.dataType == 'obj') {
      return null;
    }
    return '';
  }

  async initFromDefaultValue() {
    let node = this;
    let timestamp = Date.now();
    let payload = node.convertRecoveredPayload({
      value: node.getDefaultRawValue(),
      previous: null,
      timestamp: timestamp,
      sequence: Math.max(node.sequence + 1, 1),
    });
    node.initFromValuePayload(payload);
    await node.writeStateSnapshot({
      value: node.value,
      prev: node.prev,
      timestamp: node.timestamp,
      history: [],
      config: node.config,
      sequence: node.sequence,
    });
    node.lastPersistedTimestamp = node.timestamp || 0;
    node.warn('Initialized state from default value: ' + node.name);
  }

  async initFromDefaultValueOrReport() {
    let node = this;
    try {
      await node.initFromDefaultValue();
      return true;
    } catch (defaultError) {
      node.error('Error initializing default state value: ' + node.name);
      node.error(defaultError);
      node.setPersistenceError('default', defaultError, node.stateFile);
      return false;
    }
  }

  // Deprecated compatibility helper kept for older local integrations.
  trimHistory() {
    let node = this;
    let trimNum = node.history.length - node.config.historyCount;
    if (trimNum > 0) {
      node.history.splice(node.history.length - trimNum, trimNum);
    }
  }

  convertRecoveredPayload(payload) {
    let node = this;
    let value = node.getTypedValue(payload.value);
    let previous = payload.previous;
    let previousChanged = false;

    if (previous !== null && previous !== undefined) {
      let convertedPrevious = node.getTypedValue(previous);
      try {
        persistentStore.buildPayload({
          name: node.name,
          value: value,
          previous: convertedPrevious,
          timestamp: payload.timestamp,
          sequence: payload.sequence,
        });
        previousChanged = !node.jsonEquals(convertedPrevious, previous);
        previous = convertedPrevious;
      } catch (e) {
        previous = null;
        previousChanged = true;
      }
    }

    persistentStore.buildPayload({
      name: node.name,
      value: value,
      previous: previous,
      timestamp: payload.timestamp,
      sequence: payload.sequence,
    });

    return {
      value: value,
      previous: previous,
      timestamp: payload.timestamp,
      sequence: payload.sequence,
      converted: !node.jsonEquals(value, payload.value) || previousChanged,
    };
  }

  recoverTypedGeneration(recovered) {
    let node = this;
    let candidates = (recovered.diagnostics || []).filter(function(candidate) {
      return candidate.ok;
    }).sort(function(a, b) {
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

    for (let i = 0; i < candidates.length; i++) {
      let candidate = candidates[i];
      try {
        let payload = node.convertRecoveredPayload(candidate.payload);
        return {
          status: 'recovered',
          source: candidate.source,
          format: candidate.format,
          payload: payload,
          converted: payload.converted,
          skipped: candidates.slice(0, i),
        };
      } catch (e) {
        node.warn('Skipped recovered value generation that does not match current data type: ' + candidate.source);
      }
    }

    return {
      status: 'missing',
    };
  }

  // Initialize from an external state object
  initFromObj(external) {
    let node = this;
    let recoveredPayload = node.convertRecoveredPayload({
      value: external.value,
      previous: external.prev,
      timestamp: external.timestamp,
      sequence: external.sequence || node.sequence || 0,
    });
    node.value = recoveredPayload.value,
    node.prev = recoveredPayload.previous,
    node.timestamp = external.timestamp,
    node.history = [],
    node.persistenceError = null,
    node.lastPersistedTimestamp = node.timestamp || 0,
    node.lastPersistedValue = node.cloneJson(node.value),
    node.sequence = recoveredPayload.sequence,
    node.cancelPendingPersist(),
    node.globalState[node.name] = node.exposedState();
    node.emit('init', node.exposedState());
    node.initialized = true;
    return recoveredPayload;
  }

  initFromValuePayload(payload) {
    let node = this;
    return node.initFromObj({
      value: payload.value,
      prev: payload.previous,
      timestamp: payload.timestamp,
      history: [],
      config: node.config,
      sequence: payload.sequence,
    });
  }

  async quarantineInvalidStateFile(error) {
    let node = this;
    let suffix = new Date().toISOString().replace(/[:.]/g, '-');
    let corruptFile = node.stateFile + '.corrupt.' + suffix;
    try {
      await rename(node.stateFile, corruptFile);
      node.warn('Moved invalid state file to: ' + corruptFile);
    } catch (renameError) {
      node.error('Unable to quarantine invalid state file: ' + node.stateFile);
      node.error(renameError);
    }
    node.setPersistenceError('read', error, node.stateFile);
  }

  // Initialize state from the filesystem
  async initFromFS() {
    let node = this;
    if (await node.recoverFromValueDir(node.valueDir)) {
      return;
    }

    let legacyValueDir = persistentStore.getLegacyValueDir(node.sharedStateDir, node.name);
    if (legacyValueDir !== node.valueDir &&
        await node.recoverFromValueDir(legacyValueDir, 'v0.4 value directory')) {
      await node.writeStateFile();
      node.warn('Migrated state from v0.4 value directory to state directory: ' + node.stateDir);
      return;
    }

    try {
      let file = await readFile(node.stateFile);
      let legacyState;
      try {
        legacyState = JSON.parse(file);
      } catch (parseError) {
        await node.quarantineInvalidStateFile(parseError);
        await node.initFromDefaultValueOrReport();
        return;
      }
      if (!legacyState.config && !legacyState.valueStore) {
        node.warn('Config file has no runtime value; using default value: ' + node.stateFile);
      }
      node.clearPersistenceError('read');
      await node.initFromDefaultValueOrReport();
    } catch (e) {
      if (e.code == 'ENOENT') {
        // Config file doesn't yet exist.
        await node.initFromDefaultValueOrReport();
        return;
      }
      node.error('Error reading config file: ' + node.stateFile);
      node.error(e);
      node.setPersistenceError('read', e, node.stateFile);
    }
  }

  async recoverFromValueDir(valueDir, sourceLabel) {
    let node = this;
    try {
      let recovered = await persistentStore.recover({
        valueDir: valueDir,
        name: node.name,
        type: '',
      });
      let typedRecovery = node.recoverTypedGeneration(recovered);
      if (typedRecovery.status == 'recovered') {
        node.initFromValuePayload(typedRecovery.payload);
        if (typedRecovery.format == 'legacyWrapped' || typedRecovery.converted) {
          let migrateResult = await node.writeValueGeneration();
          node.sequence = migrateResult.payload.sequence;
        }
        if (typedRecovery.converted) {
          node.warn('Recovered state value converted to current data type: ' + node.name);
        }
        if (typedRecovery.source == 'previous') {
          node.warn('Recovered state from previous value generation: ' + valueDir);
        }
        if (sourceLabel) {
          node.warn('Recovered state from ' + sourceLabel + ': ' + valueDir);
        }
        node.clearPersistenceError('read');
        return true;
      }
    } catch (e) {
      node.error('Error recovering persistent value store: ' + valueDir);
      node.error(e);
      node.setPersistenceError('recover', e, valueDir);
    }
    return false;
  }

}

// Register config support endpoints
stateNode.registerEndpoints = function(RED) {
  RED.httpAdmin.get('/shared-state/units', RED.auth.needsPermission('sharedstate.read'), function(req, response) {
    response.json(convertUnits().list());
  });
}
