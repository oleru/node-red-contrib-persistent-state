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
