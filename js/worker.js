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
            
            // Synthetic Nonce (IV)
            const ivSig = await crypto.subtle.sign("HMAC", hmac, data.buffer);
            const iv = new Uint8Array(ivSig).slice(0, 12);
            
            const encryptedSlice = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aes, data.buffer);
            
            const baseHeader = new ArrayBuffer(36);
            const view = new DataView(baseHeader);
            const pureId = data.hexId.startsWith('P') ? data.hexId.substring(1) : data.hexId;
            view.setBigUint64(0, BigInt("0x" + pureId));
            new Uint8Array(baseHeader).set(iv, 8);
            new Uint8Array(baseHeader).set(new Uint8Array(data.masterSaltBuffer), 20);
            
            // Header Authentication Tag
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
            
            // Fast Auth check
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
