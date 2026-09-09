const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');

const persistentStore = require('../lib/persistentStore');

function loadStateConstructor() {
  delete require.cache[require.resolve('../lib/state')];
  let StateCtor;
  let RED = {
    nodes: {
      registerType(name, ctor) {
        if (name === 'shared-state') {
          StateCtor = ctor;
        }
      },
      createNode(node, config) {
        let emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        let context = config.__context;
        node.context = function() {
          return {global: context};
        };
        node.error = function(message) {
          node.__errors.push(message);
        };
        node.warn = function(message) {
          node.__warnings.push(message);
        };
        node.status = function(status) {
          node.__status = status;
        };
        node.__errors = [];
        node.__warnings = [];
      },
    },
    httpAdmin: {
      get() {},
    },
    auth: {
      needsPermission() {
        return function() {};
      },
    },
  };
  require('../lib/state')(RED);
  return StateCtor;
}

function makeContext(sharedStateDir) {
  let values = {
    sharedStateDir,
  };
  return {
    keys() {
      return Object.keys(values);
    },
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
    },
  };
}

function makeConfig(sharedStateDir, overrides) {
  return Object.assign({
    id: 'state-1',
    name: 'myNumber',
    historyCount: '0',
    dataType: 'num',
    saveInterval: '0',
    __context: makeContext(sharedStateDir),
  }, overrides || {});
}

async function makeStateDir(t) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'state-store-integration-'));
  t.after(async function() {
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

async function waitForInit() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test('state node migrates v0.4 value directory into state directory layout', async function(t) {
  let stateDir = await makeStateDir(t);
  let legacyValueDir = persistentStore.getLegacyValueDir(stateDir, 'myNumber');
  await persistentStore.writeGeneration({
    valueDir: legacyValueDir,
    name: 'myNumber',
    value: 5,
    previous: 4,
    timestamp: 1000,
    sequence: 1,
  });

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 5);
  assert.equal(node.prev, 4);
  assert.equal(node.sequence, 2);
  assert.deepEqual(node.history, []);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.payload.value, 5);
  assert.equal(recovered.payload.sequence, 2);

  let configPath = persistentStore.getStorePaths(valueDir).config;
  let configFile = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(configFile.name, 'myNumber');
  assert.equal(configFile.valueStore.layout, 'state-directory-v1');
});

test('state node recovers compact value generation with config in same state directory', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  await persistentStore.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 8,
    prev: 7,
    timestamp: 2000,
    type: 'num',
    sequence: 3,
    bootId: 'boot-a',
    writtenAt: 2000,
  });
  let paths = persistentStore.getStorePaths(valueDir);
  await fs.writeFile(paths.config, JSON.stringify({
    schema: 'persistent-state.config.v1',
    name: 'myNumber',
    valueStore: {layout: 'state-directory-v1'},
    history: [],
    config: {},
  }), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 8);
  assert.equal(node.prev, 7);
  assert.equal(node.sequence, 3);
});

test('state node converts recovered compact value to current string data type', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  await persistentStore.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 8,
    previous: 7,
    timestamp: 2000,
    sequence: 3,
  });

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'str'}));
  await waitForInit();

  assert.equal(node.value, '8');
  assert.equal(node.prev, '7');
  assert.equal(node.sequence, 4);
  assert.equal(node.__warnings.length, 1);
  assert.match(node.__warnings[0], /converted/);

  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: ''});
  assert.equal(recovered.payload.value, '8');
  assert.equal(recovered.payload.previous, '7');
  assert.equal(recovered.payload.sequence, 4);
});

test('state node tries previous generation when active cannot convert to current number data type', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  await persistentStore.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: '7',
    previous: '6',
    timestamp: 1000,
    sequence: 2,
  });
  await persistentStore.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 'abc',
    previous: '7',
    timestamp: 2000,
    sequence: 3,
  });

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'num'}));
  await waitForInit();

  assert.equal(node.value, 7);
  assert.equal(node.prev, 6);
  assert.equal(node.sequence, 3);
  assert.equal(node.__warnings.length, 3);
  assert.match(node.__warnings[0], /Skipped recovered value generation/);
  assert.match(node.__warnings[1], /converted/);
  assert.match(node.__warnings[2], /previous value generation/);
});

