// Style import removed - file doesn't exist
document.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordBtn");
  const downloadBtn = document.getElementById("downloadBtn");

  recordBtn.onclick = toggleRecording;
  downloadBtn.onclick = downloadRecording;

  console.log("Event listeners attached");
});


let audioCtx = null;
let chunks = [];
let workletNode = null;
let sourceNode = null;
let wavResult = null;

// ---------------- START / STOP ----------------

async function toggleRecording() {
  const recordBtn = document.getElementById("recordBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const removeSilence = document.getElementById("removeSilence").checked;

  if (!audioCtx) {
    // Start
    chunks = [];
    downloadBtn.disabled = true;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: false,
        echoCancellation: false,
        autoGainControl: false,
        channelCount: 1,
      }
    });

    audioCtx = new AudioContext({ sampleRate: 48000 });

    await audioCtx.audioWorklet.addModule("/src/worklet.js");

    sourceNode = audioCtx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioCtx, "recorder-processor");

    workletNode.port.onmessage = (event) => {
      if (!audioCtx) return; // prevents null crash

      const float32 = event.data;
      const pcm16 = downsampleTo16k(float32, audioCtx.sampleRate);

      if (removeSilence && chunks.length === 0 && isSilent(pcm16)) return;
      if (isSilentFrame(pcm16)) return;

      chunks.push(pcm16);
    };

    sourceNode.connect(workletNode);
    recordBtn.innerText = "Stop recording";

  } else {
    // Stop
    recordBtn.innerText = "Start recording";

    if (sourceNode) sourceNode.disconnect();
    if (workletNode) {
      workletNode.disconnect();
      workletNode.port.onmessage = null;
    }

    const mergedPCM = mergeChunks(chunks);
    wavResult = buildWav(mergedPCM);

    downloadBtn.disabled = false;

    audioCtx.close();
    audioCtx = null;
  }
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

function isSilent(chunk) {
  for (const v of chunk) {
    if (v !== 0) return false;
  }
  return true;
}

function mergeChunks(chunks) {
  let total = 0;
  chunks.forEach(c => total += c.length);

  const result = new Int16Array(total);
  let offset = 0;

  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }

  return result;
}

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

  // Threshold tuned for OnePlus/Samsung DSP gating
  return rms < 25;     // ~ -50 dB, effectively muted
}
