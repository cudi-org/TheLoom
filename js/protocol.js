function parseFragmentHeader(buffer44) {
    const view = new DataView(buffer44);

    const magic = view.getUint32(0);
    if (magic !== CONSTANTS.MAGIC_SIG) {
        return { isLoom: false };
    }

    const version = view.getUint8(4);
    if (version !== CONSTANTS.VERSION) {
        throw new Error("Unsupported version");
    }

    const idBigInt = view.getBigUint64(8);
    const blockIdHex = idBigInt.toString(16).padStart(16, '0');
    const checksum = view.getUint16(6);

    const ivBytes = new Uint8Array(buffer44, 16, 12);
    const ivHex = [...ivBytes].map(x => x.toString(16).padStart(2, '0')).join('');

    const saltBytes = new Uint8Array(buffer44, 28, 16);
    const saltHex = [...saltBytes].map(x => x.toString(16).padStart(2, '0')).join('');

    return {
        isLoom: true,
        blockIdHex,
        version,
        checksum,
        ivHex,
        ivBytes,
        saltHex,
        saltBytes
    };
}
