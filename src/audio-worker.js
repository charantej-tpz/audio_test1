/**
 * Audio Processing Web Worker
 * Handles Float32 to Int16 conversion, downsampling (if needed), and WAV file building
 */

const CONFIG = {
    TARGET_SAMPLE_RATE: 16000,  // Output is always 16kHz
    BIT_DEPTH: 16,
    CHANNELS: 1,
};

let recordedChunks = [];
let sourceSampleRate = 16000;  // Will be set by main thread
let needsDownsampling = false;

/**
 * Downsample Float32 data from source rate to 16kHz using linear interpolation
 */
function downsample(float32Data, sourceRate, targetRate) {
    const ratio = sourceRate / targetRate;
    const outputLength = Math.floor(float32Data.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio;
        const floor = Math.floor(srcIndex);
        const ceil = Math.min(floor + 1, float32Data.length - 1);
        const fraction = srcIndex - floor;

        output[i] = float32Data[floor] * (1 - fraction) + float32Data[ceil] * fraction;
    }

    return output;
}

/**
 * Convert Float32Array to Int16Array
 */
function float32ToInt16(float32Data) {
    const output = new Int16Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32Data[i]));
        output[i] = sample * 0x7fff;
    }
    return output;
}

/**
 * Merge all Int16 chunks into a single array
 */
function mergeChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Int16Array(totalLength);

    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }

    return merged;
}

/**
 * Build WAV file from Int16 samples (always at 16kHz)
 */
function buildWav(samples) {
    const headerSize = 44;
    const dataSize = samples.length * 2;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, text) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    // RIFF header
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");

    // fmt chunk
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, CONFIG.CHANNELS, true);
    view.setUint32(24, CONFIG.TARGET_SAMPLE_RATE, true);  // Always 16kHz output
    view.setUint32(28, CONFIG.TARGET_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, CONFIG.BIT_DEPTH, true);

    // data chunk
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    // Write samples
    let writeOffset = headerSize;
    for (const sample of samples) {
        view.setInt16(writeOffset, sample, true);
        writeOffset += 2;
    }

    return buffer;
}

/**
 * Handle messages from main thread
 */
self.onmessage = function (event) {
    const { type, data } = event.data;

    switch (type) {
        case 'init':
            // Reset for new recording and set sample rate info
            recordedChunks = [];
            sourceSampleRate = data.sourceSampleRate || 16000;
            needsDownsampling = sourceSampleRate !== CONFIG.TARGET_SAMPLE_RATE;

            console.log(`Worker initialized: source=${sourceSampleRate}Hz, downsample=${needsDownsampling}`);
            self.postMessage({
                type: 'ready',
                needsDownsampling: needsDownsampling
            });
            break;

        case 'process':
            // Get Float32 data from buffer
            let float32Data = new Float32Array(data.buffer);

            // Downsample if needed (source rate != 16kHz)
            if (needsDownsampling) {
                float32Data = downsample(float32Data, sourceSampleRate, CONFIG.TARGET_SAMPLE_RATE);
            }

            // Convert to Int16 and store
            const int16Data = float32ToInt16(float32Data);
            recordedChunks.push(int16Data);

            // Send back sample count for diagnostics
            self.postMessage({
                type: 'processed',
                samplesProcessed: int16Data.length
            });
            break;

        case 'finish':
            // Merge all chunks and build WAV (always 16kHz output)
            const mergedPCM = mergeChunks(recordedChunks);
            const wavBuffer = buildWav(mergedPCM);

            // Send WAV buffer back to main thread
            self.postMessage({
                type: 'complete',
                wavBuffer: wavBuffer,
                totalSamples: mergedPCM.length,
                outputSampleRate: CONFIG.TARGET_SAMPLE_RATE
            }, [wavBuffer]);

            // Clear chunks
            recordedChunks = [];
            break;

        case 'clear':
            recordedChunks = [];
            self.postMessage({ type: 'cleared' });
            break;
    }
};
