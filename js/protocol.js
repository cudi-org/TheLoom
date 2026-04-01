function parseFragmentHeader(buffer36) {
    const view = new DataView(buffer36);

    const idBigInt = view.getBigUint64(0);
    const blockIdHex = idBigInt.toString(16).padStart(16, '0');

    const ivBytes = new Uint8Array(buffer36, 8, 12);
    const ivHex = [...ivBytes].map(x => x.toString(16).padStart(2, '0')).join('');

    const saltBytes = new Uint8Array(buffer36, 20, 16);
    const saltHex = [...saltBytes].map(x => x.toString(16).padStart(2, '0')).join('');

    return {
        isLoom: true,
        blockIdHex,
        ivHex,
        ivBytes,
        saltHex,
        saltBytes
    };
}
