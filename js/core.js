class LoomCore {
    static async deriveRawKeys(password, saltHex) {
        if (!password) throw new Error("Key is mandatory");
        const cacheKey = password + ":" + saltHex;
        if (this._rawKeyCache && this._rawKeyCache.has(cacheKey)) return this._rawKeyCache.get(cacheKey);

        const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        
        let hash;
        if (typeof hashwasm !== 'undefined') {
            hash = await hashwasm.argon2id({
                password: password,
                salt: salt,
                parallelism: 1,
                iterations: 2,
                memorySize: 512,
                hashLength: 32,
                outputType: 'binary'
            });
        } else {
            const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
            hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256));
        }

        const hmacKeyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password + saltHex + "HMAC_DOMAIN"), { name: "PBKDF2" }, false, ["deriveBits"]);
        const hmacRaw = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: 1, hash: "SHA-256" }, hmacKeyMaterial, 256));

        const keys = { aes: hash.buffer, hmac: hmacRaw.buffer };
        if (!this._rawKeyCache) this._rawKeyCache = new Map();
        this._rawKeyCache.set(cacheKey, keys);
        return keys;
    }

    static async computeSyntheticNonce(contentBuffer, password, saltHex) {
        // IV derived from chunk content and password
        const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password + saltHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("HMAC", keyMaterial, contentBuffer);
        return new Uint8Array(signature).slice(0, 12);
    }

    static async signHeader(buffer36, password, saltHex) {
        const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password + saltHex + "_header"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("HMAC", keyMaterial, buffer36);
        return new Uint8Array(signature).slice(0, 4);
    }

    static async createFragmentHeader(hexId, ivBuff, saltBuff, password) {
        const baseHeader = new ArrayBuffer(36);
        const view = new DataView(baseHeader);
        view.setBigUint64(0, BigInt("0x" + (hexId.startsWith('P') ? hexId.substring(1) : hexId)));
        new Uint8Array(baseHeader).set(new Uint8Array(ivBuff), 8);
        new Uint8Array(baseHeader).set(new Uint8Array(saltBuff), 20);

        const saltHex = [...new Uint8Array(saltBuff)].map(x => x.toString(16).padStart(2, '0')).join('');
        const hmac4 = await this.signHeader(baseHeader, password, saltHex);

        const finalHeader = new ArrayBuffer(40);
        new Uint8Array(finalHeader).set(new Uint8Array(baseHeader), 0);
        new Uint8Array(finalHeader).set(hmac4, 36);
        
        return finalHeader;
    }

    static async encryptMap(jsonString, password) {
        if (!password) throw new Error("Key is mandatory");
        const masterSalt = crypto.getRandomValues(new Uint8Array(16));
        const saltHex = [...masterSalt].map(x => x.toString(16).padStart(2, '0')).join('');
        const rawKeys = await this.deriveRawKeys(password, saltHex);
        const aesKey = await crypto.subtle.importKey("raw", rawKeys.aes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        const contentBuffer = new TextEncoder().encode(jsonString);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, contentBuffer);
        
        const finalBuffer = new Uint8Array(16 + 12 + encrypted.byteLength);
        finalBuffer.set(masterSalt, 0);
        finalBuffer.set(iv, 16);
        finalBuffer.set(new Uint8Array(encrypted), 28);
        
        return finalBuffer;
    }

    static async decryptMap(buffer, password) {
        if (!password) throw new Error("Key is mandatory");
        if (buffer.byteLength < 28) throw new Error("Invalid Map File");
        
        const masterSalt = new Uint8Array(buffer.slice(0, 16));
        const iv = new Uint8Array(buffer.slice(16, 28));
        const ciphertext = buffer.slice(28);
        
        const saltHex = [...masterSalt].map(x => x.toString(16).padStart(2, '0')).join('');
        const rawKeys = await this.deriveRawKeys(password, saltHex);
        const aesKey = await crypto.subtle.importKey("raw", rawKeys.aes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        
        try {
            const pureBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, aesKey, ciphertext);
            return new TextDecoder().decode(pureBuffer);
        } catch(e) {
            throw new Error("Invalid Master Key or Map corrupted");
        }
    }
}

