// app.js – WebUSB orchestration + Whisper worker coordination
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const USB_VENDOR_ID   = 0x303A;        // Espressif default VID
const WEBUSB_IFACE    = 1;             // Interface 1 = WebUSB vendor class
const CHUNK_SIZE      = 512;           // bytes per transferIn
const SAMPLE_RATE     = 16000;         // Hz

// 4-byte EOF marker emitted by firmware when recording stops
const EOF_MARKER = new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC]);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnConnect    = document.getElementById('btn-connect');
const statusBadge   = document.getElementById('status-badge');
const transcript    = document.getElementById('transcript');
const modelProgress = document.getElementById('model-progress');
const progressBar   = document.getElementById('progress-bar');
const progressText  = document.getElementById('progress-text');

// ── State ─────────────────────────────────────────────────────────────────────
let device      = null;
let epIn        = null;   // Bulk IN endpoint number  (device → host: audio)
let epOut       = null;   // Bulk OUT endpoint number (host → device: text)
let worker      = null;
let modelReady  = false;
let recording   = false;

// ── Status display ────────────────────────────────────────────────────────────
function setStatus(text, cls) {
    statusBadge.textContent = text;
    statusBadge.className   = 'badge ' + (cls || '');
}

// ── EOF marker detection ──────────────────────────────────────────────────────
function isEOF(dataView) {
    if (dataView.byteLength < 4) return false;
    return (
        dataView.getUint8(0) === 0xFF &&
        dataView.getUint8(1) === 0xFE &&
        dataView.getUint8(2) === 0xFD &&
        dataView.getUint8(3) === 0xFC
    );
}

// ── Worker setup ──────────────────────────────────────────────────────────────
function initWorker() {
    worker = new Worker('./worker.js', { type: 'module' });

    worker.onmessage = async ({ data }) => {
        switch (data.type) {
            case 'ready':
                modelReady = true;
                modelProgress.hidden = true;
                setStatus('Connected – hold button to record', 'connected');
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
                if (data.text) {
                    appendTranscript(data.text);
                    await sendText(data.text + ' ');
                }
                setStatus('Connected – hold button to record', 'connected');
                break;

            case 'error':
                console.error('[worker]', data.message);
                setStatus('Worker error – see console', 'error');
                break;
        }
    };

    worker.onerror = (e) => {
        console.error('[worker error]', e);
        setStatus('Worker crashed – see console', 'error');
    };

    // Kick off model load
    worker.postMessage({ type: 'init' });
    setStatus('Loading model…', 'loading');
}

// ── WebUSB connection ─────────────────────────────────────────────────────────
async function connect() {
    try {
        device = await navigator.usb.requestDevice({
            filters: [{ vendorId: USB_VENDOR_ID }],
        });
        await device.open();
        await device.selectConfiguration(1);
        await device.claimInterface(WEBUSB_IFACE);

        // Discover bulk endpoints dynamically from the interface descriptor
        const iface   = device.configuration.interfaces[WEBUSB_IFACE];
        const alt     = iface.alternates[0];
        const bulkIn  = alt.endpoints.find(ep => ep.direction === 'in'  && ep.type === 'bulk');
        const bulkOut = alt.endpoints.find(ep => ep.direction === 'out' && ep.type === 'bulk');

        if (!bulkIn || !bulkOut) {
            throw new Error('Could not find bulk IN/OUT endpoints on WebUSB interface');
        }

        epIn  = bulkIn.endpointNumber;
        epOut = bulkOut.endpointNumber;

        console.log(`[usb] connected – bulk IN ep${epIn}, OUT ep${epOut}`);

        // Listen for device disconnection
        navigator.usb.addEventListener('disconnect', ({ device: d }) => {
            if (d === device) handleDisconnect();
        });

        btnConnect.textContent    = 'Disconnect';
        btnConnect.onclick        = disconnect;

        if (modelReady) {
            setStatus('Connected – hold button to record', 'connected');
        } else {
            setStatus('Connected – loading model…', 'loading');
        }

        // Start the audio receive loop in the background
        receiveLoop();

    } catch (err) {
        console.error('[usb] connect failed:', err);
        setStatus('Connection failed – ' + err.message, 'error');
    }
}

async function disconnect() {
    if (!device) return;
    try {
        await device.close();
    } catch (_) { /* ignore */ }
    handleDisconnect();
}

function handleDisconnect() {
    device   = null;
    epIn     = null;
    epOut    = null;
    recording = false;
    btnConnect.textContent = 'Connect';
    btnConnect.onclick     = connect;
    setStatus('Disconnected', 'disconnected');
}

// ── Audio receive loop ────────────────────────────────────────────────────────
// Continuously reads Bulk IN transfers.  When the firmware sends the EOF
// marker, we hand all accumulated PCM chunks to the Whisper worker.
async function receiveLoop() {
    while (device) {
        let audioChunks = [];
        recording = false;

        // Wait for the first chunk (indicates button pressed → recording started)
        try {
            const first = await device.transferIn(epIn, CHUNK_SIZE);
            if (!first || !first.data) continue;

            if (isEOF(first.data)) continue;  // spurious EOF – ignore

            recording = true;
            setStatus('Recording…', 'recording');
            audioChunks.push(new Int16Array(first.data.buffer.slice(
                first.data.byteOffset, first.data.byteOffset + first.data.byteLength
            )));

        } catch (err) {
            if (!device) break;
            console.warn('[usb] transferIn error (waiting):', err);
            await sleep(200);
            continue;
        }

        // Drain chunks until EOF marker
        try {
            while (device) {
                const result = await device.transferIn(epIn, CHUNK_SIZE);
                if (!result || !result.data) break;

                if (isEOF(result.data)) break;

                audioChunks.push(new Int16Array(result.data.buffer.slice(
                    result.data.byteOffset, result.data.byteOffset + result.data.byteLength
                )));
            }
        } catch (err) {
            if (!device) break;
            console.warn('[usb] transferIn error (draining):', err);
        }

        recording = false;

        if (audioChunks.length === 0) continue;

        // Concatenate all Int16 chunks into one flat array
        const totalSamples = audioChunks.reduce((s, c) => s + c.length, 0);
        const combined     = new Int16Array(totalSamples);
        let   offset       = 0;
        for (const chunk of audioChunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        console.log(`[usb] received ${totalSamples} samples (${(totalSamples / SAMPLE_RATE).toFixed(1)}s)`);

        if (!modelReady) {
            setStatus('Model not ready – please wait', 'loading');
            continue;
        }

        setStatus('Transcribing…', 'transcribing');

        // Send to worker for Whisper inference (transferable for zero-copy)
        worker.postMessage(
            { type: 'transcribe', audioData: combined, sampleRate: SAMPLE_RATE },
            [combined.buffer]
        );
    }
}

// ── Send text back to device ──────────────────────────────────────────────────
async function sendText(text) {
    if (!device || epOut === null) return;
    try {
        const encoded = new TextEncoder().encode(text + '\0');
        await device.transferOut(epOut, encoded);
        console.log('[usb] sent text:', JSON.stringify(text));
    } catch (err) {
        console.error('[usb] sendText failed:', err);
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
    if (!navigator.usb) {
        setStatus('WebUSB not supported – use Chrome or Edge', 'error');
        btnConnect.disabled = true;
        return;
    }

    btnConnect.onclick = connect;
    setStatus('Disconnected', 'disconnected');

    // Register service worker for offline support
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    }

    // Start loading the Whisper model immediately (so it's ready before first recording)
    initWorker();
})();
