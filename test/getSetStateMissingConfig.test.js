const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');

function createRed() {
  let constructors = {};
  return {
    constructors,
    RED: {
      nodes: {
        registerType(name, ctor) {
          constructors[name] = ctor;
        },
        createNode(node, config) {
          let emitter = new EventEmitter();
          node.id = config.id;
          node.on = emitter.on.bind(emitter);
          node.emit = emitter.emit.bind(emitter);
          node.error = function(message) {
            node.__errors.push(message);
          };
          node.status = function(status) {
            node.__status = status;
          };
          node.__errors = [];
        },
        getNode() {
          return null;
        },
      },
    },
  };
}

test('get state reports missing shared-state config clearly', function() {
  let env = createRed();
  delete require.cache[require.resolve('../lib/getState')];
  require('../lib/getState')(env.RED);

  let GetState = env.constructors['get-shared-state'];
  let node = new GetState({
    id: 'get-1',
    type: 'get-shared-state',
    name: 'myNumber',
  });

  assert.deepEqual(node.__errors, [
    'Missing shared-state config for get state node "myNumber" (state id: missing)',
  ]);
  assert.deepEqual(node.__status, {
    fill: 'red',
    shape: 'ring',
    text: 'missing shared-state config',
  });
});

test('set state does not register input handler when shared-state config is missing', function() {
  let env = createRed();
  delete require.cache[require.resolve('../lib/getState')];
  delete require.cache[require.resolve('../lib/setState')];
  require('../lib/getState')(env.RED);
  require('../lib/setState')(env.RED);

  let SetState = env.constructors['set-shared-state'];
  let node = new SetState({
    id: 'set-1',
    type: 'set-shared-state',
    name: 'myNumber',
  });

  assert.deepEqual(node.__errors, [
    'Missing shared-state config for set state node "myNumber" (state id: missing)',
  ]);
  assert.doesNotThrow(function() {
    node.emit('input', {payload: 1});
  });
});
