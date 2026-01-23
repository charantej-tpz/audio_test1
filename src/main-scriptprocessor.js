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
            UI.enableDownload(false);

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    noiseSuppression: false,
                    echoCancellation: false,
                    autoGainControl: false,
                    channelCount: CONFIG.CHANNELS,
                },
            });

            state.audioContext = new AudioContext({ sampleRate: CONFIG.SAMPLE_RATE });
            state.mediaSource = state.audioContext.createMediaStreamSource(stream);
            state.scriptProcessor = state.audioContext.createScriptProcessor(
                CONFIG.BUFFER_SIZE,
                CONFIG.CHANNELS,
                CONFIG.CHANNELS
            );

            state.scriptProcessor.onaudioprocess = (event) => {
                if (!state.audioContext) return;

                const inputData = event.inputBuffer.getChannelData(0);
                const clonedData = new Float32Array(inputData);
                const pcm16 = AudioProcessor.downsample(clonedData, state.audioContext.sampleRate);

                if (shouldRemoveInitialSilence && state.recordedChunks.length === 0) {
                    if (SilenceDetector.isAbsolutelySilent(pcm16) || SilenceDetector.isBelowThreshold(pcm16)) {
                        return;
                    }
                }

                state.recordedChunks.push(pcm16);
            };

            state.mediaSource.connect(state.scriptProcessor);
            state.scriptProcessor.connect(state.audioContext.destination);

            UI.setRecordingState(true);
        },

        stop() {
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

        recordBtn.onclick = () => RecordingController.toggle();
        downloadBtn.onclick = downloadRecording;

        console.log("ScriptProcessorNode version - Event listeners attached");
    };

    return { init };
})();

document.addEventListener("DOMContentLoaded", () => AudioRecorder.init());
