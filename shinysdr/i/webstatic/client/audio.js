// Copyright 2013, 2014, 2015, 2016, 2017, 2018 Kevin Reid <kpreid@switchb.org>
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
  './audio/bufferer',
  './events',
  './network',
  './types',
  './values',
], (
  import_audio_bufferer,
  import_events,
  import_network,
  import_types,
  import_values
) => {
  const {
    AudioBuffererImpl,
    MessageHandlerAdapter,
    delayToBufferSize,
  } = import_audio_bufferer;
  const {
    Neverfier,
    Notifier,
  } = import_events;
  const {
    retryingConnection,
  } = import_network;
  const {
    BulkDataT,
    EnumT,
    NoticeT,
    QuantityT,
    RangeT,
    anyT,
    booleanT,
    numberT,
  } = import_types;
  const {
    Cell,
    ConstantCell,
    LocalCell,
    LocalReadCell,
    StorageCell,
    cellPropOfBlock,
    makeBlock,
  } = import_values;

  const exports = {};
  
  // In connectAudio, we assume that the maximum audio bandwidth is lower than that suiting this sample rate, so that if the native sample rate is much higher than this we can send a lower one over the network without losing anything of interest.
  const ASSUMED_USEFUL_SAMPLE_RATE = 40000;
  
  // webkitAudioContext required for Safari as of version 10.1
  const AudioContext = (window.AudioContext || window.webkitAudioContext);
  exports.AudioContext = AudioContext;
  
  function connectAudio(scheduler, url, storage) {
    const audio = new AudioContext();
    const nativeSampleRate = audio.sampleRate;
    const useScriptProcessor = !('audioWorklet' in audio);
    
    // Stream parameters
    let numAudioChannels = null;
    let streamSampleRate = null;
    
    let queueNotEmpty = false;
    
    // Flags for start/stop handling
    let started = false;
    let startStopTickle = false;
    
    // Analyser for display
    var analyserAdapter = new AudioAnalyserAdapter(scheduler, audio);
    
    // User-facing status display
    // TODO should be faceted read-only when exported
    var errorTime = 0;
    function error(s) {
      info.error._update(String(s));
      errorTime = Date.now() + 1000;
    }
    var info = makeBlock({
      requested_sample_rate: makeRequestedSampleRateCell(nativeSampleRate, storage),
      buffered: new LocalReadCell(new RangeT([[0, 2]], false, false), 0),
      target: new LocalReadCell({
        value_type: new QuantityT({symbol: 's', si_prefix_ok: false}),
        naming: { label: 'Target latency' }}, ''),
      error: new LocalReadCell(new NoticeT(true), ''),
      //averageSkew: new LocalReadCell(Number, 0),
      monitor: new ConstantCell(analyserAdapter)
    });
    Object.defineProperty(info, '_implements_shinysdr.client.audio.AudioStreamStatus', {});
    function setStatus({bufferedFraction, targetSeconds, queueNotEmpty: newQueueNotEmpty}) {
      info.buffered._update(bufferedFraction);
      info.target._update(+targetSeconds.toFixed(2));  // TODO formatting kludge, should be in type instead
      if (errorTime < Date.now()) {
        info.error._update('');
      }
      queueNotEmpty = newQueueNotEmpty;
    }
    
     // Force sample rate to be a value valid for the current nativeSampleRate, which may not be the same as when the value was written to localStorage.
     info.requested_sample_rate.set(
         info.requested_sample_rate.type.round(
           info.requested_sample_rate.get(), 0));
    
    // Antialiasing filters for interpolated signal, cascaded for more attenuation.
    // Note that the cutoff frequency is set from the network callback, not here.
    const antialiasFilters = [];
    for (let i = 0; i < 12; i++) {
      const filter = audio.createBiquadFilter();
      // highshelf type, empirically, has a sharper cutoff than lowpass.
      // TODO: Learn enough about IIR filtering and what the Web Audio filter facilities are actually doing to get this to be actually optimal.
      filter.type = 'highshelf';
      filter.gain.value = -40;
      if (antialiasFilters.length) {
        antialiasFilters[antialiasFilters.length - 1].connect(filter);
      }
      antialiasFilters.push(filter);
    }
    
    const interpolationGainNode = audio.createGain();
    
    // TODO: If interpolation is 1, omit the filter from the chain. (This requires reconnecting dynamically.)
    let nodeAfterSampleSource = antialiasFilters[0];
    antialiasFilters[antialiasFilters.length - 1].connect(interpolationGainNode);
    const nodeBeforeDestination = interpolationGainNode;
    
    let buffererMessagePortPromise;
    if (useScriptProcessor) {
      const buffererMessageChannel = new MessageChannel();
      const buffererMessagePort = buffererMessageChannel.port1;
      buffererMessagePortPromise = Promise.resolve(buffererMessagePort);
      const audioBufferer = new AudioBuffererImpl(nativeSampleRate, buffererMessageChannel.port2);
      const ascr = audio.createScriptProcessor(audioBufferer.rxBufferSize, 0, 2);
      ascr.onaudioprocess = function audioprocessEventHandler(event) {
        const abuf = event.outputBuffer;
        const l = abuf.getChannelData(0);
        const r = abuf.getChannelData(1);
        audioBufferer.produceSamples(l, r);
      };
      ascr.connect(nodeAfterSampleSource);
    } else {
      buffererMessagePortPromise = audio.audioWorklet.addModule('/client/audio/bufferer.js').then(() => {
        const workletNode = new AudioWorkletNode(audio, 'WorkletBufferer', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        workletNode.addEventListener('processorstatechange', event => {
          if (workletNode.processorState !== 'running') {
            console.error('Audio: Unexpected WorkletNode state change to', workletNode.processorState);
          }
        });
        
        // TODO need to handle port not being ready
        workletNode.connect(nodeAfterSampleSource);
        
        return workletNode.port;
      }, e => {
        error('' + e);
      });
    }
    
    buffererMessagePortPromise.then(buffererMessagePort => {
      buffererMessagePort.onmessage = new MessageHandlerAdapter({
        error: error,
        setStatus: setStatus,
        checkStartStop: function checkStartStop() {
          if (!startStopTickle) {
            setTimeout(startStop, 1000);
            startStopTickle = true;
          }
        }
      });
      
      retryingConnection(
        () => url + '?rate=' + encodeURIComponent(JSON.stringify(info.requested_sample_rate.get())),
        null,
        ws => handleWebSocket(ws, buffererMessagePort));
    });
    
    function handleWebSocket(ws, buffererMessagePort) {
      ws.binaryType = 'arraybuffer';
      function lose(reason) {
        // TODO: Arrange to trigger exponential backoff if we get this kind of error promptly (maybe retryingConnection should just have a time threshold)
        console.error('Audio:', reason);
        ws.close(4000);  // first "application-specific" error code
      }
      scheduler.claim(lose);
      function changeSampleRate() {
        lose('changing sample rate');
      }
      scheduler.claim(changeSampleRate);
      info.requested_sample_rate.n.listen(changeSampleRate);
      ws.onmessage = function(event) {
        var wsDataValue = event.data;
        if (wsDataValue instanceof ArrayBuffer) {
          // Audio data.
          if (numAudioChannels === null) {
            lose('Did not receive number-of-channels message before first chunk');
            return;
          }
          
          buffererMessagePort.postMessage(['acceptSamples', wsDataValue]);
          if (!started) startStop();
          
        } else if (typeof wsDataValue === 'string') {
          // Metadata.
          
          var message;
          try {
            message = JSON.parse(wsDataValue);
          } catch (e) {
            if (e instanceof SyntaxError) {
              lose(e);
              return;
            } else {
              throw e;
            }
          }
          if (!(typeof message === 'object' && message.type === 'audio_stream_metadata')) {
            lose('Message was not properly formatted');
            return;
          }
          numAudioChannels = message.signal_type.kind === 'STEREO' ? 2 : 1;
          streamSampleRate = message.signal_type.sample_rate;
          buffererMessagePort.postMessage(['setFormat', numAudioChannels, streamSampleRate]);
          
          // TODO: We should not update the filter frequency now, but when the AudioBuffererImpl starts reading the new-rate samples. We will need to keep track of the relationship of AudioContext timestamps to samples in order to do this.
          antialiasFilters.forEach(filter => {
            // Yes, this cutoff value is above the Nyquist limit, but the actual cascaded filter works out to be about what we want.
            filter.frequency.value = Math.min(streamSampleRate * 0.8, nativeSampleRate * 0.5);
          });
          const interpolation = nativeSampleRate / streamSampleRate;
          interpolationGainNode.gain.value = interpolation;
          
          console.log('Streaming using', useScriptProcessor ? 'ScriptProcessor' : 'AudioWorklet', streamSampleRate, numAudioChannels + 'ch', 'audio and converting to', nativeSampleRate);
          
        } else {
          lose('Unexpected type from WebSocket message event: ' + wsDataValue);
          return;
        }
      };
      ws.addEventListener('close', function (event) {
        error('Disconnected.');
        numAudioChannels = null;
        setTimeout(startStop, 0);
      });
    }
    
    function startStop() {
      startStopTickle = false;
      if (queueNotEmpty) {
        if (!started) {
          // Avoid unnecessary click because previous fill value is not being played.
          buffererMessagePortPromise.then(port => { port.postMessage(['resetFill']); });
          
          started = true;
          nodeBeforeDestination.connect(audio.destination);
          analyserAdapter.connectFrom(nodeBeforeDestination);
          analyserAdapter.setLockout(false);
        }
      } else {
        if (started) {
          started = false;
          nodeBeforeDestination.disconnect(audio.destination);
          analyserAdapter.disconnectFrom(nodeBeforeDestination);
          analyserAdapter.setLockout(true);
        }
      }
    }
    
    return info;
  }
  exports.connectAudio = connectAudio;
  
  // TODO adapter should have gui settable parameters and include these
  // These options create a less meaningful and more 'decorative' result.
  const FREQ_ADJ = false;    // Compensate for typical frequency dependence in music so peaks are equal.
  const TIME_ADJ = false;    // Subtract median amplitude; hides strong beats.
  
  // Takes frequency data from an AnalyserNode and provides an interface like a MonitorSink
  function AudioAnalyserAdapter(scheduler, audioContext) {
    // Construct analyser.
    const analyserNode = audioContext.createAnalyser();
    analyserNode.smoothingTimeConstant = 0;
    try {
      analyserNode.fftSize = 16384;
    } catch (e) {
      // Safari as of version 10.1 does not support larger sizest than this, despite the specification limit being 32768.
      analyserNode.fftSize = 2048;
    }
    
    // Used to have the option to reduce this to remove empty high-freq bins from the view. Leaving that out for now.
    const length = analyserNode.frequencyBinCount;
    
    // Constant parameters for MonitorSink interface
    const effectiveSampleRate = analyserNode.context.sampleRate * (length / analyserNode.frequencyBinCount);
    const info = Object.freeze({freq: 0, rate: effectiveSampleRate});
    
    // State
    const fftBuffer = new Float32Array(length);
    let lastValue = [info, fftBuffer];
    const subscriptions = [];
    let isScheduled = false;
    const pausedCell = this.paused = new LocalCell(booleanT, true);
    let lockout = false;
    
    function update() {
      isScheduled = false;
      analyserNode.getFloatFrequencyData(fftBuffer);
    
      let absolute_adj;
      if (TIME_ADJ) {
        const medianBuffer = Array.prototype.slice.call(fftBuffer);
        medianBuffer.sort(function(a, b) {return a - b; });
        absolute_adj = -100 - medianBuffer[length / 2];
      } else {
        absolute_adj = 0;
      }
      
      let freq_adj;
      if (FREQ_ADJ) {
        freq_adj = 1;
      } else {
        freq_adj = 0;
      }
      
      for (let i = 0; i < length; i++) {
        fftBuffer[i] = fftBuffer[i] + absolute_adj + freq_adj * Math.pow(i, 0.5);
      }
      
      const newValue = [info, fftBuffer];  // fresh array, same contents, good enough.
    
      // Deliver value
      lastValue = newValue;
      maybeScheduleUpdate();
      // TODO replace this with something async
      for (let i = 0; i < subscriptions.length; i++) {
        const callbackWithoutThis = subscriptions[i];
        callbackWithoutThis(newValue);
      }
    }
    
    function maybeScheduleUpdate() {
      if (!isScheduled && subscriptions.length && !lockout) {
        if (pausedCell.get()) {
          pausedCell.n.listen(maybeScheduleUpdate);
        } else {
          isScheduled = true;
          // A basic rAF loop seems to be about the right rate to poll the AnalyserNode for new data. Using the Scheduler instead would try to run faster.
          requestAnimationFrame(update);
        }
      }
    }
    scheduler.claim(maybeScheduleUpdate);
    
    Object.defineProperty(this, 'setLockout', {value: function (value) {
      lockout = !!value;
      if (!lockout) {
        maybeScheduleUpdate();
      }
    }});
    // This interface allows us to in the future have per-channel analysers without requiring the caller to deal with that.
    Object.defineProperty(this, 'connectFrom', {value: function (inputNode) {
      inputNode.connect(analyserNode);
    }});
    Object.defineProperty(this, 'disconnectFrom', {value: function (inputNode) {
      inputNode.disconnect(analyserNode);
    }});
    
    // Output cell
    this.fft = new Cell(new BulkDataT('dff', 'b'));  // TODO BulkDataT really isn't properly involved here
    this.fft.get = function () {
      return lastValue;
    };
    // TODO: put this on a more general and sound framework (same as BulkDataCell)
    this.fft.subscribe = function (callback) {
      subscriptions.push(callback);
      maybeScheduleUpdate();
    };
    
    // Other elements expected by Monitor widget
    Object.defineProperty(this, '_implements_shinysdr.i.blocks.IMonitor', {enumerable: false});
    this.freq_resolution = new ConstantCell(length);
    this.signal_type = new ConstantCell({kind: 'USB', sample_rate: effectiveSampleRate}, anyT);
  }
  Object.defineProperty(AudioAnalyserAdapter.prototype, '_reshapeNotice', {value: new Neverfier()});
  Object.freeze(AudioAnalyserAdapter.prototype);
  Object.freeze(AudioAnalyserAdapter);
  exports.AudioAnalyserAdapter = AudioAnalyserAdapter;
  
  // Extract time-domain samples from an audio context suitable for the ScopePlot widget.
  // This is not based on AnalyserNode because AnalyserNode is single-channel and using multiple AnalyserNodes will not give time-alignment (TODO verify that).
  function AudioScopeAdapter(scheduler, audioContext) {
    // Parameters
    const bufferSize = delayToBufferSize(audioContext.sampleRate, 1/60);
    console.log('AudioScopeAdapter buffer size at', audioContext.sampleRate, 'Hz is', bufferSize);
    const nChannels = 2;
    
    // Buffers
    // We don't want to be constantly allocating new buffers or having an unbounded queue size, but we also don't want to require prompt efficient processing inside the audio callback. Therefore, have a circular buffer of buffers to hand off.
    const bufferBuffer = [1, 2, 3, 4].map(unused => {
      // TODO: It would be nice to have something reusable here. However, this is different from events.Notifier in that it doesn't require repeated re-subscription.
      let notifyScheduled = false;
      const notifyFn = () => {
        notifyScheduled = false;
        sendBuffer(copyBufferSet);
      };
      const copyBufferSet = {
        copyL: new Float32Array(bufferSize),
        copyR: new Float32Array(bufferSize),
        outputBuffer: new Float32Array(bufferSize * nChannels),
        notify: () => {
          if (!notifyScheduled) {
            notifyScheduled = true;
            requestAnimationFrame(notifyFn);
          }
        }
      };
      return copyBufferSet;
    });
    let bufferBufferPtr = 0;
    
    const captureProcessor = audioContext.createScriptProcessor(bufferSize, nChannels, nChannels);
    captureProcessor.onaudioprocess = function scopeCallback(event) {
      const inputBuffer = event.inputBuffer;
      const cellBuffer = bufferBuffer[bufferBufferPtr];
      bufferBufferPtr = (bufferBufferPtr + 1) % bufferBuffer.length;
      inputBuffer.copyFromChannel(cellBuffer.copyL, 0);
      inputBuffer.copyFromChannel(cellBuffer.copyR, 1);
      cellBuffer.notify();
    };
    captureProcessor.connect(audioContext.destination);
    
    // Cell handling and other state
    const info = {};  // dummy
    var lastValue = [info, new Float32Array(bufferSize)];
    var subscriptions = [];
    
    function sendBuffer(copyBufferSet) {
      // Do this processing now rather than in callback to minimize work done in audio callback.
      const copyL = copyBufferSet.copyL;
      const copyR = copyBufferSet.copyR;
      const outputBuffer = copyBufferSet.outputBuffer;
      for (let i = 0; i < bufferSize; i++) {
        outputBuffer[i * 2] = copyL[i];
        outputBuffer[i * 2 + 1] = copyR[i];
      }
      
      const newValue = [info, outputBuffer];
    
      // Deliver value
      lastValue = newValue;
      // TODO replace this with something async
      for (let i = 0; i < subscriptions.length; i++) {
        const callbackWithoutThis = subscriptions[i];
        callbackWithoutThis(newValue);
      }
    }
    
    // TODO: Also disconnect processor when nobody's subscribed.
    
    Object.defineProperty(this, 'connectFrom', {value: function (inputNode) {
      inputNode.connect(captureProcessor);
    }});
    Object.defineProperty(this, 'disconnectFrom', {value: function (inputNode) {
      inputNode.disconnect(captureProcessor);
    }});
    
    // Output cell
    this.scope = new Cell(new BulkDataT('d', 'f'));  // TODO BulkDataT really isn't properly involved here
    this.scope.get = function () {
      return lastValue;
    };
    // TODO: put this on a more general and sound framework (same as BulkDataCell)
    this.scope.subscribe = function (callback) {
      subscriptions.push(callback);
    };
    
    // Other elements expected by Monitor widget
    Object.defineProperty(this, '_implements_shinysdr.i.blocks.IMonitor', {enumerable: false});
    this.freq_resolution = new ConstantCell(length, numberT);
    this.signal_type = new ConstantCell({kind: 'USB', sample_rate: audioContext.sampleRate}, anyT);
  }
  Object.defineProperty(AudioScopeAdapter.prototype, '_reshapeNotice', {value: new Neverfier()});
  Object.freeze(AudioScopeAdapter.prototype);
  Object.freeze(AudioScopeAdapter);
  exports.AudioScopeAdapter = AudioScopeAdapter;
  
  function handleUserMediaError(e, showMessage, whatWeWereDoing) {
    // Note: Empirically, e is a NavigatorUserMediaError but that ctor is not exposed so we can't say instanceof.
    if (e && e.name === 'PermissionDeniedError') {
      // Permission error.
      // Note: Empirically, e.message is empty on Chrome.
      showMessage('Failed to ' + whatWeWereDoing + ' (permission denied). ' + e.message);
    } else if (e && e.name === 'NotReadableError') {
      let message = 'Failed to ' + whatWeWereDoing + ' (could not open device). ' + e.message;
      if (navigator.userAgent.match('Firefox')) {
        // Known issue; give advice rather than just being broken.
        message += '\nPlease try reloading or reopening the tab.';
      }
      showMessage(message);
    } else if (e && e.name) {
      showMessage(e.name);
    } else if (e) {
      showMessage(String(e));
      throw e;
    } else {
      throw e;
    }
  }
  exports.handleUserMediaError_ForTesting = handleUserMediaError;
  
  function MediaDeviceSelector(mediaDevices, storage) {
    let shapeNotifier = new Notifier();
    let selectorCell = null;  // set by enumerate()
    let errorCell = this.error = new LocalReadCell(new NoticeT(false), '');
    
    Object.defineProperty(this, '_reshapeNotice', {value: shapeNotifier});
    
    let enumerate = () => {
      mediaDevices.enumerateDevices().then(deviceInfos => {
        const deviceEnumTable = {};
        let defaultDeviceId = 'default';
        Array.from(deviceInfos).forEach(deviceInfo => {
          if (deviceInfo.kind !== 'audioinput') return;
          if (!defaultDeviceId) {
            defaultDeviceId = deviceInfo.deviceId;
          }
          deviceEnumTable[deviceInfo.deviceId] = String(deviceInfo.label || deviceInfo.deviceId);
          // TODO use deviceInfo.groupId as part of enum sort key
        });
        // TODO: StorageCell isn't actually meant to be re-created in this fashion and will leak stuff. Fix StorageCell.
        this.device = selectorCell = new StorageCell(storage, new EnumT(deviceEnumTable), defaultDeviceId, 'device');
        shapeNotifier.notify();
        errorCell._update('');
      }, e => {
        handleUserMediaError(e, errorCell._update.bind(errorCell), 'list audio devices');
      });
    };
    // Note: Have not managed to see this event fired in practice (Chrome and Firefox on Mac).
    mediaDevices.addEventListener('devicechange', event => enumerate(), false);
    enumerate();
  }
  
  function UserMediaOpener(scheduler, audioContext, deviceIdCell) {
    // TODO: Does not need to be an unbreakable notify loop; have something which is a generalization of DerivedCell that handles async computations.
    const output = audioContext.createGain();  // dummy node to be switchable
    
    makeBlock(this);
    let errorCell = this.error = new LocalReadCell(new NoticeT(false), '');
    Object.defineProperty(this, 'source', {value: output});
    
    let previousSource = null;
    function setOutput(newSource) {
      if (newSource !== previousSource && previousSource !== null) {
        previousSource.disconnect(output);
      }
      if (newSource !== null) {
        newSource.connect(output);
      }
      previousSource = newSource;
    }
    
    scheduler.startNow(function update() {
      const deviceId = deviceIdCell.depend(update);
      if (typeof deviceId !== 'string') {
        setOutput(null);
      } else {
        navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            // If we do not disable default-enabled echoCancellation then we get mono
            // audio on Chrome. See:
            //    https://bugs.chromium.org/p/chromium/issues/detail?id=387737
            echoCancellation: { exact: false }  // using 'ideal:' doesn't help.
          }
        }).then((stream) => {
          // TODO: There is supposedly a better version of this in the future (MediaStreamTrackSource)
          // TODO: In case selector gets changed multiple times, have a token to cancel earlier requests
          setOutput(audioContext.createMediaStreamSource(stream));
          errorCell._update('');
        }, (e) => {
          setOutput(null);
          // TODO: Get device's friendly name for error message
          handleUserMediaError(e, errorCell._update.bind(errorCell),
              'open audio device ' + JSON.stringify(deviceId));
        });
      }
    });
  }

  function UserMediaSelector(scheduler, audioContext, mediaDevices, storage) {
    const mediaDeviceSelector = new MediaDeviceSelector(mediaDevices, storage);
    const userMediaOpener = new UserMediaOpener(scheduler, audioContext,
        cellPropOfBlock(scheduler, mediaDeviceSelector, 'device', false));
    
    // TODO: this is not a good block/cell structure, we are exposing our implementation organization.
    makeBlock(this);
    this.selector = new ConstantCell(mediaDeviceSelector);
    this.opener = new ConstantCell(userMediaOpener);
    Object.defineProperty(this, 'source', {value: userMediaOpener.source});
  }
  exports.UserMediaSelector = UserMediaSelector;
  
  function makeRequestedSampleRateCell(nativeSampleRate, storage) {
    const defaultRate = minimizeSampleRate(nativeSampleRate, ASSUMED_USEFUL_SAMPLE_RATE);
    const ranges = [];
    for (let rate = nativeSampleRate; rate >= 6000 && rate == rate | 0; rate /= 2) {
      ranges.push([rate, rate]);
    }
    if (ranges.length === 0) {
      ranges.push([defaultRate, defaultRate]);
    }
    return new StorageCell(
      storage,
      new RangeT(ranges, false, true, {symbol: 'Hz', si_prefix_ok: true}),
      defaultRate,
      'requested_sample_rate');
  }
  
  // Find the smallest (sample rate) number which divides highRate (so can be upsampled by the resampling implemented here) while being larger than lowerLimitRate (so as to avoid obligating the source to discard wanted frequency content) unless highRate is already lower.
  function minimizeSampleRate(highRate, lowerLimitRate) {
    let divisor = Math.floor(highRate / lowerLimitRate);
    if (highRate / divisor < lowerLimitRate) {
      // Fix up bad rounding (TODO: haven't proven this to be necessary)
      divisor--;
    }
    if (divisor === 0) {
      // highRate is already less than lowerLimitRate.
      return highRate;
    }
    const minimizedRate = highRate / divisor;
    if (minimizedRate < lowerLimitRate || !isFinite(minimizedRate)) {
      throw new Error('oops');
    }
    return minimizedRate;
  }
  exports.minimizeSampleRate_ForTesting = minimizeSampleRate;
    
  return Object.freeze(exports);
});