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
const isValidVarName = require('is-valid-var-name');
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
    node.pendingPersistTimer = null;
    node.persistInFlight = false;
    node.persistAgain = false;
    node.sequence = 0;

    let stateDir = globalContext.get('sharedStateDir') || './shared-state';
    let valueRoot = globalContext.get('sharedStateValueDir');
    node.stateDir = stateDir;
    try {
      if (mkdirp.sync) {
        mkdirp.sync(stateDir);
      } else {
        mkdirp(stateDir);
      }
    }
    catch (e) {
      node.error('Unable to create storage directory: ' + stateDir);
      node.error(e);
      node.setPersistenceError('mkdir', e, stateDir);
    }
    node.stateFile = path.join(stateDir, node.name);
    node.valueDir = persistentStore.getValueDir(stateDir, node.name, valueRoot);

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
    let typedNewState = node.getTypedValue(newState, fromMsg);
			// @colincoder Changes to deal with issues when the node type is Object
    let newvalstr = JSON.stringify(typedNewState);
    let currentvalstr = JSON.stringify(node.value);
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
      var prev_ts = node.lastPersistedTimestamp || 0;
      const elapsed = node.timestamp - prev_ts;
      const clockMovedBackwards = node.timestamp < prev_ts;
      let saveInterval = node.getSaveInterval();
      if (clockMovedBackwards || elapsed >= saveInterval) {
        await node.persistCurrentState();
      } else {
        node.schedulePersist(saveInterval - elapsed);
      }
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

  shouldUpdateLegacyValueFile() {
    let node = this;
    return !(
      node.config.legacyValueUpdates === false ||
      node.config.legacyValueUpdates === 'false' ||
      node.config.legacyValueUpdates === '0'
    );
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

  schedulePersist(delayMs) {
    let node = this;
    if (node.pendingPersistTimer) {
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

  async writeStateFile() {
    let node = this;
    return node.writeStateSnapshot(node.makePersistSnapshot());
  }

  async writeStateSnapshot(snapshot) {
    let node = this;
    let persistedState = node.makeLegacyStateSnapshot(snapshot);
    let stateJson = JSON.stringify(persistedState);
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

  makeLegacyStateSnapshot(snapshot) {
    let node = this;
    if (node.shouldUpdateLegacyValueFile()) {
      return {
        value: snapshot.value,
        prev: snapshot.prev,
        timestamp: snapshot.timestamp,
        history: snapshot.history,
        config: snapshot.config,
      };
    }
    return {
      valueStore: {
        mode: 'compact',
        legacyValueUpdates: false,
      },
      history: [],
      config: snapshot.config,
    };
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
    newState = parseFloat(newState); // Force a number
    if (isNaN(newState)) {
      return newState; // Fail miserably if source can't be made a number
    }

    // Convert units if coming from another numeric node
    if (node.config.unit && fromConfig.dataType == 'num' && fromConfig.unit) {
      try {
        newState = convertUnits(newState).from(fromConfig.unit).to(node.config.unit);
        newState = Number(newState.toFixed(10)); // Don't convert to extremely large precisions
      } catch(e){
        // Don't create a number if it can't be used.
        newState = NaN;
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

  // Deprecated compatibility helper kept for older local integrations.
  trimHistory() {
    let node = this;
    let trimNum = node.history.length - node.config.historyCount;
    if (trimNum > 0) {
      node.history.splice(node.history.length - trimNum, trimNum);
    }
  }

  // Initialize from an external state object
  initFromObj(external) {
    let node = this;
    node.value = external.value,
    node.prev = external.prev,
    node.timestamp = external.timestamp,
    node.history = [],
    node.persistenceError = null,
    node.lastPersistedTimestamp = node.timestamp || 0,
    node.sequence = external.sequence || node.sequence || 0,
    node.cancelPendingPersist(),
    node.globalState[node.name] = node.exposedState();
    node.emit('init', node.exposedState());
    node.initialized = true;
  }

  initFromValuePayload(payload) {
    let node = this;
    node.initFromObj({
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
    try {
      let recovered = await persistentStore.recover({
        valueDir: node.valueDir,
        name: node.name,
        type: node.config.dataType || '',
      });
      if (recovered.status == 'recovered') {
        node.initFromValuePayload(recovered.payload);
        if (recovered.format == 'legacyWrapped') {
          let migrateResult = await node.writeValueGeneration();
          node.sequence = migrateResult.payload.sequence;
        }
        if (recovered.source == 'previous') {
          node.warn('Recovered state from previous value generation: ' + node.valueDir);
        }
        node.clearPersistenceError('read');
        return;
      }
    } catch (e) {
      node.error('Error recovering persistent value store: ' + node.valueDir);
      node.error(e);
      node.setPersistenceError('recover', e, node.valueDir);
    }

    try {
      let file = await readFile(node.stateFile);
      try {
        let legacyState = JSON.parse(file);
        if (legacyState.valueStore && legacyState.valueStore.legacyValueUpdates === false) {
          node.warn('Legacy state file is config-only and has no recoverable value: ' + node.stateFile);
          return;
        }
        node.initFromObj(legacyState);
        try {
          let migrateResult = await node.writeValueGeneration();
          node.sequence = migrateResult.payload.sequence;
        } catch (migrateError) {
          node.error('Error migrating legacy state to value store: ' + node.valueDir);
          node.error(migrateError);
          node.setPersistenceError('migrate', migrateError, node.valueDir);
        }
        node.clearPersistenceError('read');
      } catch (parseError) {
        await node.quarantineInvalidStateFile(parseError);
      }
    } catch (e) {
      if (e.code == 'ENOENT') {
        // State file doesn't yet exist.
        return;
      }
      node.error('Error reading state file: ' + node.stateFile);
      node.error(e);
      node.setPersistenceError('read', e, node.stateFile);
    }
  }

}

// Register config support endpoints
stateNode.registerEndpoints = function(RED) {
  RED.httpAdmin.get('/shared-state/units', RED.auth.needsPermission('sharedstate.read'), function(req, response) {
    response.json(convertUnits().list());
  });
}
