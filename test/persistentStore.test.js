const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../lib/persistentStore');

async function makeValueDir(t) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-store-'));
  t.after(async function() {
    await fs.rm(root, {recursive: true, force: true});
  });
  return store.getValueDir(root, 'myNumber');
}

async function writeRaw(filePath, value) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, value, 'utf8');
}

test('canonicalStringify sorts object keys recursively', function() {
  assert.equal(
    store.canonicalStringify({b: 1, a: {d: 4, c: 3}, e: [ {g: 7, f: 6} ]}),
    '{"a":{"c":3,"d":4},"b":1,"e":[{"f":6,"g":7}]}'
  );
});

test('wrapPayload creates flat compact generation with checksum', function() {
  let payload = store.buildPayload({
    value: 7,
    previous: 6,
    timestamp: 1000,
    sequence: 1,
  });
  let wrapped = store.wrapPayload(payload);
  assert.deepEqual(Object.keys(wrapped).sort(), ['checksum', 'previous', 'sequence', 'timestamp', 'value']);
  assert.equal(typeof wrapped.checksum, 'string');
  let valid = store.validateWrappedGeneration(wrapped, {name: 'myNumber', type: 'num'}, 'active');
  assert.equal(valid.ok, true);
  assert.equal(valid.format, 'compact');

  wrapped.value = 8;
  let invalid = store.validateWrappedGeneration(wrapped, {name: 'myNumber', type: 'num'}, 'active');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'checksum-mismatch');
});

test('state names are restricted to ASCII letters digits and underscore', function() {
  assert.equal(store.getStateDir('/tmp/shared-state', 'Horizontal_pos_act'), path.join('/tmp/shared-state', 'Horizontal_pos_act'));
  assert.throws(function() {
    store.getStateDir('/tmp/shared-state', 'horizontal-pos-act');
  }, /ASCII letters/);
  assert.throws(function() {
    store.getStateDir('/tmp/shared-state', 'my$value');
  }, /ASCII letters/);
  assert.throws(function() {
    store.getStateDir('/tmp/shared-state', 'æøå');
  }, /ASCII letters/);
  assert.throws(function() {
    store.getStateDir('/tmp/shared-state', '1startsWithDigit');
  }, /ASCII letters/);
});

test('reader accepts previous wrapped payload/checksum generation format', function() {
  let legacyPayload = {
    schema: store.VALUE_SCHEMA,
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
      value: store.checksumPayload(legacyPayload),
    },
  };

  let valid = store.validateWrappedGeneration(legacyWrapped, {name: 'myNumber', type: 'num'}, 'active');
  assert.equal(valid.ok, true);
  assert.equal(valid.format, 'legacyWrapped');
  assert.deepEqual(valid.payload, {
    value: 9,
    previous: 8,
    timestamp: 3000,
    sequence: 3,
  });
});

test('writeGeneration writes active generation and recovers it', async function(t) {
  let valueDir = await makeValueDir(t);
  await store.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 7,
    previous: 6,
    timestamp: 2000,
    type: 'num',
    sequence: 1,
    bootId: 'boot-a',
    writtenAt: 2000,
  });

  let paths = store.getStorePaths(valueDir);
  let activeFile = JSON.parse(await fs.readFile(paths.active, 'utf8'));
  assert.deepEqual(Object.keys(activeFile).sort(), ['checksum', 'previous', 'sequence', 'timestamp', 'value']);

  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.source, 'active');
  assert.equal(recovered.payload.value, 7);
  assert.equal(recovered.payload.previous, 6);
  assert.equal(recovered.payload.sequence, 1);
});

test('value payload supports JSON-compatible scalar and tree values', async function(t) {
  let valueDir = await makeValueDir(t);
  let values = [
    {value: 'text', type: 'str'},
    {value: 123.45, type: 'num'},
    {value: true, type: 'bool'},
    {value: [1, 'two', false, {nested: ['x', 'y']}], type: 'obj'},
    {
      value: {
        system: 'MDC',
        enabled: true,
        limits: {min: -180, max: 180},
        points: [
          {x: 1, y: 2},
          {x: 3, y: 4},
        ],
      },
      type: 'obj',
    },
  ];

  for (let i = 0; i < values.length; i++) {
    await store.writeGeneration({
      valueDir,
      name: 'myNumber',
      value: values[i].value,
      previous: i === 0 ? null : values[i - 1].value,
      timestamp: 1000 + i,
      type: values[i].type,
      sequence: i + 1,
      bootId: 'boot-json',
      writtenAt: 1000 + i,
    });

    let recovered = await store.recover({valueDir, name: 'myNumber'});
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.payload.sequence, i + 1);
    assert.deepEqual(recovered.payload.value, values[i].value);
  }
});

