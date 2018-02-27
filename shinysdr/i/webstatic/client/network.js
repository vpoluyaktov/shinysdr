// Copyright 2013, 2014, 2015, 2016, 2017 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

'use strict';

define([
  './events',
  './types',
  './values',
], (
  import_events,
  import_types,
  import_values
) => {
  const {
    Notifier,
  } = import_events;
  const {
    typeFromDesc,
    BulkDataT,
    blockT,
  } = import_types;
  const {
    Cell,
    CommandCell,
  } = import_values;
  
  const exports = {};
  
  function identity(x) { return x; }
  
  function statusCategory(httpStatus) {
    return Math.floor(httpStatus / 100);
  }
  exports.statusCategory = statusCategory;
  
  function makeXhrStateCallback(xhr, resolve) {
    return () => {
      if (xhr.readyState === 4) {
        resolve(xhr);
      }
    };
  }
  
  // TODO: this family of XHR wrappers is highly ad-hoc. Clean it up.
  
  function xhrpost(url, data) {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = makeXhrStateCallback(xhr, resolve);
      xhr.send(data);
      console.log(url, data);
    });
  }
  exports.xhrpost = xhrpost;
  
  function xhrdelete(url) {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('DELETE', url, true);
      xhr.onreadystatechange = makeXhrStateCallback(xhr, resolve);
      xhr.send();
      console.log('DELETE', url);
    });
  }
  exports.xhrdelete = xhrdelete;
  
  function externalGet(url, responseType) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = responseType;
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          if (statusCategory(xhr.status) === 2) {
            resolve(xhr.response);
          } else {
            reject(new Error('externalGet: ' + xhr.status + ' ' + xhr.statusText));
          }
        }
      };
      xhr.send();
    });
  }
  exports.externalGet = externalGet;
  
  function ReadWriteCell(setter, assumed, metadata) {
    Cell.call(this, metadata);
    let value = assumed;
    let remoteValue = assumed;
    let inhibitCount = 0;
    this.get = function () { return value; };
    this.set = function (newValue) {
      value = newValue;
      this.n.notify();
      setter(newValue, decAndAccept);
      inhibitCount++;
    };
    this._update = function _update(newValue) {
      remoteValue = newValue;
      if (inhibitCount === 0) {
        acceptFromNetwork();
      }
    };
    const decAndAccept = function decAndAccept() {
      inhibitCount--;
      if (inhibitCount === 0) {
        // If there are now no outstanding set requests, then the last value we got is the correct value.
        acceptFromNetwork();
      }
    };
    const acceptFromNetwork = function acceptFromNetwork() {
      value = remoteValue;
      this.n.notify();
    }.bind(this);
  }
  ReadWriteCell.prototype = Object.create(Cell.prototype, {constructor: {value: ReadWriteCell}});
  
  function ReadCell(setter, /* initial */ value, metadata, transform) {
    Cell.call(this, metadata);
    
    this._update = function(data) {
      value = transform(data);
      this.n.notify();
    }.bind(this);
    
    this.get = function() {
      return value;
    };
  }
  ReadCell.prototype = Object.create(Cell.prototype, {constructor: {value: ReadCell}});
  
  function RemoteCommandCell(setter, metadata) {
    // TODO: type is kind of useless, make it useful or make it explicitly stubbed out
    function setterAdapter(callback) {
      setter(null, callback);
    }
    CommandCell.call(this, setterAdapter, metadata);
  }
  RemoteCommandCell.prototype = Object.create(CommandCell.prototype, {constructor: {value: RemoteCommandCell}});
  //exports.CommandCell = CommandCell;  // not yet needed, params in flux, so not exported yet
  
  function BulkDataCell(setter, initialValueJson, metadata) {
    let type = metadata.value_type;
    
    let lastValue;
    {
      // Kludge because the server doesn't actually know how to deliver this properly in JSON, only binary.
      const [info, packed_data] = initialValueJson;
      if (Array.isArray(info) /* as opposed to object */) {
        switch (type.dataFormat) {
          case 'spectrum-byte': {
            const offset = info[2];
            const unpacked_data = new Float32Array(packed_data.length);
            for (let i = packed_data.length - 1; i >= 0; i--) {
              unpacked_data[i] = packed_data[i] - offset;
            }
            lastValue = [{freq: info[0], rate: info[1]}, unpacked_data];
            break;
          }
          case 'scope-float': {
            const rate = info[0];
            const data = new Float32Array(packed_data);
            lastValue = [{rate:rate}, data];
            break;
          }
          default:
            throw new Error('Unknown bulk data format');
        }
      } else {
        lastValue = initialValueJson;
      }
    }

    // kludge to ensure that widgets get all of the frames
    // TODO: put this on a more general and sound framework
    var subscriptions = [];
    
    // infoAndFFT is of the format [{freq:<number>, rate:<number>}, <Float32Array>]
    function transform(buffer) {
      let newValue;
      const view = new DataView(buffer);
      // starts at 4 due to cell-ID field
      switch (type.dataFormat) {
        case 'spectrum-byte': {
          const freq = view.getFloat64(4, true);
          const rate = view.getFloat32(4+8, true);
          const offset = view.getFloat32(4+8+4, true);
          const packed_data = new Int8Array(buffer, 4+8+4+4);
          const unpacked_data = new Float32Array(packed_data.length);
          for (let i = packed_data.length - 1; i >= 0; i--) {
            unpacked_data[i] = packed_data[i] - offset;
          }
          //console.log(id, freq, rate, data.length);
          newValue = [{freq:freq, rate:rate}, unpacked_data];
          break;
        }
        case 'scope-float': {
          const rate = view.getFloat64(4+8, true);
          const data = new Float32Array(buffer, 4+8);
          newValue = [{rate:rate}, data];
          break;
        }
        default:
          throw new Error('Unknown bulk data format');
      }

      // Deliver value
      lastValue = newValue;
      // TODO replace this with something async
      for (let i = 0; i < subscriptions.length; i++) {
        const callbackWithoutThis = subscriptions[i];
        callbackWithoutThis(newValue);
      }
      
      return newValue;
    }
    
    ReadCell.call(this, setter, lastValue, metadata, transform);
    
    this.subscribe = function(callback) {
      // TODO need to provide for unsubscribing
      subscriptions.push(callback);
      callback(lastValue);
    };
  }
  BulkDataCell.prototype = Object.create(ReadCell.prototype, {constructor: {value: BulkDataCell}});
  exports.BulkDataCell = BulkDataCell;
  
  function setNonEnum(o, p, v) {
    Object.defineProperty(o, p, {
      value: v,
      configurable: true
    });
  }
  
  function openWebSocket(wsURL) {
    // TODO: Have server deliver websocket URL, remove port number requirement
    var ws = new WebSocket(wsURL);
    ws.addEventListener('open', function (event) {
      ws.send(''); // dummy required due to server limitation
    }, true);
    return ws;
  }
  
  const minRetryTime = 1000;
  const maxRetryTime = 20000;
  const backoff = 1.05;
  function retryingConnection(wsURLFunc, connectionStateCallback, callback) {
    if (!connectionStateCallback) connectionStateCallback = function () {};

    var timeout = minRetryTime;
    var succeeded = false;
    function go() {
      const wsURL = wsURLFunc();
      const ws = openWebSocket(wsURL);
      ws.addEventListener('open', function (event) {
        succeeded = true;
        timeout = minRetryTime;
        connectionStateCallback('connected');
      }, true);
      ws.addEventListener('close', function (event) {
        if (succeeded) {
          console.error('Lost WebSocket connection', wsURL, '- reason given:', event.reason);
          connectionStateCallback('disconnected');
        } else {
          timeout = Math.min(maxRetryTime, timeout * backoff);
          connectionStateCallback('failed-connect');
        }
        succeeded = false;
        setTimeout(go, timeout);
      }, true);
      callback(ws);
    }
    go();
  }
  exports.retryingConnection = retryingConnection;
  
  function makeBlock(url, interfaces) {
    // TODO convert block operations to use state stream too
    var block = {};
    // TODO kludges, should be properly facetized and separately namespaced somehow
    setNonEnum(block, '_url', url);
    setNonEnum(block, '_reshapeNotice', new Notifier());
    interfaces.forEach(function(interfaceName) {
      // TODO: kludge
      setNonEnum(block, '_implements_' + interfaceName, true);
    });
    if (block['_implements_shinysdr.values.IWritableCollection']) {
      setNonEnum(block, 'create', function(desc) {
        // TODO arrange a callback with the resulting _object_
        xhrpost(url, JSON.stringify(desc));
      });
      setNonEnum(block, 'delete', function(key) {
        xhrdelete(url + '/' + encodeURIComponent(key));
      });
    }
    return block;
  }
  
  // TODO: too many args, figure out an object that is a sensible bundle
  function makeCell(url, setter, id, desc, idMap) {
    const type = typeFromDesc(desc.metadata.value_type);
    const metadata = {
      value_type: type,
      // deliberately discarding persists field — shouldn't be used on client
      naming: desc.metadata.naming,
    };
    var cell;
    if (type === blockT) {
      // TODO eliminate special case by making server block cells less special?
      // TODO blocks should not need urls (switch http op to websocket)
      cell = new ReadCell(setter, /* dummy */ makeBlock(url, []), metadata,
        function (id) { return idMap[id]; });
    } else if (type instanceof BulkDataT) {
      // TODO can we eliminate this special case
      cell = new BulkDataCell(setter, desc.current, metadata);
    } else if (desc.type === 'command_cell') {
      cell = new RemoteCommandCell(setter, metadata);
    } else if (desc.writable) {
      cell = new ReadWriteCell(setter, desc.current, metadata);
    } else {
      cell = new ReadCell(setter, desc.current, metadata, identity);
    }
    return [cell, cell._update];
  }
  
  // connectionStateCallback is an optional function of 2 arguments, the first being a enum-ish string identifying the state/problem/notice and the second being details.
  function connect(rootURL, connectionStateCallback) {
    if (!connectionStateCallback) connectionStateCallback = function () {};
    
    const rootCell = new ReadCell(null, null, blockT, identity);
    
    retryingConnection(() => rootURL, connectionStateCallback, ws => {
      ws.binaryType = 'arraybuffer';

      // indexed by object ids chosen by server
      const idMap = Object.create(null);
      const updaterMap = Object.create(null);
      const isCellMap = Object.create(null);
      
      const callbackMap = Object.create(null);
      let nextCallbackId = 0;
      
      idMap[0] = rootCell;
      updaterMap[0] = function (id) { rootCell._update(idMap[id]); };
      isCellMap[0] = true;
      
      function oneMessage(message) {
        const op = message[0];
        const id = message[1];
        switch (op) {
          case 'register_block': {
            const url = message[2];
            const interfaces = message[3];
            updaterMap[id] = idMap[id] = makeBlock(url, interfaces);
            isCellMap[id] = false;
            break;
          }
          case 'register_cell': {
            const url = message[2];
            const desc = message[3];
            const pair = (function () {
              function setter(value, callback) {
                var cbid = nextCallbackId++;
                callbackMap[cbid] = callback;
                ws.send(JSON.stringify(['set', id, value, cbid]));
              }
              return makeCell(url, setter, id, desc, idMap);
            }());
            idMap[id] = pair[0];
            updaterMap[id] = pair[1];
            isCellMap[id] = true;
            break;
          }
          case 'value': {
            const value = message[2];
            if (!(id in idMap)) {
              console.error('Undefined id in state stream message', message);
              return;
            }
            if (isCellMap[id]) {
              const callbackWithoutThis = updaterMap[id];
              callbackWithoutThis(value);
            } else {
              // is block
              const block = idMap[id];
              for (const oldKey in block) { delete block[oldKey]; }
              for (const newKey in value) {
                block[newKey] = idMap[value[newKey]];
              }
              block._reshapeNotice.notify();
            }
            break;
          }
          case 'delete': {
            // TODO: explicitly invalidate the objects so we catch hanging on to them too long
            delete idMap[id];
            delete updaterMap[id];
            delete isCellMap[id];
            break;
          }
          case 'done': {
            callbackMap[id]();
            delete callbackMap[id];
            break;
          }
          default:
            console.error('unknown state stream message', message);
        }
      }
      
      function oneBinaryMessage(buffer) {
        // Currently, BulkDataCell updates are the only type of binary messages.
        var view = new DataView(buffer);
        var id = view.getUint32(0, true);
        var cell_updater = updaterMap[id];
        cell_updater(buffer);
      }
      
      ws.onmessage = function (event) {
        // TODO: close connection on exception here
        if (typeof event.data === 'string') {
          JSON.parse(event.data).forEach(oneMessage);
        } else if (event.data instanceof ArrayBuffer) {
          oneBinaryMessage(event.data);
        } else {
          console.error('Unknown object from state stream onmessage:', event.data);
        }
      };
      
    });

    return rootCell;
  }
  exports.connect = connect;
  
  return Object.freeze(exports);
});
