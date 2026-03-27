const CONSTANTS = { MAGIC_SIG: 0x4C4F4F4D, VERSION: 1, FLAGS: 0, HEADER_SIZE: 44 };

function hexToBuff(hexString) {
    if (!hexString) return new Uint8Array(0).buffer;
    return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer;
}

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

function createFragmentHeader(hexId, crc16, ivBuff, saltBuff) {
    const header = new ArrayBuffer(CONSTANTS.HEADER_SIZE);
    const view = new DataView(header);
    view.setUint32(0, CONSTANTS.MAGIC_SIG);
    view.setUint8(4, CONSTANTS.VERSION);
    view.setUint8(5, CONSTANTS.FLAGS);
    view.setUint16(6, crc16);
    view.setBigUint64(8, BigInt("0x" + (hexId.startsWith('P') ? hexId.substring(1) : hexId)));
    new Uint8Array(header).set(new Uint8Array(ivBuff), 16);
    new Uint8Array(header).set(new Uint8Array(saltBuff), 28);
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
            const crc16 = calculateCRC16(data.buffer);
            const saltBuff = hexToBuff(data.saltHex);
            if (data.hexId.startsWith("P")) {
                 const header = createFragmentHeader(data.hexId, crc16, new Uint8Array(12).buffer, saltBuff);
                 combined = new Uint8Array(header.byteLength + data.buffer.byteLength);
                 combined.set(new Uint8Array(header), 0);
                 combined.set(new Uint8Array(data.buffer), header.byteLength);
                 self.postMessage({ action: 'scatter_done', combinedBuffer: combined.buffer, hexId: data.hexId }, [combined.buffer]);
                 return;
            }
            const aesKey = await getMasterKey(data.password, data.saltHex);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encryptedSlice = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, data.buffer);
            const header = createFragmentHeader(data.hexId, crc16, iv.buffer, saltBuff);
            combined = new Uint8Array(header.byteLength + encryptedSlice.byteLength);
            combined.set(new Uint8Array(header), 0);
            combined.set(new Uint8Array(encryptedSlice), header.byteLength);
            self.postMessage({ action: 'scatter_done', combinedBuffer: combined.buffer, hexId: data.hexId }, [combined.buffer]);
        } else if (data.action === 'validate' || data.action === 'weave') {
            const pureId = data.hexId.startsWith('P') ? data.hexId.substring(1) : data.hexId;
            let pureBuffer;
            if (data.hexId.startsWith("P")) {
                pureBuffer = data.buffer;
            } else {
                const aesKey = await getMasterKey(data.password, data.saltHex);
                const ivBytes = hexToBuff(data.ivHex);
                pureBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivBytes) }, aesKey, data.buffer);
            }
            if (data.action === 'validate') {
                self.postMessage({ action: 'validate_done', crc16: calculateCRC16(pureBuffer), hexId: data.hexId });
            } else {
                self.postMessage({ action: 'weave_done', pureBuffer: pureBuffer, hexId: data.hexId }, [pureBuffer instanceof ArrayBuffer ? pureBuffer : pureBuffer.buffer]);
            }
        }
    } catch(err) {
        const errorMsg = err.name === 'OperationError' ? 'Invalid password' : err.message;
        self.postMessage({ action: 'error', error: errorMsg, reqAction: data.action, hexId: data.hexId });
    }
};
