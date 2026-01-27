const AudioRecorder = (() => {
    const CONFIG = {
        SAMPLE_RATE: 16000,  // Record directly at 16kHz - no downsampling needed
        BUFFER_SIZE: 4096,
        SILENCE_THRESHOLD: 25,
        BIT_DEPTH: 16,
        CHANNELS: 1,
    };

    const state = {
        audioContext: null,
        scriptProcessor: null,
        mediaSource: null,
        audioWorker: null,      // Web Worker for processing
        finalWavBuffer: null,
        isProcessingComplete: false,
    };

    // Diagnostic state to track audio callback timing
    const diagnostics = {
        startTime: null,
        lastCallbackTime: null,
        callbackCount: 0,
        totalSamplesReceived: 0,
        totalDownsampledSamples: 0,  // Track downsampled output
        actualSampleRate: null,      // Track actual device sample rate
        gaps: [],
        expectedIntervalMs: null,
    };

    const resetDiagnostics = () => {
        diagnostics.startTime = null;
        diagnostics.lastCallbackTime = null;
        diagnostics.callbackCount = 0;
        diagnostics.totalSamplesReceived = 0;
        diagnostics.totalDownsampledSamples = 0;
        diagnostics.actualSampleRate = null;
        diagnostics.gaps = [];
        diagnostics.expectedIntervalMs = null;
    };

    const logDiagnosticSummary = () => {
        const elapsedMs = performance.now() - diagnostics.startTime;
        const elapsedSec = elapsedMs / 1000;
        const actualRate = diagnostics.actualSampleRate || CONFIG.SAMPLE_RATE;
        const expectedSamples = elapsedSec * actualRate;
        const sampleRatio = diagnostics.totalSamplesReceived / expectedSamples;

        // Calculate expected vs actual downsampled samples
        const expectedDownsampled = elapsedSec * CONFIG.SAMPLE_RATE;
        const downsampleRatio = diagnostics.totalDownsampledSamples / expectedDownsampled;

        console.log('=== AUDIO RECORDING DIAGNOSTICS ===');
        console.log(`Actual device sample rate: ${actualRate} Hz`);
        console.log(`Recording duration: ${elapsedSec.toFixed(2)}s`);
        console.log(`Callback count: ${diagnostics.callbackCount}`);
        console.log(`Expected callbacks: ~${Math.floor(elapsedSec * actualRate / CONFIG.BUFFER_SIZE)}`);
        console.log(`--- Input Samples ---`);
        console.log(`  Received: ${diagnostics.totalSamplesReceived}`);
        console.log(`  Expected: ~${Math.floor(expectedSamples)}`);
        console.log(`  Ratio: ${(sampleRatio * 100).toFixed(1)}%`);
        console.log(`--- Downsampled Output ---`);
        console.log(`  Produced: ${diagnostics.totalDownsampledSamples}`);
        console.log(`  Expected: ~${Math.floor(expectedDownsampled)}`);
        console.log(`  Ratio: ${(downsampleRatio * 100).toFixed(1)}%`);
        console.log(`Gaps detected: ${diagnostics.gaps.length}`);

        if (diagnostics.gaps.length > 0) {
            console.log('--- Gap Details (first 10) ---');
            diagnostics.gaps.slice(0, 10).forEach((gap, i) => {
                const timeInRecording = (gap.timestamp - diagnostics.startTime) / 1000;
                console.log(`  Gap ${i + 1}: at ${timeInRecording.toFixed(2)}s - was ${gap.gapMs.toFixed(0)}ms (expected ~${gap.expectedMs.toFixed(0)}ms)`);
            });
        }

        if (sampleRatio < 0.95) {
            console.warn(`⚠️ MISSING ~${((1 - sampleRatio) * 100).toFixed(1)}% of audio data!`);
            console.warn('This explains the "2x speed" playback issue.');
        }
        console.log('===================================');
    };

    // On-screen diagnostic UI helpers
    const DiagnosticUI = {
        panel: null,
        elements: {},
        updateIntervalId: null,

        init() {
            this.panel = document.getElementById('diagnosticPanel');
            this.elements = {
                sampleRate: document.getElementById('diagSampleRate'),
                duration: document.getElementById('diagDuration'),
                callbacks: document.getElementById('diagCallbacks'),
                ratio: document.getElementById('diagRatio'),
                downsampleRatio: document.getElementById('diagDownsampleRatio'),
                gaps: document.getElementById('diagGaps'),
                alerts: document.getElementById('diagAlerts'),
            };
        },

        show() {
            if (this.panel) {
                this.panel.style.display = 'block';
                this.elements.alerts.innerHTML = '';
            }
        },

        hide() {
            if (this.panel) {
                this.panel.style.display = 'none';
            }
        },

        update() {
            if (!diagnostics.startTime || !this.elements.duration) return;

            const elapsedMs = performance.now() - diagnostics.startTime;
            const elapsedSec = elapsedMs / 1000;
            const actualRate = diagnostics.actualSampleRate || CONFIG.SAMPLE_RATE;
            const expectedSamples = elapsedSec * actualRate;
            const sampleRatio = expectedSamples > 0
                ? (diagnostics.totalSamplesReceived / expectedSamples) * 100
                : 100;

            // Calculate downsampling output ratio
            const expectedDownsampled = elapsedSec * CONFIG.SAMPLE_RATE;
            const downsampleRatio = expectedDownsampled > 0
                ? (diagnostics.totalDownsampledSamples / expectedDownsampled) * 100
                : 100;

            // Update sample rate display
            if (this.elements.sampleRate) {
                this.elements.sampleRate.textContent = `${actualRate} Hz`;
            }

            this.elements.duration.textContent = `${elapsedSec.toFixed(1)}s`;
            this.elements.callbacks.textContent = diagnostics.callbackCount.toString();
            this.elements.gaps.textContent = diagnostics.gaps.length.toString();

            // Update input ratio with color coding
            this.elements.ratio.textContent = `${sampleRatio.toFixed(1)}%`;
            this.elements.ratio.className = '';
            if (sampleRatio >= 95) {
                this.elements.ratio.classList.add('ratio-good');
            } else if (sampleRatio >= 80) {
                this.elements.ratio.classList.add('ratio-warn');
            } else {
                this.elements.ratio.classList.add('ratio-bad');
            }

            // Update downsampling output ratio with color coding
            if (this.elements.downsampleRatio) {
                this.elements.downsampleRatio.textContent = `${downsampleRatio.toFixed(1)}%`;
                this.elements.downsampleRatio.className = '';
                if (downsampleRatio >= 95) {
                    this.elements.downsampleRatio.classList.add('ratio-good');
                } else if (downsampleRatio >= 80) {
                    this.elements.downsampleRatio.classList.add('ratio-warn');
                } else {
                    this.elements.downsampleRatio.classList.add('ratio-bad');
                }
            }
        },

        addAlert(message, type = 'warning') {
            if (!this.elements.alerts) return;

            const alert = document.createElement('div');
            alert.className = `diag-alert ${type}`;
            alert.textContent = message;

            // Keep only last 5 alerts
            if (this.elements.alerts.children.length >= 5) {
                this.elements.alerts.removeChild(this.elements.alerts.firstChild);
            }
            this.elements.alerts.appendChild(alert);
        },

        showFinalSummary(sampleRatio) {
            const type = sampleRatio >= 95 ? 'success' : (sampleRatio >= 80 ? 'warning' : 'error');
            const message = sampleRatio >= 95
                ? `✅ Recording OK! ${sampleRatio.toFixed(1)}% samples captured`
                : `⚠️ Missing ${(100 - sampleRatio).toFixed(1)}% audio data`;
            this.addAlert(message, type);
        },

        startLiveUpdates() {
            this.stopLiveUpdates();
            this.updateIntervalId = setInterval(() => this.update(), 500);
        },

        stopLiveUpdates() {
            if (this.updateIntervalId) {
                clearInterval(this.updateIntervalId);
                this.updateIntervalId = null;
            }
        }
    };

    const getElements = () => ({
        recordBtn: document.getElementById("recordBtn"),
        downloadBtn: document.getElementById("downloadBtn"),
        removeSilenceCheckbox: document.getElementById("removeSilence"),
        micIcon: document.querySelector(".mic-icon"),
    });

    // AudioProcessor moved to Web Worker (audio-worker.js)

    const SilenceDetector = {
        // Float32 version (values between -1 and 1)
        isAbsolutelySilentFloat32(samples) {
            for (let i = 0; i < samples.length; i++) {
                if (samples[i] !== 0) return false;
            }
            return true;
        },

        isBelowThresholdFloat32(samples) {
            let sumOfSquares = 0;
            for (let i = 0; i < samples.length; i++) {
                sumOfSquares += samples[i] * samples[i];
            }
            const rms = Math.sqrt(sumOfSquares / samples.length);
            // Threshold is now in Float32 scale (0.0 to 1.0)
            // 25/32767 ≈ 0.00076 in Float32 scale
            return rms < 0.001;
        },
    };

    // WavEncoder moved to Web Worker (audio-worker.js)

    const UI = {
        setRecordingState(isRecording) {
            const { recordBtn, micIcon } = getElements();

            recordBtn.innerText = isRecording ? "Stop Recording" : "Start Recording";
            recordBtn.classList.toggle("recording", isRecording);
            micIcon?.classList.toggle("recording", isRecording);
        },

        enableDownload(enabled) {
            getElements().downloadBtn.disabled = !enabled;
        },
    };

    const RecordingController = {
        async start() {
            const { removeSilenceCheckbox } = getElements();
            const shouldRemoveInitialSilence = removeSilenceCheckbox.checked;

            resetDiagnostics();
            state.finalWavBuffer = null;
            state.isProcessingComplete = false;
            UI.enableDownload(false);

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    noiseSuppression: false,
                    echoCancellation: false,
                    autoGainControl: false,
                    channelCount: CONFIG.CHANNELS,
                },
            });

            // Try to create AudioContext with 16kHz (preferred for direct recording)
            // If not available, use native rate and downsample in worker
            let audioContext;
            try {
                audioContext = new AudioContext({ sampleRate: CONFIG.SAMPLE_RATE });
                if (audioContext.sampleRate !== CONFIG.SAMPLE_RATE) {
                    await audioContext.close();
                    audioContext = new AudioContext();
                    console.log(`Device doesn't support ${CONFIG.SAMPLE_RATE} Hz, using native ${audioContext.sampleRate} Hz (will downsample)`);
                    DiagnosticUI.addAlert(`Native ${audioContext.sampleRate} Hz → downsample to 16kHz`, 'warning');
                } else {
                    console.log(`Recording directly at ${CONFIG.SAMPLE_RATE} Hz (no downsampling needed)`);
                }
            } catch (e) {
                audioContext = new AudioContext();
                console.log(`Fallback to native sample rate: ${audioContext.sampleRate} Hz`);
            }

            state.audioContext = audioContext;
            diagnostics.actualSampleRate = state.audioContext.sampleRate;
            console.log(`AudioContext using sample rate: ${state.audioContext.sampleRate} Hz`);

            // Initialize Web Worker with source sample rate info
            state.audioWorker = new Worker('/src/audio-worker.js');
            state.audioWorker.postMessage({
                type: 'init',
                data: { sourceSampleRate: state.audioContext.sampleRate }
            });

            // Handle messages from worker
            state.audioWorker.onmessage = (event) => {
                const { type, wavBuffer, samplesProcessed, totalSamples, needsDownsampling } = event.data;

                switch (type) {
                    case 'ready':
                        if (needsDownsampling) {
                            console.log('Worker will downsample to 16kHz');
                        }
                        break;
                    case 'processed':
                        diagnostics.totalDownsampledSamples += samplesProcessed;
                        break;
                    case 'complete':
                        state.finalWavBuffer = wavBuffer;
                        state.isProcessingComplete = true;
                        UI.enableDownload(true);
                        DiagnosticUI.addAlert(`WAV ready: ${totalSamples} samples @ 16kHz`, 'success');
                        console.log(`Worker finished: WAV with ${totalSamples} samples`);
                        break;
                }
            };

            diagnostics.expectedIntervalMs = (CONFIG.BUFFER_SIZE / state.audioContext.sampleRate) * 1000;
            console.log(`Expected callback interval: ~${diagnostics.expectedIntervalMs.toFixed(1)}ms`);

            state.mediaSource = state.audioContext.createMediaStreamSource(stream);
            state.scriptProcessor = state.audioContext.createScriptProcessor(
                CONFIG.BUFFER_SIZE,
                CONFIG.CHANNELS,
                CONFIG.CHANNELS
            );

            // Track if we've started recording (for silence removal)
            let hasRecordedAudio = false;

            state.scriptProcessor.onaudioprocess = (event) => {
                if (!state.audioContext || !state.audioWorker) return;

                const now = performance.now();

                // Initialize timing on first callback
                if (diagnostics.startTime === null) {
                    diagnostics.startTime = now;
                    diagnostics.lastCallbackTime = now;
                }

                // Track timing gaps
                const elapsed = now - diagnostics.lastCallbackTime;
                const threshold = diagnostics.expectedIntervalMs * 1.8;

                if (diagnostics.callbackCount > 0 && elapsed > threshold) {
                    diagnostics.gaps.push({
                        timestamp: now,
                        gapMs: elapsed,
                        expectedMs: diagnostics.expectedIntervalMs,
                    });
                    const timeInRecording = (now - diagnostics.startTime) / 1000;
                    console.warn(`⚠️ Audio gap at ${timeInRecording.toFixed(2)}s: ${elapsed.toFixed(0)}ms`);
                    DiagnosticUI.addAlert(`Gap at ${timeInRecording.toFixed(1)}s: ${elapsed.toFixed(0)}ms`, 'warning');
                }

                diagnostics.lastCallbackTime = now;
                diagnostics.callbackCount++;

                const inputData = event.inputBuffer.getChannelData(0);
                diagnostics.totalSamplesReceived += inputData.length;

                // Silence detection (quick check on main thread)
                if (shouldRemoveInitialSilence && !hasRecordedAudio) {
                    if (SilenceDetector.isAbsolutelySilentFloat32(inputData) || SilenceDetector.isBelowThresholdFloat32(inputData)) {
                        return; // Skip silent frames at the beginning
                    }
                    hasRecordedAudio = true;
                }

                // Send Float32 data to worker for processing (copy buffer)
                const bufferCopy = new Float32Array(inputData);
                state.audioWorker.postMessage({
                    type: 'process',
                    data: { buffer: bufferCopy.buffer }
                }, [bufferCopy.buffer]);
            };

            state.mediaSource.connect(state.scriptProcessor);
            state.scriptProcessor.connect(state.audioContext.destination);

            DiagnosticUI.show();
            DiagnosticUI.startLiveUpdates();

            UI.setRecordingState(true);
        },

        stop() {
            DiagnosticUI.stopLiveUpdates();

            if (diagnostics.startTime !== null) {
                logDiagnosticSummary();

                const elapsedSec = (performance.now() - diagnostics.startTime) / 1000;
                const expectedSamples = elapsedSec * (diagnostics.actualSampleRate || CONFIG.SAMPLE_RATE);
                const sampleRatio = (diagnostics.totalSamplesReceived / expectedSamples) * 100;
                DiagnosticUI.update();
                DiagnosticUI.showFinalSummary(sampleRatio);
            }

            state.mediaSource?.disconnect();
            if (state.scriptProcessor) {
                state.scriptProcessor.disconnect();
                state.scriptProcessor.onaudioprocess = null;
            }

            // Request worker to build WAV file
            if (state.audioWorker) {
                DiagnosticUI.addAlert('Building WAV file...', 'warning');
                state.audioWorker.postMessage({
                    type: 'finish',
                    data: { sampleRate: diagnostics.actualSampleRate || CONFIG.SAMPLE_RATE }
                });
            }

            state.audioContext?.close();
            state.audioContext = null;

            UI.setRecordingState(false);
            // Note: Download button enabled when worker sends 'complete' message
        },

        toggle() {
            state.audioContext ? this.stop() : this.start();
        },
    };

    const downloadRecording = () => {
        if (!state.finalWavBuffer) return;

        const blob = new Blob([state.finalWavBuffer], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "recording_16k.wav";
        anchor.click();

        URL.revokeObjectURL(url);
    };

    const init = () => {
        const { recordBtn, downloadBtn } = getElements();

        // Initialize diagnostic UI
        DiagnosticUI.init();

        recordBtn.onclick = () => RecordingController.toggle();
        downloadBtn.onclick = downloadRecording;

        console.log("ScriptProcessorNode version - Event listeners attached");
    };

    return { init };
})();

document.addEventListener("DOMContentLoaded", () => AudioRecorder.init());
