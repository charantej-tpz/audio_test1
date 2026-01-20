// Alternative implementation using MediaRecorder API
// Simpler but less control over raw audio data
// Note: This records in the browser's native format, then converts to WAV

document.addEventListener("DOMContentLoaded", () => {
    const recordBtn = document.getElementById("recordBtn");
    const downloadBtn = document.getElementById("downloadBtn");

    recordBtn.onclick = toggleRecording;
    downloadBtn.onclick = downloadRecording;

    console.log("MediaRecorder version - Event listeners attached");
});

let mediaRecorder = null;
let audioChunks = [];
let wavResult = null;
let stream = null;

// ---------------- START / STOP ----------------

async function toggleRecording() {
    const recordBtn = document.getElementById("recordBtn");
    const downloadBtn = document.getElementById("downloadBtn");

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        // Start
        audioChunks = [];
        downloadBtn.disabled = true;

        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                noiseSuppression: false,
                echoCancellation: false,
                autoGainControl: false,
                channelCount: 1,
                sampleRate: 48000,
            }
        });

        // Check for supported MIME types
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')
            ? 'audio/webm;codecs=pcm'
            : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : 'audio/ogg';

        mediaRecorder = new MediaRecorder(stream, { mimeType });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: mimeType });

            // Convert to WAV using AudioContext
            wavResult = await convertToWav16k(audioBlob);
            downloadBtn.disabled = false;

            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start(100); // Collect data every 100ms
        recordBtn.innerText = "Stop recording";

    } else {
        // Stop
        recordBtn.innerText = "Start recording";
        mediaRecorder.stop();
        mediaRecorder = null;
    }
}

// ---------------- CONVERT TO WAV ----------------

async function convertToWav16k(audioBlob) {
    // Decode the recorded audio
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 48000 });

    let audioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error("Failed to decode audio:", e);
        audioCtx.close();
        return null;
    }

    // Get the raw PCM data (mono)
    const float32 = audioBuffer.getChannelData(0);

    // Downsample to 16kHz
    const pcm16 = downsampleTo16k(float32, audioBuffer.sampleRate);

    // Apply silence removal if checkbox is checked
    const removeSilence = document.getElementById("removeSilence")?.checked;
    let finalPcm = pcm16;

    if (removeSilence) {
        finalPcm = removeSilentFrames(pcm16);
    }

    audioCtx.close();
    return buildWav(finalPcm);
}

function removeSilentFrames(pcm16) {
    // Process in chunks similar to the worklet version
    const chunkSize = 512;
    const nonSilentChunks = [];

    for (let i = 0; i < pcm16.length; i += chunkSize) {
        const chunk = pcm16.slice(i, Math.min(i + chunkSize, pcm16.length));
        if (!isSilentFrame(chunk)) {
            nonSilentChunks.push(chunk);
        }
    }

    // Merge chunks
    let total = 0;
    nonSilentChunks.forEach(c => total += c.length);

    const result = new Int16Array(total);
    let offset = 0;

    for (const c of nonSilentChunks) {
        result.set(c, offset);
        offset += c.length;
    }

    return result;
}

// ---------------- DOWNLOAD ----------------

function downloadRecording() {
    if (!wavResult) return;

    const blob = new Blob([wavResult], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recording_16k.wav";
    a.click();
    URL.revokeObjectURL(url);
}

// ---------------- UTILITIES ----------------

function downsampleTo16k(input, rate) {
    const ratio = rate / 16000;
    const length = Math.floor(input.length / ratio);
    const output = new Int16Array(length);

    for (let i = 0; i < length; i++) {
        const idx = i * ratio;
        const i0 = Math.floor(idx);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = idx - i0;

        const sample = input[i0] * (1 - frac) + input[i1] * frac;
        output[i] = sample * 0x7fff;
    }
    return output;
}

function buildWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    write(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    write(view, 8, "WAVE");

    write(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 16000 * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);

    write(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        view.setInt16(offset, samples[i], true);
        offset += 2;
    }

    return buffer;
}

function write(view, offset, text) {
    for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
    }
}

function isSilentFrame(int16) {
    let sum = 0;
    for (let i = 0; i < int16.length; i++) {
        const v = int16[i];
        sum += v * v;
    }
    const rms = Math.sqrt(sum / int16.length);

    return rms < 25;
}
