// Web Worker – runs Whisper Tiny inference via Transformers.js (WebAssembly).
// Receives Int16Array audio data, returns transcript string.

import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2/src/transformers.js';

// ── Model initialisation ──────────────────────────────────────────────────────
// Loaded once; subsequent recordings reuse the same pipeline.
// The model is cached in IndexedDB after the first download (~39 MB).
let transcriber = null;

async function init() {
    self.postMessage({ type: 'progress', status: 'loading', progress: 0 });

    transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en',
        {
            dtype: 'q8',
            // Report download progress so the UI can show a progress bar
            progress_callback: (info) => {
                if (info.status === 'progress') {
                    self.postMessage({
                        type: 'progress',
                        status: 'downloading',
                        progress: Math.round(info.progress),
                        file: info.file,
                    });
                } else if (info.status === 'done') {
                    self.postMessage({ type: 'progress', status: 'done', progress: 100 });
                }
            },
        }
    );

    self.postMessage({ type: 'ready' });
}

// ── Inference ─────────────────────────────────────────────────────────────────
async function transcribe(audioData, sampleRate) {
    if (!transcriber) {
        self.postMessage({ type: 'error', message: 'Model not loaded' });
        return;
    }

    // Cardputer sends int16 PCM; Whisper expects float32 in [-1, 1]
    const float32 = new Float32Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
        float32[i] = audioData[i] / 32768.0;
    }

    const result = await transcriber(float32, {
        sampling_rate: sampleRate || 16000,
        language: 'english',
        task: 'transcribe',
    });

    const text = result.text.trim();
    self.postMessage({ type: 'transcript', text });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async ({ data }) => {
    switch (data.type) {
        case 'init':
            await init();
            break;
        case 'transcribe':
            await transcribe(data.audioData, data.sampleRate);
            break;
        default:
            console.warn('[worker] Unknown message type:', data.type);
    }
};
