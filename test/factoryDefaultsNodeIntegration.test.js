const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');

const factoryDefaultsStore = require('../lib/factoryDefaultsStore');

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

function makeRED(context) {
  let constructors = {};
  let nodes = {};
  let configNodes = [];
  return {
    nodes: {
      registerType(name, ctor) {
        constructors[name] = ctor;
      },
      createNode(node, config) {
        let emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.__emitter = emitter;
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
        node.send = function(message) {
          node.__sent.push(message);
        };
        node.__errors = [];
        node.__warnings = [];
        node.__sent = [];
        if (config.id) {
          nodes[config.id] = node;
        }
      },
      getNode(id) {
        return nodes[id];
      },
      eachConfig(callback) {
        configNodes.forEach(callback);
      },
    },
    httpAdmin: {
      get() {},
      post() {},
    },
    auth: {
      needsPermission() {
        return function() {};
      },
    },
    settings: {
      functionGlobalContext: {
        sharedStateDir: context.get('sharedStateDir'),
      },
    },
    __constructors: constructors,
    __configNodes: configNodes,
  };
}

async function makeStateDir(t) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-node-'));
  t.after(async function() {
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

async function waitForInit() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test('factory-defaults node resets selected states from factory-defaults.json', async function(t) {
  let stateDir = await makeStateDir(t);
  let context = makeContext(stateDir);
  let RED = makeRED(context);
  require('../lib/state')(RED);
  require('../lib/factoryDefaults')(RED);

  let StateCtor = RED.__constructors['shared-state'];
  let FactoryCtor = RED.__constructors['factory-defaults'];

  let stateNode = new StateCtor({
    id: 'state-1',
    type: 'shared-state',
    name: 'myNumber',
    historyCount: '0',
    dataType: 'num',
    defaultValue: '5',
    saveInterval: '0',
    __context: context,
  });
  await waitForInit();
  await stateNode.update(12);

  await factoryDefaultsStore.writeFactoryDefaults(stateDir, {
    myNumber: 42,
  });

  let factoryNode = new FactoryCtor({
    id: 'factory-1',
    name: 'Factory',
    useFile: true,
    states: JSON.stringify([{name: 'myNumber', enabled: true}]),
    __context: context,
  });

  let result = await factoryNode.factoryReset({
    command: 'factoryReset',
    all: true,
    confirm: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].state, 'myNumber');
  assert.equal(result.updated[0].source, 'factory-defaults.json');
  assert.equal(stateNode.value, 42);
  assert.equal(stateNode.prev, 12);
  assert.equal(factoryNode.__status.fill, 'green');
});

test('factory-defaults node falls back to state defaultValue when file is missing', async function(t) {
  let stateDir = await makeStateDir(t);
  let context = makeContext(stateDir);
  let RED = makeRED(context);
  require('../lib/state')(RED);
  require('../lib/factoryDefaults')(RED);

  let StateCtor = RED.__constructors['shared-state'];
  let FactoryCtor = RED.__constructors['factory-defaults'];

  let stateNode = new StateCtor({
    id: 'state-1',
    type: 'shared-state',
    name: 'myNumber',
    historyCount: '0',
    dataType: 'num',
    defaultValue: '5',
    saveInterval: '0',
    __context: context,
  });
  await waitForInit();
  await stateNode.update(12);

  let factoryNode = new FactoryCtor({
    id: 'factory-1',
    name: 'Factory',
    useFile: true,
    states: JSON.stringify([{name: 'myNumber', enabled: true}]),
    __context: context,
  });

  let result = await factoryNode.factoryReset({
    command: 'factoryReset',
    all: true,
    confirm: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated[0].source, 'defaultValue');
  assert.equal(stateNode.value, 5);
  assert.equal(factoryNode.__status.fill, 'yellow');
});

test('factory-defaults node resets falsy values from factory-defaults.json', async function(t) {
  let stateDir = await makeStateDir(t);
  let context = makeContext(stateDir);
  let RED = makeRED(context);
  require('../lib/state')(RED);
  require('../lib/factoryDefaults')(RED);

  let StateCtor = RED.__constructors['shared-state'];
  let FactoryCtor = RED.__constructors['factory-defaults'];
  let configs = [
    {id: 'state-num', name: 'myNumber', dataType: 'num', defaultValue: '9', current: 7, expected: 0},
    {id: 'state-str', name: 'myText', dataType: 'str', defaultValue: 'fallback', current: 'x', expected: ''},
    {id: 'state-bool', name: 'myBool', dataType: 'bool', defaultValue: 'true', current: true, expected: false},
    {id: 'state-obj', name: 'myObject', dataType: 'obj', defaultValue: '{"fallback":true}', current: {x: 1}, expected: null},
  ];
  let stateNodes = {};
  for (let i = 0; i < configs.length; i++) {
    let config = configs[i];
    let stateNode = new StateCtor({
      id: config.id,
      type: 'shared-state',
      name: config.name,
      historyCount: '0',
      dataType: config.dataType,
      defaultValue: config.defaultValue,
      saveInterval: '0',
      __context: context,
    });
    await waitForInit();
    await stateNode.update(config.current);
    stateNodes[config.name] = stateNode;
  }

  await factoryDefaultsStore.writeFactoryDefaults(stateDir, {
    myBool: false,
    myNumber: 0,
    myObject: null,
    myText: '',
  });

  let factoryNode = new FactoryCtor({
    id: 'factory-1',
    name: 'Factory',
    useFile: true,
    states: JSON.stringify(configs.map(function(config) {
      return {name: config.name, enabled: true};
    })),
    __context: context,
  });

  let result = await factoryNode.factoryReset({
    command: 'factoryReset',
    all: true,
    confirm: true,
  });

  assert.equal(result.ok, true);
  configs.forEach(function(config) {
    assert.deepEqual(stateNodes[config.name].value, config.expected);
  });
});

test('factory-defaults node requires explicit confirmation', async function(t) {
  let stateDir = await makeStateDir(t);
  let context = makeContext(stateDir);
  let RED = makeRED(context);
  require('../lib/factoryDefaults')(RED);
  let FactoryCtor = RED.__constructors['factory-defaults'];
  let factoryNode = new FactoryCtor({
    id: 'factory-1',
    name: 'Factory',
    useFile: false,
    states: '[]',
    __context: context,
  });

  await assert.rejects(
    () => factoryNode.factoryReset({command: 'factoryReset'}),
    /confirm/
  );
});

test('factory-defaults node generates template from active shared states', async function(t) {
  let stateDir = await makeStateDir(t);
  let context = makeContext(stateDir);
  let RED = makeRED(context);
  require('../lib/state')(RED);
  require('../lib/factoryDefaults')(RED);

  let StateCtor = RED.__constructors['shared-state'];
  let FactoryCtor = RED.__constructors['factory-defaults'];

  new StateCtor({
    id: 'state-1',
    type: 'shared-state',
    name: 'myNumber',
    historyCount: '0',
    dataType: 'num',
    defaultValue: '5',
    saveInterval: '0',
    __context: context,
  });
  await waitForInit();

  let factoryNode = new FactoryCtor({
    id: 'factory-1',
    name: 'Factory',
    useFile: true,
    states: JSON.stringify([{name: 'myNumber', enabled: true}]),
    __context: context,
  });

  let result = await factoryNode.generateTemplate({command: 'generateTemplate'});
  assert.equal(result.ok, true);
  assert.equal(result.document.defaults.myNumber, 5);

  let fileResult = await factoryDefaultsStore.readFactoryDefaults(stateDir);
  assert.equal(fileResult.ok, true);
  assert.equal(fileResult.document.defaults.myNumber, 5);
});
