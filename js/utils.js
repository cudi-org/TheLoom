const WORKER_CODE = `
const CONSTANTS = { HEADER_SIZE: 40 };

const keyCache = new Map();

async function getKeys(rawAesKey, rawHmacKey) {
    const aesHash = new Uint8Array(rawAesKey).join(',');
    if (keyCache.has(aesHash)) return keyCache.get(aesHash);
    const aesCryptoKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const hmacCryptoKey = await crypto.subtle.importKey("raw", rawHmacKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const keys = { aes: aesCryptoKey, hmac: hmacCryptoKey };
    keyCache.set(aesHash, keys);
    return keys;
}

self.onmessage = async function(e) {
    const data = e.data;
    try {
        const { aes, hmac } = await getKeys(data.rawAesKey, data.rawHmacKey);

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
            
            const ivSig = await crypto.subtle.sign("HMAC", hmac, data.buffer);
            const iv = new Uint8Array(ivSig).slice(0, 12);
            
            const encryptedSlice = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aes, data.buffer);
            
            const baseHeader = new ArrayBuffer(36);
            const view = new DataView(baseHeader);
            const pureId = data.hexId.startsWith('P') ? data.hexId.substring(1) : data.hexId;
            view.setBigUint64(0, BigInt("0x" + pureId));
            new Uint8Array(baseHeader).set(iv, 8);
            new Uint8Array(baseHeader).set(new Uint8Array(data.masterSaltBuffer), 20);
            
            const headerSig = await crypto.subtle.sign("HMAC", hmac, baseHeader);
            const hmacTag = new Uint8Array(headerSig).slice(0, 4);
            
            const header = new ArrayBuffer(40);
            new Uint8Array(header).set(new Uint8Array(baseHeader), 0);
            new Uint8Array(header).set(hmacTag, 36);

            const combined = new Uint8Array(40 + encryptedSlice.byteLength);
            combined.set(new Uint8Array(header), 0);
            combined.set(new Uint8Array(encryptedSlice), 40);
            self.postMessage({ action: 'scatter_done', combinedBuffer: combined.buffer, hexId: data.hexId }, [combined.buffer]);

        } else if (data.action === 'validate' || data.action === 'weave') {
            const buffer40 = data.headerBuffer;
            const hmacTag = new Uint8Array(buffer40, 36, 4);
            const baseHeader = buffer40.slice(0, 36);
            
            const headerSig = await crypto.subtle.sign("HMAC", hmac, baseHeader);
            const expectedTag = new Uint8Array(headerSig).slice(0, 4);
            for(let i=0; i<4; i++){
                if(hmacTag[i] !== expectedTag[i]) throw new Error("Header Validation Failed");
            }
            
            const pureBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(data.ivBytes) }, aes, data.buffer);
            
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
        const scripts = ['js/constants.js', 'js/utils.js', 'js/protocol.js', 'js/core.js', 'js/scatter.js', 'js/weaver.js', 'js/main.js'];
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
