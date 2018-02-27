// Copyright 2015, 2016 Kevin Reid <kpreid@switchb.org>
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
  './types',
  './values',
], (
  import_types,
  import_values
) => {
  const {
    EnumT,
    anyT,
    blockT,
    booleanT,
  } = import_types;
  const {
    ConstantCell,
    LocalCell,
    StorageCell,
    makeBlock,
  } = import_values;
  
  const exports = {};
  
  // The Coordinator manages relationships between user interface elements and the objects they control, and between user interface elements.
  function Coordinator(scheduler, freqDB, radioCell) {
    
    // Helper for tune()
    // Get mode from frequency DB for a freq.
    function bandMode(freq) {
      var foundWidth = Infinity;
      var foundMode = null;
      freqDB.inBand(freq, freq).forEach(function(record) {
        var l = record.lowerFreq;
        var u = record.upperFreq;
        var bandwidth = Math.abs(u - l);  // should not be negative but not enforced, abs for robustness
        if (bandwidth < foundWidth) {
          foundWidth = bandwidth;
          foundMode = record.mode;
        }
      });
      return foundMode;
    }

    // Options
    //   receiver: optional receiver
    //   alwaysCreate: optional boolean (false)
    //   freq: float Hz
    //   mode: optional string
    function tune(options) {
      var radio = radioCell.get();
      var alwaysCreate = options.alwaysCreate;
      var record = options.record;
      var freq = options.freq !== undefined ? +options.freq : (record && record.freq);
      // Note for mode selection that bandMode is only used if we are creating a receiver (below); this ensures that we don't undesirably change the mode on drag-tuning of an existing receiver. This is a kludge and should probably be replaced by (1) making a distinction between dragging a receiver and clicking elsewhere, (2) changing mode only if the receiver's mode was matched to the old band, or (3) changing mode on long jumps but not short ones.
      var mode = options.mode || (record && record.mode);
      var receiver = options.receiver;
      //console.log('tune', alwaysCreate, freq, mode, receiver);
    
      var receivers = radio.receivers.get();
      var fit = Infinity;
      if (!receiver && !alwaysCreate) {
        // Search for nearest matching receiver
        for (const recKey in receivers) {
          var candidate = receivers[recKey].get();
          if (!candidate.rec_freq) continue;  // sanity check
          var sameMode = candidate.mode.get() === mode;
          var thisFit = Math.abs(candidate.rec_freq.get() - freq) + (sameMode ? 0 : 1e6);
          if (thisFit < fit) {
            fit = thisFit;
            receiver = candidate;
          }
        }
      }
    
      if (receiver) {
        if (mode && receiver.mode.get() !== mode) {
          receiver.mode.set(mode);
        }
        if (receiver.device_name.get() !== radio.source_name.get()) {
          // TODO: In principle this ought to be specified by parameter rather than fixed here. But this behavior is appropriate for all current use cases and we'll probably have to overhaul the whole thing anyway.
          receiver.device_name.set(radio.source_name.get());
        }
        // Frequency must be set after device name, to avoid (in case of freq_linked_to_device = true) unnecessarily tuning the old device.
        receiver.rec_freq.set(freq);
      } else {
        // TODO less ambiguous-naming api
        receivers.create({
          mode: mode || bandMode(freq) || 'AM',
          rec_freq: freq
        });
        // TODO: should return stub for receiver or have a callback or something
      }
      
      // TODO: If the record is a band, then also zoom the spectrum view to fit it.
      // (This will require knowledge of retuning which is currently done implicitly on the server side.)
      
      if (record) {
        selectedRecord.set(record);
      }
      
      return receiver;
    }
    
    
    var mapRevealAndPanCallback = null;
    function navigateMap(trackCell) {
      if (mapRevealAndPanCallback) {
        mapRevealAndPanCallback(trackCell);
      }
    }
    
    function registerMap(callback) {
      mapRevealAndPanCallback = callback;
    }
    
    var selectedRecord = new LocalCell(anyT, undefined);  // TODO should have a type
    
    // TODO: Revisit whether this is a well-designed interface
    this.actions = Object.freeze(makeBlock({
      tune: tune,
      navigateMap: navigateMap,  // TODO: caller should be able to find out whether this is effective, in the form of a cell
      _registerMap: registerMap,  // TODO: should not be on this facet
      selectedRecord: selectedRecord  // TODO generalize notion of selection/reveal
    }));
    
    Object.freeze(this);
  }
  exports.Coordinator = Object.freeze(Coordinator);
  
  // Client state: perhaps a better word would be 'preferences'.
  // (This is not really associated with the Coordinator but it has a similar relation to the rest of the system so it's in this file for now.)
  function ClientStateObject(clientStateStorage, databasePicker) {
    // TODO: Client state should be more closely associated with the components that use it, rather than centrally defined.
    
    const themeType = new EnumT({
      // TODO get list of themes
      '/client/themes/black.css': 'Dark',
      '/client/themes/gray.css': 'Gray',
    });
    const defaultTheme = '/client/themes/gray.css';
    
    function cc(key, type, value) {
      return new StorageCell(clientStateStorage, type, value, key);
    }
    return makeBlock({
      theme: cc('theme', themeType, defaultTheme),
      opengl: cc('opengl', booleanT, true),
      opengl_float: cc('opengl_float', booleanT, true),
      databases: new ConstantCell(databasePicker, blockT),
    });
  }
  exports.ClientStateObject = ClientStateObject;
  
  return Object.freeze(exports);
});