test('value payload rejects values that JSON cannot preserve safely', function() {
  assert.throws(function() {
    store.buildPayload({name: 'bad', value: undefined, sequence: 1});
  }, /JSON-compatible/);

  assert.throws(function() {
    store.buildPayload({name: 'bad', value: NaN, sequence: 1});
  }, /finite JSON number/);

  assert.throws(function() {
    store.buildPayload({name: 'bad', value: function() {}, sequence: 1});
  }, /JSON-compatible/);

  let circular = {};
  circular.self = circular;
  assert.throws(function() {
    store.buildPayload({name: 'bad', value: circular, sequence: 1});
  }, /circular references/);
});

test('second write moves old active generation to previous', async function(t) {
  let valueDir = await makeValueDir(t);
  await store.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 7,
    previous: 6,
    timestamp: 2000,
    type: 'num',
    sequence: 1,
    bootId: 'boot-a',
    writtenAt: 2000,
  });
  await store.writeGeneration({
    valueDir,
    name: 'myNumber',
    value: 8,
    previous: 7,
    timestamp: 1000,
    type: 'num',
    sequence: 2,
    bootId: 'boot-b',
    writtenAt: 1000,
  });

  let paths = store.getStorePaths(valueDir);
  let active = await store.readGeneration(paths.active, {name: 'myNumber', type: 'num'}, 'active');
  let previous = await store.readGeneration(paths.previous, {name: 'myNumber', type: 'num'}, 'previous');
  assert.equal(active.ok, true);
  assert.equal(previous.ok, true);
  assert.equal(active.payload.value, 8);
  assert.equal(active.payload.previous, 7);
  assert.equal(previous.payload.value, 7);
  assert.equal(previous.payload.previous, 6);
});

test('recovery uses sequence rather than wall-clock timestamp', async function(t) {
  let valueDir = await makeValueDir(t);
  let paths = store.getStorePaths(valueDir);
  let active = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 10,
    previous: 9,
    timestamp: 1000,
    type: 'num',
    sequence: 2,
    bootId: 'boot-b',
    writtenAt: 1000,
  }));
  let previous = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 9,
    previous: 8,
    timestamp: 999999999,
    type: 'num',
    sequence: 1,
    bootId: 'boot-a',
    writtenAt: 999999999,
  }));
  await writeRaw(paths.active, store.canonicalStringify(active));
  await writeRaw(paths.previous, store.canonicalStringify(previous));

  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.source, 'active');
  assert.equal(recovered.payload.value, 10);
});

test('corrupt active generation recovers previous generation', async function(t) {
  let valueDir = await makeValueDir(t);
  let paths = store.getStorePaths(valueDir);
  let previous = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 4,
    previous: 3,
    timestamp: 4000,
    type: 'num',
    sequence: 4,
    bootId: 'boot-a',
    writtenAt: 4000,
  }));
  await writeRaw(paths.active, '{"payload":');
  await writeRaw(paths.previous, store.canonicalStringify(previous));

  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.source, 'previous');
  assert.equal(recovered.payload.value, 4);
  assert.equal(recovered.diagnostics.find((d) => d.source === 'active').reason, 'invalid-json');
});

test('checksum mismatch is rejected and can recover previous generation', async function(t) {
  let valueDir = await makeValueDir(t);
  let paths = store.getStorePaths(valueDir);
  let active = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 11,
    previous: 10,
    timestamp: 11000,
    type: 'num',
    sequence: 11,
    bootId: 'boot-a',
    writtenAt: 11000,
  }));
  active.value = 12;
  let previous = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 10,
    previous: 9,
    timestamp: 10000,
    type: 'num',
    sequence: 10,
    bootId: 'boot-a',
    writtenAt: 10000,
  }));
  await writeRaw(paths.active, store.canonicalStringify(active));
  await writeRaw(paths.previous, store.canonicalStringify(previous));

  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.source, 'previous');
  assert.equal(recovered.payload.value, 10);
  assert.equal(recovered.diagnostics.find((d) => d.source === 'active').reason, 'checksum-mismatch');
});

test('temporary files are ignored during recovery', async function(t) {
  let valueDir = await makeValueDir(t);
  let paths = store.getStorePaths(valueDir);
  let active = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 1,
    previous: 0,
    timestamp: 1000,
    type: 'num',
    sequence: 1,
    bootId: 'boot-a',
    writtenAt: 1000,
  }));
  let staged = store.wrapPayload(store.buildPayload({
    name: 'myNumber',
    value: 99,
    previous: 1,
    timestamp: 2000,
    type: 'num',
    sequence: 99,
    bootId: 'boot-a',
    writtenAt: 2000,
  }));
  await writeRaw(paths.active, store.canonicalStringify(active));
  await writeRaw(paths.staged, store.canonicalStringify(staged));
  await writeRaw(paths.commitTmp, store.canonicalStringify(staged));

  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.source, 'active');
  assert.equal(recovered.payload.value, 1);
});

test('missing active and previous generations returns missing diagnostics', async function(t) {
  let valueDir = await makeValueDir(t);
  let recovered = await store.recover({valueDir, name: 'myNumber', type: 'num'});
  assert.equal(recovered.status, 'missing');
  assert.equal(recovered.payload, null);
  assert.deepEqual(
    recovered.diagnostics.map((d) => d.reason),
    ['missing', 'missing']
  );
});
