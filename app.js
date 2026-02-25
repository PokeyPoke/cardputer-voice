// app.js – Web Serial orchestration + Whisper worker coordination
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;  // Hz — must match firmware SAMPLE_RATE

// 4-byte EOF marker emitted by firmware when recording stops
const EOF_MARKER = [0xFF, 0xFE, 0xFD, 0xFC];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnConnect    = document.getElementById('btn-connect');
const statusBadge   = document.getElementById('status-badge');
const transcript    = document.getElementById('transcript');
const modelProgress = document.getElementById('model-progress');
const progressBar   = document.getElementById('progress-bar');
const progressText  = document.getElementById('progress-text');

// ── State ─────────────────────────────────────────────────────────────────────
let port       = null;
let worker     = null;
let modelReady = false;

// ── Status display ────────────────────────────────────────────────────────────
function setStatus(text, cls) {
    statusBadge.textContent = text;
    statusBadge.className   = 'badge ' + (cls || '');
}

// ── EOF marker search ─────────────────────────────────────────────────────────
function findEOF(bytes) {
    for (let i = 0; i <= bytes.length - 4; i++) {
        if (bytes[i]   === 0xFF && bytes[i+1] === 0xFE &&
            bytes[i+2] === 0xFD && bytes[i+3] === 0xFC) return i;
    }
    return -1;
}

// ── Worker setup ──────────────────────────────────────────────────────────────
function initWorker() {
    worker = new Worker('./worker.js', { type: 'module' });

    worker.onmessage = async ({ data }) => {
        switch (data.type) {
            case 'ready':
                modelReady = true;
                modelProgress.hidden = true;
                if (port) setStatus('Connected – hold button to record', 'connected');
                break;

            case 'progress':
                modelProgress.hidden = false;
                if (data.status === 'downloading') {
                    progressBar.value   = data.progress;
                    progressText.textContent =
                        `Downloading model… ${data.progress}%` +
                        (data.file ? ` (${data.file})` : '');
                } else if (data.status === 'done') {
                    progressBar.value   = 100;
                    progressText.textContent = 'Model loaded.';
                }
                break;

            case 'transcript':
                console.log('[worker] transcript:', JSON.stringify(data.text));
                if (data.text && data.text.trim()) {
                    appendTranscript(data.text);
                    await sendText(data.text.trim() + ' ');
                } else {
                    // Send null terminator so firmware exits WAITING_TEXT even on empty result
                    await sendText('');
                }
                if (port) setStatus('Connected – hold button to record', 'connected');
                break;

            case 'error':
                console.error('[worker]', data.message);
                setStatus('Worker error – see console', 'error');
                break;
        }
    };

    worker.onerror = (e) => {
        console.error('[worker error]', e.message, e.filename, e.lineno, e);
        setStatus('Worker crashed – see console', 'error');
    };

    worker.postMessage({ type: 'init' });
    setStatus('Loading model…', 'loading');
}

// ── Web Serial connection ─────────────────────────────────────────────────────
async function connect() {
    try {
        port = await navigator.serial.requestPort({
            filters: [{ usbVendorId: 0x303A }],
        });
        await port.open({ baudRate: 2000000 });   // baud rate ignored for USB CDC

        navigator.serial.addEventListener('disconnect', ({ target }) => {
            if (target === port) handleDisconnect();
        });

        btnConnect.textContent = 'Disconnect';
        btnConnect.onclick     = disconnect;

        setStatus(modelReady ? 'Connected – hold button to record' : 'Connected – loading model…',
                  modelReady ? 'connected' : 'loading');

        receiveLoop();

    } catch (err) {
        console.error('[serial] connect failed:', err);
        if (err.name !== 'NotFoundError') {   // user cancelled — no error message needed
            setStatus('Connection failed – ' + err.message, 'error');
        }
    }
}

async function disconnect() {
    if (!port) return;
    const p = port;
    port = null;
    try { await p.close(); } catch (_) { /* ignore */ }
    handleDisconnect();
}

function handleDisconnect() {
    port = null;
    btnConnect.textContent = 'Connect';
    btnConnect.onclick     = connect;
    setStatus('Disconnected', 'disconnected');
}

// ── Audio receive loop ────────────────────────────────────────────────────────
// Runs for the lifetime of the connection.
// Each iteration: accumulate audio bytes until EOF marker, then transcribe.
async function receiveLoop() {
    while (port && port.readable) {
        let audioBytes = [];
        let recordingStarted = false;
        let reader;

        try {
            reader = port.readable.getReader();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;

                // Append incoming bytes
                for (const b of value) audioBytes.push(b);

                // First bytes received → recording started on device
                if (!recordingStarted && audioBytes.length > 0) {
                    recordingStarted = true;
                    setStatus('Recording…', 'recording');
                }

                // Check for EOF marker
                const eofIdx = findEOF(audioBytes);
                if (eofIdx !== -1) {
                    audioBytes = audioBytes.slice(0, eofIdx);
                    break;
                }
            }
        } catch (err) {
            if (!port) break;
            console.warn('[serial] read error:', err);
        } finally {
            if (reader) {
                try { reader.releaseLock(); } catch (_) { /* ignore */ }
            }
        }

        if (audioBytes.length < 512) {
            console.log('[serial] audio too short, skipping');
            continue;
        }

        if (!modelReady) {
            setStatus('Model not ready – please wait', 'loading');
            continue;
        }

        setStatus('Transcribing…', 'transcribing');

        // Convert byte array (little-endian int16) → Int16Array
        const samples = Math.floor(audioBytes.length / 2);
        const combined = new Int16Array(samples);
        for (let i = 0; i < samples; i++) {
            combined[i] = (audioBytes[i * 2]) | (audioBytes[i * 2 + 1] << 8);
        }

        console.log(`[serial] received ${samples} samples (${(samples / SAMPLE_RATE).toFixed(1)}s)`);

        worker.postMessage(
            { type: 'transcribe', audioData: combined, sampleRate: SAMPLE_RATE },
            [combined.buffer]
        );
    }
}

// ── Send text to device ───────────────────────────────────────────────────────
async function sendText(text) {
    if (!port || !port.writable) return;
    let writer;
    try {
        writer = port.writable.getWriter();
        await writer.write(new TextEncoder().encode(text + '\0'));
        console.log('[serial] sent text:', JSON.stringify(text));
    } catch (err) {
        console.error('[serial] sendText failed:', err);
    } finally {
        if (writer) {
            try { writer.releaseLock(); } catch (_) { /* ignore */ }
        }
    }
}

// ── Transcript display ────────────────────────────────────────────────────────
function appendTranscript(text) {
    const ts   = new Date().toLocaleTimeString();
    const line = document.createElement('p');
    line.innerHTML = `<span class="ts">${ts}</span> ${escapeHtml(text)}`;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
    if (!('serial' in navigator)) {
        setStatus('Web Serial not supported – use Chrome or Edge', 'error');
        btnConnect.disabled = true;
        return;
    }

    btnConnect.onclick = connect;
    setStatus('Disconnected', 'disconnected');

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    }

    initWorker();
})();
