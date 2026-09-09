const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../lib/factoryDefaultsStore');

async function makeTempDir(t) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-defaults-'));
  t.after(async function() {
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

test('factory defaults file preserves falsy JSON values', async function(t) {
  let root = await makeTempDir(t);
  await store.writeFactoryDefaults(root, {
    myBoolean: false,
    myNull: null,
    myNumber: 0,
    myString: '',
  });

  let result = await store.readFactoryDefaults(root);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'valid');
  assert.equal(store.hasDefault(result.document, 'myBoolean'), true);
  assert.equal(store.hasDefault(result.document, 'myNull'), true);
  assert.equal(store.hasDefault(result.document, 'myNumber'), true);
  assert.equal(store.hasDefault(result.document, 'myString'), true);
  assert.equal(store.getDefault(result.document, 'myBoolean'), false);
  assert.equal(store.getDefault(result.document, 'myNull'), null);
  assert.equal(store.getDefault(result.document, 'myNumber'), 0);
  assert.equal(store.getDefault(result.document, 'myString'), '');
});

test('factory defaults file supports arrays and nested object trees', async function(t) {
  let root = await makeTempDir(t);
  let value = {
    items: [1, 'two', false, null],
    nested: {
      enabled: true,
      limit: 12.5,
    },
  };

  await store.writeFactoryDefaults(root, {
    myObject: value,
  });
  let result = await store.readFactoryDefaults(root);

  assert.equal(result.ok, true);
  assert.deepEqual(result.document.defaults.myObject, value);
});

test('factory defaults read reports missing and invalid files', async function(t) {
  let root = await makeTempDir(t);

  let missing = await store.readFactoryDefaults(root);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'missing');

  await fs.writeFile(store.getFactoryDefaultsPath(root), '{"schema":', 'utf8');
  let invalidJson = await store.readFactoryDefaults(root);
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.status, 'invalid');
  assert.equal(invalidJson.reason, 'invalid-json');

  await fs.writeFile(store.getFactoryDefaultsPath(root), JSON.stringify({
    schema: 'wrong',
    defaults: {},
  }), 'utf8');
  let invalidSchema = await store.readFactoryDefaults(root);
  assert.equal(invalidSchema.ok, false);
  assert.equal(invalidSchema.status, 'invalid');
  assert.equal(invalidSchema.reason, 'invalid-format');
});

test('factory defaults rejects invalid state names and non-json values', async function(t) {
  let root = await makeTempDir(t);

  await assert.rejects(
    () => store.writeFactoryDefaults(root, {'bad-name': 1}),
    /state name/
  );

  await assert.rejects(
    () => store.writeFactoryDefaults(root, {myBadNumber: NaN}),
    /finite JSON number/
  );
});

test('factory defaults template is canonical and can add missing values only', function() {
  let full = store.makeTemplate([
    {name: 'myNumber', enabled: true, value: 0},
    {name: 'myText', enabled: true, value: ''},
    {name: 'ignored', enabled: false, value: 10},
  ]);

  assert.deepEqual(Object.keys(full.defaults), ['myNumber', 'myText']);

  let merged = store.makeTemplate([
    {name: 'myNumber', enabled: true, value: 99},
    {name: 'myBool', enabled: true, value: false},
  ], full, true);

  assert.deepEqual(merged.defaults, {
    myBool: false,
    myNumber: 0,
    myText: '',
  });
});
