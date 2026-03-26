const CONSTANTS = {
    MAGIC_SIG: 0x4C4F4F4D,
    VERSION: 1,
    FLAGS: 0,
    HEADER_SIZE: 16
};

function hexToBuff(hexString) {
    return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer;
}

function calculateCRC16(buffer) {
    const arr = new Uint8Array(buffer);
    let crc = 0xFFFF;
    for (let i = 0; i < arr.length; i++) {
        crc ^= arr[i];
        for (let j = 0; j < 8; j++) {
            if ((crc & 1) !== 0) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc = crc >> 1;
            }
        }
    }
    return crc;
}

function xorBuffer(buffer, hexKey) {
    const arr = new Uint8Array(buffer);
    const keyArr = new Uint8Array(hexToBuff(hexKey));
    if (keyArr.length === 0) return arr.buffer;

    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        out[i] = arr[i] ^ keyArr[i % keyArr.length];
    }
    return out.buffer;
}

function createFragmentHeader(hexId, crc16) {
    const header = new ArrayBuffer(CONSTANTS.HEADER_SIZE);
    const view = new DataView(header);
    view.setUint32(0, CONSTANTS.MAGIC_SIG);
    view.setUint8(4, CONSTANTS.VERSION);
    view.setUint8(5, CONSTANTS.FLAGS);
    view.setUint16(6, crc16);
    const idBigInt = BigInt("0x" + hexId);
    view.setBigUint64(8, idBigInt);
    return header;
}

self.onmessage = function (e) {
    const data = e.data;
    if (data.action === 'scatter') {
        const crc16 = calculateCRC16(data.buffer);
        const encryptedSlice = xorBuffer(data.buffer, data.hexId);
        const header = createFragmentHeader(data.hexId, crc16);

        const combined = new Uint8Array(header.byteLength + encryptedSlice.byteLength);
        combined.set(new Uint8Array(header), 0);
        combined.set(new Uint8Array(encryptedSlice), header.byteLength);

        self.postMessage({
            action: 'scatter_done',
            combinedBuffer: combined.buffer,
            hexId: data.hexId
        }, [combined.buffer]);

    } else if (data.action === 'validate') {
        const pureBuffer = xorBuffer(data.buffer, data.hexId);
        const crc16 = calculateCRC16(pureBuffer);
        self.postMessage({
            action: 'validate_done',
            crc16: crc16,
            hexId: data.hexId
        }, [pureBuffer]);

    } else if (data.action === 'weave') {
        const pureBuffer = xorBuffer(data.buffer, data.hexId);
        self.postMessage({
            action: 'weave_done',
            pureBuffer: pureBuffer,
            hexId: data.hexId
        }, [pureBuffer]);
    }
};