// Reed-Solomon Erasure Coding (Galois Field 2^8)
class ReedSolomon {
    constructor() {
        this.exp = new Uint8Array(512);
        this.log = new Uint8Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            this.exp[i] = x;
            this.exp[i + 255] = x;
            this.log[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        this.log[0] = 0;
    }

    mul(a, b) {
        if (a === 0 || b === 0) return 0;
        return this.exp[this.log[a] + this.log[b]];
    }

    div(a, b) {
        if (a === 0) return 0;
        if (b === 0) throw new Error("Div by 0");
        return this.exp[(this.log[a] + 255 - this.log[b]) % 255];
    }

    // Generate parity shards from data shards
    encode(dataShards, numParity) {
        const numData = dataShards.length;
        const shardSize = dataShards[0].length;
        const parityShards = Array.from({length: numParity}, () => new Uint8Array(shardSize));
        
        for (let i = 0; i < numParity; i++) {
            for (let j = 0; j < numData; j++) {
                const coef = this.exp[this.log[i + 1] * j % 255] || 1; 
                for (let k = 0; k < shardSize; k++) {
                    if (j === 0) parityShards[i][k] = this.mul(dataShards[j][k], coef);
                    else parityShards[i][k] ^= this.mul(dataShards[j][k], coef);
                }
            }
        }
        return parityShards;
    }

    buildMatrix(numData, numParity) {
        const matrix = [];
        for (let i = 0; i < numData + numParity; i++) {
            const row = new Uint8Array(numData);
            if (i < numData) {
                row[i] = 1;
            } else {
                for (let j = 0; j < numData; j++) {
                    row[j] = this.exp[this.log[(i - numData) + 1] * j % 255] || 1;
                }
            }
            matrix.push(row);
        }
        return matrix;
    }

    inverse(matrix) {
        const n = matrix.length;
        const inv = Array.from({length: n}, (_, i) => {
            const row = new Uint8Array(n);
            row[i] = 1;
            return row;
        });

        for (let i = 0; i < n; i++) {
            let pivot = i;
            while(pivot < n && matrix[pivot][i] === 0) pivot++;
            if (pivot === n) throw new Error("Singular matrix - Not enough shards");
            
            [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
            [inv[i], inv[pivot]] = [inv[pivot], inv[i]];
            
            const invPivot = this.div(1, matrix[i][i]);
            for (let j = 0; j < n; j++) {
                matrix[i][j] = this.mul(matrix[i][j], invPivot);
                inv[i][j] = this.mul(inv[i][j], invPivot);
            }
            
            for (let k = 0; k < n; k++) {
                if (k !== i && matrix[k][i] !== 0) {
                    const factor = matrix[k][i];
                    for (let j = 0; j < n; j++) {
                        matrix[k][j] ^= this.mul(matrix[i][j], factor);
                        inv[k][j] ^= this.mul(inv[i][j], factor);
                    }
                }
            }
        }
        return inv;
    }

    reconstruct(shards, dataIndexes, totalData) {
        const matrix = this.buildMatrix(totalData, Math.max(0, shards.length - totalData));
        const subMatrix = dataIndexes.map(idx => new Uint8Array(matrix[idx]));
        const inv = this.inverse(subMatrix);
        
        const recovered = [];
        const shardSize = shards[0].length;
        for(let i=0; i<totalData; i++){
             const out = new Uint8Array(shardSize);
             for(let j=0; j<shards.length; j++){
                  if(inv[i][j] !== 0){
                       for(let k=0; k<shardSize; k++){
                            out[k] ^= this.mul(inv[i][j], shards[j][k]);
                       }
                  }
             }
             recovered.push(out);
        }
        return recovered;
    }
}

window.LoomCore = LoomCore;
window.ReedSolomon = ReedSolomon;