test('state node rewrites old wrapped value generation as flat compact format', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  let legacyPayload = {
    schema: persistentStore.VALUE_SCHEMA,
    name: 'myNumber',
    value: 9,
    prev: 8,
    timestamp: 3000,
    type: 'num',
    sequence: 3,
    bootId: 'boot-old',
    writtenAt: 3001,
  };
  let legacyWrapped = {
    payload: legacyPayload,
    checksum: {
      algorithm: 'sha256',
      encoding: 'hex',
      value: persistentStore.checksumPayload(legacyPayload),
    },
  };
  await fs.mkdir(valueDir, {recursive: true});
  await fs.writeFile(paths.active, persistentStore.canonicalStringify(legacyWrapped), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 9);
  assert.equal(node.prev, 8);
  assert.equal(node.sequence, 4);

  let activeFile = JSON.parse(await fs.readFile(paths.active, 'utf8'));
  assert.deepEqual(Object.keys(activeFile).sort(), ['checksum', 'previous', 'sequence', 'timestamp', 'value']);
  assert.equal(activeFile.value, 9);
  assert.equal(activeFile.previous, 8);
  assert.equal(activeFile.sequence, 4);
});

test('state node converts old wrapped value generation after data type change', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  let legacyPayload = {
    schema: persistentStore.VALUE_SCHEMA,
    name: 'myNumber',
    value: 9,
    prev: 8,
    timestamp: 3000,
    type: 'num',
    sequence: 3,
    bootId: 'boot-old',
    writtenAt: 3001,
  };
  let legacyWrapped = {
    payload: legacyPayload,
    checksum: {
      algorithm: 'sha256',
      encoding: 'hex',
      value: persistentStore.checksumPayload(legacyPayload),
    },
  };
  await fs.mkdir(valueDir, {recursive: true});
  await fs.writeFile(paths.active, persistentStore.canonicalStringify(legacyWrapped), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'str'}));
  await waitForInit();

  assert.equal(node.value, '9');
  assert.equal(node.prev, '8');
  assert.equal(node.sequence, 4);
  assert.equal(node.__warnings.length, 1);
  assert.match(node.__warnings[0], /converted/);

  let activeFile = JSON.parse(await fs.readFile(paths.active, 'utf8'));
  assert.equal(activeFile.value, '9');
  assert.equal(activeFile.previous, '8');
  assert.equal(activeFile.sequence, 4);
});

test('state node coalesces concurrent writes to the latest runtime value', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  node.value = 0;
  node.prev = null;
  node.timestamp = 1;
  node.initialized = true;

  let snapshots = [];
  let firstWrite = true;
  node.writeStateSnapshot = async function(snapshot) {
    snapshots.push({
      value: snapshot.value,
      prev: snapshot.prev,
      sequence: snapshot.sequence,
    });
    if (firstWrite) {
      firstWrite = false;
      await node.update(2);
      await node.update(3);
    }
  };

  await node.update(1);

  assert.deepEqual(snapshots, [
    {value: 1, prev: 0, sequence: 2},
    {value: 3, prev: 2, sequence: 3},
  ]);
  assert.equal(node.value, 3);
  assert.equal(node.prev, 2);
  assert.equal(node.sequence, 3);
  assert.equal(node.persistInFlight, false);
  assert.equal(node.persistAgain, false);
});

test('state node writes config file without runtime value fields', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  await node.update(11);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  let configState = JSON.parse(await fs.readFile(paths.config, 'utf8'));
  assert.equal(configState.schema, 'persistent-state.config.v1');
  assert.equal(configState.name, 'myNumber');
  assert.equal(configState.valueStore.layout, 'state-directory-v1');
  assert.equal(Object.hasOwn(configState, 'value'), false);
  assert.equal(Object.hasOwn(configState, 'prev'), false);
  assert.equal(Object.hasOwn(configState, 'timestamp'), false);
  assert.deepEqual(configState.history, []);
  assert.equal(configState.config.name, 'myNumber');
  assert.equal(Object.hasOwn(configState.config, '__context'), false);
  assert.equal(Object.hasOwn(configState.config, 'legacyValueUpdates'), false);
});

test('state node moves old top-level state file aside before creating state directory', async function(t) {
  let stateDir = await makeStateDir(t);
  await fs.writeFile(path.join(stateDir, 'myNumber'), JSON.stringify({
    value: 10,
    prev: 9,
    timestamp: 1000,
    history: [],
    config: {},
  }), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  let statePath = persistentStore.getStateDir(stateDir, 'myNumber');
  let stat = await fs.stat(statePath);
  assert.equal(stat.isDirectory(), true);
  let entries = await fs.readdir(stateDir);
  assert.equal(entries.some((entry) => /^myNumber\.legacy\..*\.json$/.test(entry)), true);
  assert.equal(node.__warnings.length, 2);
  assert.match(node.__warnings[0], /Moved legacy state file aside/);
  assert.match(node.__warnings[1], /default value/);
});

test('state node stores config metadata and value generations in one state directory', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  await node.update(12);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  assert.equal(valueDir, path.join(stateDir, 'myNumber'));
  assert.equal(paths.config, path.join(stateDir, 'myNumber', 'config.json'));
  assert.equal(paths.active, path.join(stateDir, 'myNumber', 'active.json'));
  assert.equal(paths.previous, path.join(stateDir, 'myNumber', 'previous.json'));

  let configState = JSON.parse(await fs.readFile(paths.config, 'utf8'));
  assert.equal(Object.hasOwn(configState, 'value'), false);
  assert.equal(configState.valueStore.layout, 'state-directory-v1');

  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.payload.value, 12);
});

