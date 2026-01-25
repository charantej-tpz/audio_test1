const AudioRecorder = (() => {
    const CONFIG = {
        SAMPLE_RATE: 48000,
        TARGET_SAMPLE_RATE: 16000,
        BUFFER_SIZE: 4096,
        SILENCE_THRESHOLD: 25,
        BIT_DEPTH: 16,
        CHANNELS: 1,
    };

    const state = {
        audioContext: null,
        scriptProcessor: null,
        mediaSource: null,
        recordedChunks: [],
        finalWavBuffer: null,
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
        const expectedDownsampled = elapsedSec * CONFIG.TARGET_SAMPLE_RATE;
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
            const expectedDownsampled = elapsedSec * CONFIG.TARGET_SAMPLE_RATE;
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

    const AudioProcessor = {
        downsample(float32Data, sourceRate) {
            const ratio = sourceRate / CONFIG.TARGET_SAMPLE_RATE;
            const outputLength = Math.floor(float32Data.length / ratio);
            const output = new Int16Array(outputLength);

            for (let i = 0; i < outputLength; i++) {
                const srcIndex = i * ratio;
                const floor = Math.floor(srcIndex);
                const ceil = Math.min(floor + 1, float32Data.length - 1);
                const fraction = srcIndex - floor;

                const interpolated = float32Data[floor] * (1 - fraction) + float32Data[ceil] * fraction;
                output[i] = interpolated * 0x7fff;
            }

            return output;
        },

        mergeChunks(chunks) {
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const merged = new Int16Array(totalLength);

            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }

            return merged;
        },
    };

    const SilenceDetector = {
        isAbsolutelySilent(samples) {
            return samples.every(sample => sample === 0);
        },

        isBelowThreshold(samples) {
            const sumOfSquares = samples.reduce((sum, val) => sum + val * val, 0);
            const rms = Math.sqrt(sumOfSquares / samples.length);
            return rms < CONFIG.SILENCE_THRESHOLD;
        },
    };

    const WavEncoder = {
        writeString(view, offset, text) {
            for (let i = 0; i < text.length; i++) {
                view.setUint8(offset + i, text.charCodeAt(i));
            }
        },

        encode(samples) {
            const headerSize = 44;
            const dataSize = samples.length * 2;
            const buffer = new ArrayBuffer(headerSize + dataSize);
            const view = new DataView(buffer);

            this.writeString(view, 0, "RIFF");
            view.setUint32(4, 36 + dataSize, true);
            this.writeString(view, 8, "WAVE");

            this.writeString(view, 12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, CONFIG.CHANNELS, true);
            view.setUint32(24, CONFIG.TARGET_SAMPLE_RATE, true);
            view.setUint32(28, CONFIG.TARGET_SAMPLE_RATE * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, CONFIG.BIT_DEPTH, true);

            this.writeString(view, 36, "data");
            view.setUint32(40, dataSize, true);

            let writeOffset = headerSize;
            for (const sample of samples) {
                view.setInt16(writeOffset, sample, true);
                writeOffset += 2;
            }

            return buffer;
        },
    };

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

            state.recordedChunks = [];
            resetDiagnostics();
            UI.enableDownload(false);

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    noiseSuppression: false,
                    echoCancellation: false,
                    autoGainControl: false,
                    channelCount: CONFIG.CHANNELS,
                },
            });

            // Try to create AudioContext with preferred 48kHz sample rate
            // If device doesn't support it, fallback to native rate
            let audioContext;
            try {
                audioContext = new AudioContext({ sampleRate: CONFIG.SAMPLE_RATE });
                // Check if device actually used our requested rate
                if (audioContext.sampleRate !== CONFIG.SAMPLE_RATE) {
                    // Device didn't support 48kHz, close and recreate with native rate
                    await audioContext.close();
                    audioContext = new AudioContext(); // Use device native rate
                    console.log(`Device doesn't support ${CONFIG.SAMPLE_RATE} Hz, using native ${audioContext.sampleRate} Hz`);
                    DiagnosticUI.addAlert(`Using native ${audioContext.sampleRate} Hz`, 'warning');
                }
            } catch (e) {
                // Fallback to native rate if explicit rate fails
                audioContext = new AudioContext();
                console.log(`Fallback to native sample rate: ${audioContext.sampleRate} Hz`);
            }

            state.audioContext = audioContext;
            diagnostics.actualSampleRate = state.audioContext.sampleRate;
            console.log(`AudioContext using sample rate: ${state.audioContext.sampleRate} Hz`);

            // Calculate expected interval between callbacks
            diagnostics.expectedIntervalMs = (CONFIG.BUFFER_SIZE / state.audioContext.sampleRate) * 1000;
            console.log(`Expected callback interval: ~${diagnostics.expectedIntervalMs.toFixed(1)}ms`);

            state.mediaSource = state.audioContext.createMediaStreamSource(stream);
            state.scriptProcessor = state.audioContext.createScriptProcessor(
                CONFIG.BUFFER_SIZE,
                CONFIG.CHANNELS,
                CONFIG.CHANNELS
            );

            state.scriptProcessor.onaudioprocess = (event) => {
                if (!state.audioContext) return;

                const now = performance.now();

                // Initialize timing on first callback
                if (diagnostics.startTime === null) {
                    diagnostics.startTime = now;
                    diagnostics.lastCallbackTime = now;
                }

                // Track timing gaps (detect missed callbacks)
                const elapsed = now - diagnostics.lastCallbackTime;
                const threshold = diagnostics.expectedIntervalMs * 1.8; // Allow 80% variance

                if (diagnostics.callbackCount > 0 && elapsed > threshold) {
                    diagnostics.gaps.push({
                        timestamp: now,
                        gapMs: elapsed,
                        expectedMs: diagnostics.expectedIntervalMs,
                    });
                    const timeInRecording = (now - diagnostics.startTime) / 1000;
                    console.warn(`⚠️ Audio gap at ${timeInRecording.toFixed(2)}s: ${elapsed.toFixed(0)}ms (expected ~${diagnostics.expectedIntervalMs.toFixed(0)}ms)`);

                    // Show alert on screen
                    DiagnosticUI.addAlert(`Gap at ${timeInRecording.toFixed(1)}s: ${elapsed.toFixed(0)}ms`, 'warning');
                }

                diagnostics.lastCallbackTime = now;
                diagnostics.callbackCount++;

                const inputData = event.inputBuffer.getChannelData(0);
                diagnostics.totalSamplesReceived += inputData.length;

                const clonedData = new Float32Array(inputData);
                const pcm16 = AudioProcessor.downsample(clonedData, state.audioContext.sampleRate);
                diagnostics.totalDownsampledSamples += pcm16.length;

                if (shouldRemoveInitialSilence && state.recordedChunks.length === 0) {
                    if (SilenceDetector.isAbsolutelySilent(pcm16) || SilenceDetector.isBelowThreshold(pcm16)) {
                        return;
                    }
                }

                state.recordedChunks.push(pcm16);
            };

            state.mediaSource.connect(state.scriptProcessor);
            state.scriptProcessor.connect(state.audioContext.destination);

            // Show diagnostic panel and start live updates
            DiagnosticUI.show();
            DiagnosticUI.startLiveUpdates();

            UI.setRecordingState(true);
        },

        stop() {
            // Stop live UI updates
            DiagnosticUI.stopLiveUpdates();

            // Log diagnostic summary before cleanup
            if (diagnostics.startTime !== null) {
                logDiagnosticSummary();

                // Show final summary on screen
                const elapsedSec = (performance.now() - diagnostics.startTime) / 1000;
                const expectedSamples = elapsedSec * CONFIG.SAMPLE_RATE;
                const sampleRatio = (diagnostics.totalSamplesReceived / expectedSamples) * 100;
                DiagnosticUI.update(); // Final update
                DiagnosticUI.showFinalSummary(sampleRatio);
            }

            state.mediaSource?.disconnect();
            if (state.scriptProcessor) {
                state.scriptProcessor.disconnect();
                state.scriptProcessor.onaudioprocess = null;
            }

            const mergedPCM = AudioProcessor.mergeChunks(state.recordedChunks);
            state.finalWavBuffer = WavEncoder.encode(mergedPCM);

            state.audioContext?.close();
            state.audioContext = null;

            UI.setRecordingState(false);
            UI.enableDownload(true);
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
