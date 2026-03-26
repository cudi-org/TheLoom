function parseFragmentHeader(buffer16) {
    const view = new DataView(buffer16);

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

    return {
        isLoom: true,
        blockIdHex,
        version,
        checksum
    };
}
