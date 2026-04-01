const WORKER_CODE = `
const CONSTANTS = { HEADER_SIZE: 36 };

function hexToBuff(hexString) {
    if (!hexString) return new Uint8Array(0).buffer;
    return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer;
}

function createFragmentHeader(hexId, ivBuff, saltBuff) {
    const header = new ArrayBuffer(CONSTANTS.HEADER_SIZE);
    const view = new DataView(header);
    view.setBigUint64(0, BigInt("0x" + (hexId.startsWith('P') ? hexId.substring(1) : hexId)));
    new Uint8Array(header).set(new Uint8Array(ivBuff), 8);
    new Uint8Array(header).set(new Uint8Array(saltBuff), 20);
    return header;
}

const keyCache = new Map();

async function getMasterKey(password, saltHex) {
    const cacheKey = password + ":" + saltHex;
    if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
    const salt = hexToBuff(saltHex);
    const aesKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    keyCache.set(cacheKey, aesKey);
    return aesKey;
}

self.onmessage = async function(e) {
    const data = e.data;
    try {
        if (data.action === 'scatter') {
            if (data.mode === 'ZERO') {
                const rem = data.buffer.byteLength % 4;
                const view = new Uint32Array(data.buffer, 0, (data.buffer.byteLength - rem) / 4);
                let isZero = true;
                for (let i = 0; i < view.length; i++) {
                    if (view[i] !== 0) { isZero = false; break; }
                }
                if (isZero && rem > 0) {
                    const view8 = new Uint8Array(data.buffer, data.buffer.byteLength - rem, rem);
                    for (let i = 0; i < rem; i++) {
                        if (view8[i] !== 0) { isZero = false; break; }
                    }
                }
                if (isZero) {
                    self.postMessage({ action: 'skip_zero', isZero: true, hexId: data.hexId });
                    return;
                }
            }
            let combined;
            const pureId = data.hexId.startsWith('P') ? data.hexId.substring(1) : data.hexId;
            const saltBuff = hexToBuff(data.saltHex);
            
            const aesKey = await getMasterKey(data.password, data.saltHex);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encryptedSlice = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, data.buffer);
            
            const header = createFragmentHeader(data.hexId, iv.buffer, saltBuff);
            combined = new Uint8Array(header.byteLength + encryptedSlice.byteLength);
            combined.set(new Uint8Array(header), 0);
            combined.set(new Uint8Array(encryptedSlice), header.byteLength);
            self.postMessage({ action: 'scatter_done', combinedBuffer: combined.buffer, hexId: data.hexId }, [combined.buffer]);
        } else if (data.action === 'validate' || data.action === 'weave') {
            const pureId = data.hexId.startsWith('P') ? data.hexId.substring(1) : data.hexId;
            const aesKey = await getMasterKey(data.password, data.saltHex);
            const ivBytes = hexToBuff(data.ivHex);
            
            const pureBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivBytes) }, aesKey, data.buffer);
            
            if (data.action === 'validate') {
                self.postMessage({ action: 'validate_done', crc16: 0, hexId: data.hexId });
            } else {
                self.postMessage({ action: 'weave_done', pureBuffer: pureBuffer, hexId: data.hexId }, [pureBuffer instanceof ArrayBuffer ? pureBuffer : pureBuffer.buffer]);
            }
        }
    } catch(err) {
        const errorMsg = err.name === 'OperationError' ? 'Invalid password' : err.message;
        self.postMessage({ action: 'error', error: errorMsg, reqAction: data.action, hexId: data.hexId });
    }
};
`;

async function bundleApp() {
    try {
        showToast("Compiling Loom Runtime...", "info");
        const load = async u => await (await fetch(u)).text();
        let index = await load('index.html');
        const style = await load('style.css');
        const scripts = ['js/constants.js', 'js/utils.js', 'js/protocol.js', 'js/worker.js', 'js/scatter.js', 'js/weaver.js', 'js/main.js'];
        index = index.replace(/<link rel="stylesheet".*?>/i, '<style>' + style + '</style>');
        for (let s of scripts) {
            const js = await load(s);
            index = index.replace(new RegExp('<script src="' + s + '"></' + 'script>', 'i'), '<script>' + js + '</' + 'script>');
        }
        const b = new Blob([index], { type: 'text/html' });
        downloadBlob(b, 'TheLoom_Standalone.html');
        showToast("Target Acquired & Self-Contained Built", "success");
    } catch (e) {
        showToast("Error packing application", "error");
    }
}

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