test('state node initializes number from blank default when no value exists', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'num'}));
  await waitForInit();

  assert.equal(node.value, 0);
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);
  assert.match(node.__warnings.at(-1), /default value/);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: ''});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.payload.value, 0);
  assert.equal(recovered.payload.previous, null);
  assert.equal(recovered.payload.sequence, 1);
});

test('state node initializes string from blank default when no value exists', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'str'}));
  await waitForInit();

  assert.equal(node.value, '');
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: ''});
  assert.equal(recovered.payload.value, '');
});

test('state node initializes boolean from blank default when no value exists', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {dataType: 'bool'}));
  await waitForInit();

  assert.equal(node.value, false);
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: ''});
  assert.equal(recovered.payload.value, false);
});

test('state node converts explicit default value through configured type', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    dataType: 'num',
    defaultValue: '42',
  }));
  await waitForInit();

  assert.equal(node.value, 42);
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);
});

test('state node initializes object from explicit JSON default value', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    dataType: 'obj',
    defaultValue: '{"items":[1,2],"enabled":true}',
  }));
  await waitForInit();

  assert.deepEqual(node.value, {items: [1, 2], enabled: true});
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: ''});
  assert.deepEqual(recovered.payload.value, {items: [1, 2], enabled: true});
});

test('state node reports invalid explicit object default value', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    dataType: 'obj',
    defaultValue: '{"items":',
  }));
  await waitForInit();

  assert.equal(node.initialized, false);
  assert.equal(node.persistenceError.operation, 'default');
  assert.equal(node.__errors.length, 2);
  assert.match(String(node.__errors[0]), /default state value/);
});

test('state node recovers persisted value instead of applying configured default', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  await persistentStore.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 9,
    previous: 8,
    timestamp: 2000,
    sequence: 3,
  });

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    dataType: 'num',
    defaultValue: '0',
  }));
  await waitForInit();

  assert.equal(node.value, 9);
  assert.equal(node.prev, 8);
  assert.equal(node.sequence, 3);
});

test('state node initializes from default when only config file exists', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  await fs.mkdir(valueDir, {recursive: true});
  await fs.writeFile(paths.config, JSON.stringify({
    schema: 'persistent-state.config.v1',
    name: 'myNumber',
    valueStore: {
      layout: 'state-directory-v1',
    },
    history: [],
    config: {
      name: 'myNumber',
    },
  }), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 0);
  assert.equal(node.prev, null);
  assert.equal(node.initialized, true);
  assert.match(node.__warnings[0], /default value/);
});

test('state node recovers previous value generation when active is corrupt', async function(t) {
  let stateDir = await makeStateDir(t);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let paths = persistentStore.getStorePaths(valueDir);
  let previous = persistentStore.wrapPayload(persistentStore.buildPayload({
    name: 'myNumber',
    value: 4,
    prev: 3,
    timestamp: 3000,
    type: 'num',
    sequence: 2,
    bootId: 'boot-a',
    writtenAt: 3000,
  }));
  await fs.mkdir(valueDir, {recursive: true});
  await fs.writeFile(paths.active, '{"payload":', 'utf8');
  await fs.writeFile(paths.previous, persistentStore.canonicalStringify(previous), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 4);
  assert.equal(node.sequence, 2);
  assert.equal(node.__warnings.length, 1);
  assert.match(node.__warnings[0], /previous value generation/);
});

test('state node reports invalid numeric updates clearly', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {defaultValue: '3'}));
  await waitForInit();

  await node.update('', {});

  assert.equal(node.value, 3);
  assert.deepEqual(node.__errors, [
    'Invalid value for shared-state "myNumber": expected a finite number, got ""',
  ]);
  assert.deepEqual(node.__status, {
    fill: 'red',
    shape: 'ring',
    text: 'expected a finite number, got ""',
  });
});

