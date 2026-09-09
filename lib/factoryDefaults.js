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

const factoryDefaultsStore = require('./factoryDefaultsStore');

let RED;
const factoryDefaults = module.exports = function(red) {
  RED = red;
  RED.nodes.registerType('factory-defaults', factoryDefaultsNode);
  factoryDefaultsNode.registerEndpoints(RED);
};

class factoryDefaultsNode {

  constructor(config) {
    let node = this;
    RED.nodes.createNode(node, config);
    node.config = config;
    node.name = config.name || 'factory defaults';
    node.useFile = config.useFile !== false && config.useFile !== 'false';
    node.states = node.parseStates(config.states);
    node.sharedStateDir = node.getSharedStateDir();

    node.refreshFileStatus();

    node.on('input', async function(msg, send, done) {
      send = send || function(output) { node.send(output); };
      try {
        let command = node.getCommand(msg);
        let result;
        if (command.command === 'validateFile') {
          result = await node.validateFile();
        } else if (command.command === 'generateTemplate') {
          result = await node.generateTemplate(command);
        } else if (command.command === 'factoryReset') {
          result = await node.factoryReset(command);
        } else {
          throw new Error('Unsupported factory-defaults command: ' + command.command);
        }
        send({
          topic: 'factory-defaults/' + command.command,
          payload: result,
        });
        if (done) {
          done();
        }
      } catch (e) {
        node.status({fill: 'red', shape: 'dot', text: e.message});
        if (done) {
          done(e);
        } else {
          node.error(e, msg);
        }
      }
    });
  }

  getSharedStateDir() {
    let node = this;
    let globalContext = node.context().global;
    return globalContext.get('sharedStateDir') || './shared-state';
  }

