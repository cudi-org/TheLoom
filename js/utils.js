const WORKER_CODE = `
const CONSTANTS = { MAGIC_SIG: 0x4C4F4F4D, VERSION: 1, FLAGS: 0, HEADER_SIZE: 16 };

function hexToBuff(hexString) { return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer; }

function calculateCRC16(buffer) {
    const arr = new Uint8Array(buffer);
    let crc = 0xFFFF;
    for (let i = 0; i < arr.length; i++) {
        crc ^= arr[i];
        for (let j = 0; j < 8; j++) {
            if ((crc & 1) !== 0) { crc = (crc >> 1) ^ 0xA001; } else { crc = crc >> 1; }
        }
    }
    return crc;
}

function xorBuffer(buffer, hexKey) {
    const arr = new Uint8Array(buffer);
    const keyArr = new Uint8Array(hexToBuff(hexKey));
    if (keyArr.length === 0) return arr.buffer;
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) { out[i] = arr[i] ^ keyArr[i % keyArr.length]; }
    return out.buffer;
}

function createFragmentHeader(hexId, crc16) {
    const header = new ArrayBuffer(CONSTANTS.HEADER_SIZE);
    const view = new DataView(header);
    view.setUint32(0, CONSTANTS.MAGIC_SIG); 
    view.setUint8(4, CONSTANTS.VERSION);
    view.setUint8(5, CONSTANTS.FLAGS);
    view.setUint16(6, crc16); 
    view.setBigUint64(8, BigInt("0x" + hexId));
    return header;
}

self.onmessage = function(e) {
    const data = e.data;
    if (data.action === 'scatter') {
        const crc16 = calculateCRC16(data.buffer);
        const encryptedSlice = xorBuffer(data.buffer, data.hexId);
        const header = createFragmentHeader(data.hexId, crc16);
        const combined = new Uint8Array(header.byteLength + encryptedSlice.byteLength);
        combined.set(new Uint8Array(header), 0);
        combined.set(new Uint8Array(encryptedSlice), header.byteLength);
        self.postMessage({ action: 'scatter_done', combinedBuffer: combined.buffer, hexId: data.hexId }, [combined.buffer]);
    } else if (data.action === 'validate') {
        const pureBuffer = xorBuffer(data.buffer, data.hexId);
        self.postMessage({ action: 'validate_done', crc16: calculateCRC16(pureBuffer), hexId: data.hexId });
    } else if (data.action === 'weave') {
        const pureBuffer = xorBuffer(data.buffer, data.hexId);
        self.postMessage({ action: 'weave_done', pureBuffer: pureBuffer, hexId: data.hexId }, [pureBuffer]);
    }
};
`;

function getWorkerBlobUrl() {
    if (!window.__workerBlobUrl) {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        window.__workerBlobUrl = URL.createObjectURL(blob);
    }
    return window.__workerBlobUrl;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function buffToHex(buffer) {
    return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToBuff(hexString) {
    return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

function obfuscateString(str) {
    const encoder = new TextEncoder();
    const arr = encoder.encode(str);
    const XOR_KEY = 0xAA;
    for (let i = 0; i < arr.length; i++) {
        arr[i] ^= XOR_KEY;
    }
    return btoa(String.fromCharCode.apply(null, arr));
}

function deobfuscateString(b64) {
    try {
        const strBytes = atob(b64);
        const arr = new Uint8Array(strBytes.length);
        const XOR_KEY = 0xAA;
        for (let i = 0; i < strBytes.length; i++) {
            arr[i] = strBytes.charCodeAt(i) ^ XOR_KEY;
        }
        const decoder = new TextDecoder();
        return decoder.decode(arr);
    } catch (e) {
        return "Unknown File";
    }
}

async function sha256Hash(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return buffToHex(hashBuffer);
}

async function cleanOldOPFSSessions(currentSessionId) {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    try {
        const root = await navigator.storage.getDirectory();
        for await (const [name, handle] of root.entries()) {
            if (handle.kind === 'directory' &&
                (name.startsWith('scatter_') || name.startsWith('weave_'))) {
                if (currentSessionId && name.includes(currentSessionId)) continue;
                try {
                    await root.removeEntry(name, { recursive: true });
                } catch (e) { }
            }
        }
    } catch (e) { }
}