test('state node reports non-json updates clearly', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    dataType: 'obj',
    defaultValue: '{"ok":true}',
  }));
  await waitForInit();

  await node.update(undefined, {});

  assert.deepEqual(node.value, {ok: true});
  assert.deepEqual(node.__errors, [
    'Invalid value for shared-state "myNumber": value is not JSON-compatible: undefined',
  ]);
  assert.deepEqual(node.__status, {
    fill: 'red',
    shape: 'ring',
    text: 'value is not JSON-compatible: undefined',
  });
});

test('stream values below minimum delta update runtime without persisting', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '5',
    streamSaveInterval: '0',
    streamStableDelay: '-1',
  }));
  await waitForInit();

  await node.update(3, {});

  assert.equal(node.value, 3);
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 0);
});

test('stream values persist when minimum delta is reached and interval allows it', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '5',
    streamSaveInterval: '1',
    streamStableDelay: '0',
  }));
  await waitForInit();
  await new Promise((resolve) => setTimeout(resolve, 5));

  await node.update(5, {});

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 5);
  assert.equal(node.lastPersistedValue, 5);
});

test('stream interval minus one disables delta writes and waits for stable value', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '1',
    streamSaveInterval: '-1',
    streamStableDelay: '20',
  }));
  await waitForInit();

  await node.update(90, {});
  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let beforeStable = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(beforeStable.payload.value, 0);

  await node.update(90, {});
  await node.update(90, {});
  await new Promise((resolve) => setTimeout(resolve, 45));

  let afterStable = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(afterStable.payload.value, 90);
});

test('stream values persist a small stable value after the stable delay', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '5',
    streamSaveInterval: '0',
    streamStableDelay: '20',
  }));
  await waitForInit();

  await node.update(3, {});
  await new Promise((resolve) => setTimeout(resolve, 45));

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 3);
});

test('stream stable delay zero writes immediately when stable rule matches', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '5',
    streamSaveInterval: '-1',
    streamStableDelay: '0',
  }));
  await waitForInit();

  await node.update(3, {});

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 3);
});

test('stream values rate-limit writes and persist the latest queued value', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '1',
    streamSaveInterval: '50',
    streamStableDelay: '0',
  }));
  await waitForInit();

  await node.update(2, {});
  await node.update(4, {});
  await new Promise((resolve) => setTimeout(resolve, 75));

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 4);
});

test('stream persistence accepts runtime parameter overrides from msg.streamPersistence', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '100',
    streamSaveInterval: '3000',
    streamStableDelay: '0',
  }));
  await waitForInit();

  await node.update(3, {
    streamPersistence: {
      minimumDelta: 2,
      streamInterval: -1,
      stableDelay: 20,
    },
  });

  assert.equal(node.getMinPersistDelta(), 2);
  assert.equal(node.getStreamSaveInterval(), -1);
  assert.equal(node.getStreamStableDelay(), 20);

  await new Promise((resolve) => setTimeout(resolve, 45));

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.payload.value, 3);
});

test('stream persistence runtime overrides can update only minimum delta', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '100',
    streamSaveInterval: '3000',
    streamStableDelay: '1000',
  }));
  await waitForInit();

  await node.update(3, {
    streamPersistence: {
      minimumDelta: 2,
    },
  });

  assert.equal(node.getMinPersistDelta(), 2);
  assert.equal(node.getStreamSaveInterval(), 3000);
  assert.equal(node.getStreamStableDelay(), 1000);
});

test('stream persistence effective settings are exposed in global state', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '10',
    streamSaveInterval: '3000',
    streamStableDelay: '1000',
  }));
  await waitForInit();

  await node.update(3, {
    streamPersistence: {
      minimumDelta: 2,
      streamInterval: -1,
    },
  });

  assert.deepEqual(node.globalState.myNumber.streamPersistence, {
    enabled: true,
    minPersistDelta: 2,
    streamSaveInterval: -1,
    streamStableDelay: 1000,
    runtimeOverrides: {
      minPersistDelta: 2,
      streamSaveInterval: -1,
    },
  });
});

test('stream persistence global state updates when only runtime settings change', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {
    defaultValue: '0',
    streamValues: true,
    minPersistDelta: '10',
    streamSaveInterval: '3000',
    streamStableDelay: '1000',
  }));
  await waitForInit();

  await node.update(0, {
    streamPersistence: {
      minimumDelta: 4,
    },
  });

  assert.equal(node.value, 0);
  assert.equal(node.globalState.myNumber.streamPersistence.minPersistDelta, 4);
  assert.deepEqual(node.globalState.myNumber.streamPersistence.runtimeOverrides, {
    minPersistDelta: 4,
  });
});
