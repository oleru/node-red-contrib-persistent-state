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

test('state node migrates legacy state file into compact value store', async function(t) {
  let stateDir = await makeStateDir(t);
  await fs.writeFile(path.join(stateDir, 'myNumber'), JSON.stringify({
    value: 5,
    prev: 4,
    timestamp: 1000,
    history: [{val: 5, ts: 1000}],
    config: {},
  }), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  assert.equal(node.value, 5);
  assert.equal(node.prev, 4);
  assert.equal(node.sequence, 1);
  assert.deepEqual(node.history, []);

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.payload.value, 5);
  assert.equal(recovered.payload.sequence, 1);
});

test('state node recovers compact value store before stale legacy state file', async function(t) {
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
  await fs.writeFile(path.join(stateDir, 'myNumber'), JSON.stringify({
    value: 1,
    prev: 0,
    timestamp: 1000,
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
    {value: 1, prev: 0, sequence: 1},
    {value: 3, prev: 2, sequence: 2},
  ]);
  assert.equal(node.value, 3);
  assert.equal(node.prev, 2);
  assert.equal(node.sequence, 2);
  assert.equal(node.persistInFlight, false);
  assert.equal(node.persistAgain, false);
});

test('state node mirrors values to the legacy state file by default', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir));
  await waitForInit();

  await node.update(11);

  let legacyState = JSON.parse(await fs.readFile(path.join(stateDir, 'myNumber'), 'utf8'));
  assert.equal(legacyState.value, 11);
  assert.equal(legacyState.prev, '');
  assert.equal(legacyState.timestamp, node.timestamp);
  assert.deepEqual(legacyState.history, []);
  assert.equal(legacyState.config.name, 'myNumber');
});

test('state node can keep the legacy state file as config metadata only', async function(t) {
  let stateDir = await makeStateDir(t);
  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {legacyValueUpdates: false}));
  await waitForInit();

  await node.update(12);

  let legacyState = JSON.parse(await fs.readFile(path.join(stateDir, 'myNumber'), 'utf8'));
  assert.deepEqual(legacyState.valueStore, {
    mode: 'compact',
    legacyValueUpdates: false,
  });
  assert.equal(Object.hasOwn(legacyState, 'value'), false);
  assert.equal(Object.hasOwn(legacyState, 'prev'), false);
  assert.equal(Object.hasOwn(legacyState, 'timestamp'), false);
  assert.deepEqual(legacyState.history, []);
  assert.equal(legacyState.config.name, 'myNumber');

  let valueDir = persistentStore.getValueDir(stateDir, 'myNumber');
  let recovered = await persistentStore.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.payload.value, 12);
});

test('state node does not recover a value from a config-only legacy state file', async function(t) {
  let stateDir = await makeStateDir(t);
  await fs.writeFile(path.join(stateDir, 'myNumber'), JSON.stringify({
    valueStore: {
      mode: 'compact',
      legacyValueUpdates: false,
    },
    history: [],
    config: {
      name: 'myNumber',
      legacyValueUpdates: false,
    },
  }), 'utf8');

  let StateCtor = loadStateConstructor();
  let node = new StateCtor(makeConfig(stateDir, {legacyValueUpdates: false}));
  await waitForInit();

  assert.equal(node.value, '');
  assert.equal(node.initialized, false);
  assert.equal(node.__warnings.length, 1);
  assert.match(node.__warnings[0], /config-only/);
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