  parseStates(rawStates) {
    if (!rawStates) {
      return [];
    }
    if (Array.isArray(rawStates)) {
      return rawStates;
    }
    try {
      let parsed = JSON.parse(rawStates);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  getCommand(msg) {
    let command = msg && msg.payload;
    if (typeof command === 'string') {
      command = {command: command};
    }
    command = Object.assign({}, command || {});
    if (msg && msg.command && !command.command) {
      command.command = msg.command;
    }
    command.command = command.command || 'factoryReset';
    return command;
  }

  getSharedStates() {
    let node = this;
    let states = [];
    if (!node.context().global.keys().includes('state')) {
      return states;
    }
    let globalState = node.context().global.get('state') || {};
    Object.keys(globalState).sort().forEach(function(stateName) {
      let entry = globalState[stateName];
      if (entry && entry.config) {
        let stateNode = RED.nodes.getNode(entry.config.id);
        if (stateNode && stateNode.update && stateNode.getTypedValue) {
          states.push({
            name: stateName,
            config: entry.config,
            node: stateNode,
            value: entry.value,
          });
        }
      }
    });
    return states;
  }

  getSelectedStateNames(command) {
    let node = this;
    if (Array.isArray(command.states)) {
      return command.states;
    }
    if (command.all) {
      return node.states
        .filter(function(state) { return state.enabled !== false; })
        .map(function(state) { return state.name; });
    }
    return node.states
      .filter(function(state) { return state.enabled !== false; })
      .map(function(state) { return state.name; });
  }

  resolveDesignValue(stateName) {
    let node = this;
    let selected = node.states.find(function(state) {
      return state.name === stateName;
    });
    if (!selected || !Object.prototype.hasOwnProperty.call(selected, 'value')) {
      return undefined;
    }
    return selected.value;
  }

  async readFactoryFile() {
    let node = this;
    if (!node.useFile) {
      return {
        ok: false,
        status: 'disabled',
        document: null,
      };
    }
    return factoryDefaultsStore.readFactoryDefaults(node.sharedStateDir);
  }

  async validateFile() {
    let node = this;
    let result = await node.readFactoryFile();
    node.setFileStatus(result);
    return result;
  }

  async refreshFileStatus() {
    let node = this;
    let result = await node.readFactoryFile();
    node.setFileStatus(result);
  }

  setFileStatus(result) {
    let node = this;
    if (!node.useFile || result.status === 'disabled') {
      node.status({fill: 'grey', shape: 'ring', text: 'file disabled'});
    } else if (result.status === 'valid') {
      let count = Object.keys(result.document.defaults).length;
      node.status({fill: 'green', shape: 'dot', text: 'factory defaults: ' + count + ' ready'});
    } else if (result.status === 'missing') {
      node.status({fill: 'yellow', shape: 'ring', text: 'factory-defaults.json missing'});
    } else {
      node.status({fill: 'red', shape: 'ring', text: 'invalid factory-defaults.json'});
    }
  }

  getFallbackDefault(sharedStateNode) {
    if (!sharedStateNode || !sharedStateNode.getDefaultRawValue) {
      return undefined;
    }
    return sharedStateNode.getTypedValue(sharedStateNode.getDefaultRawValue());
  }

  resolveFactoryValue(state, fileResult) {
    let node = this;
    if (fileResult && fileResult.ok &&
        factoryDefaultsStore.hasDefault(fileResult.document, state.name)) {
      return {
        source: 'factory-defaults.json',
        value: factoryDefaultsStore.getDefault(fileResult.document, state.name),
      };
    }

    let designValue = node.resolveDesignValue(state.name);
    if (designValue !== undefined) {
      return {
        source: 'factory-defaults node',
        value: designValue,
      };
    }

    return {
      source: 'defaultValue',
      value: node.getFallbackDefault(state.node),
    };
  }

  async factoryReset(command) {
    let node = this;
    if (command.confirm !== true) {
      throw new Error('factoryReset requires confirm: true');
    }

    let fileResult = await node.readFactoryFile();
    node.setFileStatus(fileResult);
    if (node.useFile && fileResult.status !== 'valid' && fileResult.status !== 'missing') {
      return {
        ok: false,
        updated: [],
        skipped: [],
        failed: [{
          state: null,
          reason: fileResult.reason || fileResult.status,
          message: fileResult.message,
        }],
      };
    }

    let requested = node.getSelectedStateNames(command);
    let activeStates = node.getSharedStates();
    let byName = {};
    activeStates.forEach(function(state) {
      byName[state.name] = state;
    });

    let updated = [];
    let skipped = [];
    let failed = [];

    for (let i = 0; i < requested.length; i++) {
      let stateName = requested[i];
      let state = byName[stateName];
      if (!state || !state.node) {
        skipped.push({state: stateName, reason: 'not-active'});
        continue;
      }
      try {
        let resolved = node.resolveFactoryValue(state, fileResult);
        let typedValue = state.node.getTypedValue(resolved.value);
        await state.node.update(typedValue);
        updated.push({
          state: stateName,
          source: resolved.source,
          value: state.node.value,
        });
      } catch (e) {
        failed.push({
          state: stateName,
          reason: 'invalid-value',
          message: e.message,
        });
      }
    }

    let result = {
      ok: failed.length === 0,
      updated: updated,
      skipped: skipped,
      failed: failed,
    };

    if (failed.length > 0) {
      node.status({fill: 'red', shape: 'dot', text: 'reset failed: ' + failed.length + ' states'});
    } else if (node.useFile && fileResult.status === 'missing') {
      node.status({fill: 'yellow', shape: 'ring', text: 'reset fallback: ' + updated.length + ' states'});
    } else {
      node.status({fill: 'green', shape: 'dot', text: 'reset: ' + updated.length + ' states'});
    }
    return result;
  }

  getTemplateStates() {
    let node = this;
    let activeStates = node.getSharedStates();
    return activeStates.map(function(state) {
      let configured = node.states.find(function(selected) {
        return selected.name === state.name;
      }) || {};
      let value = configured.value;
      if (value === undefined || value === '') {
        value = node.getFallbackDefault(state.node);
      }
      return {
        name: state.name,
        enabled: configured.enabled !== false,
        value: value,
      };
    });
  }

  async generateTemplate(command) {
    let node = this;
    let existing = null;
    if (command.missingOnly) {
      let existingResult = await factoryDefaultsStore.readFactoryDefaults(node.sharedStateDir);
      if (existingResult.ok) {
        existing = existingResult.document;
      }
    }
    let document = factoryDefaultsStore.makeTemplate(node.getTemplateStates(), existing, !!command.missingOnly);
    if (command.write !== false) {
      await factoryDefaultsStore.writeFactoryDefaults(node.sharedStateDir, document.defaults);
    }
    let result = {
      ok: true,
      path: factoryDefaultsStore.getFactoryDefaultsPath(node.sharedStateDir),
      document: document,
      written: command.write !== false,
    };
    node.status({fill: 'green', shape: 'dot', text: 'template: ' + Object.keys(document.defaults).length + ' states'});
    return result;
  }

}

factoryDefaultsNode.registerEndpoints = function(RED) {
  function getSharedStateDir(req) {
    let globalContext = RED.settings && RED.settings.functionGlobalContext;
    return (globalContext && globalContext.sharedStateDir) || './shared-state';
  }

  function listConfiguredSharedStates() {
    let states = [];
    if (RED.nodes.eachConfig) {
      RED.nodes.eachConfig(function(configNode) {
        if (configNode.type === 'shared-state') {
          states.push({
            id: configNode.id,
            name: configNode.name,
            dataType: configNode.dataType || 'str',
            defaultValue: configNode.defaultValue,
          });
        }
      });
    }
    states.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });
    return states;
  }

  RED.httpAdmin.get('/shared-state/factory-defaults/states', RED.auth.needsPermission('sharedstate.read'), function(req, response) {
    response.json({
      states: listConfiguredSharedStates(),
    });
  });

  RED.httpAdmin.get('/shared-state/factory-defaults/validate', RED.auth.needsPermission('sharedstate.read'), async function(req, response) {
    let result = await factoryDefaultsStore.readFactoryDefaults(getSharedStateDir(req));
    response.json(result);
  });

  RED.httpAdmin.post('/shared-state/factory-defaults/template', RED.auth.needsPermission('sharedstate.write'), async function(req, response) {
    try {
      let body = req.body || {};
      let states = Array.isArray(body.states) ? body.states : [];
      let existing = null;
      if (body.missingOnly) {
        let existingResult = await factoryDefaultsStore.readFactoryDefaults(getSharedStateDir(req));
        if (existingResult.ok) {
          existing = existingResult.document;
        }
      }
      let document = factoryDefaultsStore.makeTemplate(states, existing, !!body.missingOnly);
      let result = await factoryDefaultsStore.writeFactoryDefaults(getSharedStateDir(req), document.defaults);
      response.json(result);
    } catch (e) {
      response.status(400).json({
        ok: false,
        message: e.message,
      });
    }
  });
};

module.exports.factoryDefaultsNode = factoryDefaultsNode;
