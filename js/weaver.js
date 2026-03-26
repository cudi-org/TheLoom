let weaveWorker = null;
let isWeaveCancelled = false;
let weaveDir = null;

function initWeave() {
    const dropZone = document.getElementById('drop-weave');
    const fileInput = document.getElementById('file-weave');
    const btnRecon = document.getElementById('btn-reconstruct');
    const btnCancel = document.getElementById('btn-cancel-weave');

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');

        const items = e.dataTransfer.items;
        if (items) {
            let promises = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i].webkitGetAsEntry();
                if (item) promises.push(traverseFileTree(item));
            }
            const results = await Promise.all(promises);
            const files = results.flat();
            if (files.length) handleWeaveFiles(files);
        } else if (e.dataTransfer.files.length) {
            handleWeaveFiles(Array.from(e.dataTransfer.files));
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            handleWeaveFiles(Array.from(fileInput.files));
        }
    });

    btnRecon.addEventListener('click', doReconstruction);

    btnCancel.addEventListener('click', () => {
        isWeaveCancelled = true;
        btnCancel.textContent = "Cancelling...";
        if (weaveWorker) {
            weaveWorker.terminate();
            weaveWorker = null;
        }
    });

    document.getElementById('btn-recover-map').addEventListener('click', () => {
        const fileName = document.getElementById('weave-recover-name').value.trim();
        const seed = document.getElementById('weave-recover-seed').value;
        if (!fileName) return showToast('Enter original name', 'error');
        if (AppState.weaveFragments.size === 0) return showToast('Drop fragments first', 'error');

        let consecutiveMissing = 0;
        const blockMap = [];
        let i = 0;
        const limit = 10000;
        const finalSeed = seed || "default";

        while (consecutiveMissing < 20 && i < limit) {
            const hmac = CryptoJS.HmacSHA256(fileName + "_" + i, finalSeed + "_CUDI_SALT");
            const hexId = hmac.toString(CryptoJS.enc.Hex).substring(0, 16);
            blockMap.push(hexId);

            if (AppState.weaveFragments.has(hexId)) consecutiveMissing = 0;
            else consecutiveMissing++;
            i++;
        }

        blockMap.splice(blockMap.length - 20, 20);

        if (blockMap.length === 0) {
            return showToast('No block detected with that data', 'error');
        }

        AppState.weaveLoomData = {
            originalName: fileName,
            totalSize: 0,
            blockMap: blockMap,
            hash: "n/a"
        };
        document.getElementById('weave-file-name').textContent = fileName + " (Generated Map)";
        document.getElementById('weave-status-box').classList.remove('hidden');
        showToast(`Inferred mathematical map: ${blockMap.length} blocks`, 'success');
        updateWeaveUI();
    });
}

async function traverseFileTree(item) {
    return new Promise((resolve) => {
        if (item.isFile) {
            item.file(file => resolve([file]));
        } else if (item.isDirectory) {
            const dirReader = item.createReader();
            dirReader.readEntries(async entries => {
                let promises = [];
                for (let i = 0; i < entries.length; i++) {
                    promises.push(traverseFileTree(entries[i]));
                }
                const results = await Promise.all(promises);
                resolve(results.flat());
            });
        } else {
            resolve([]);
        }
    });
}

function initWeaveWorker() {
    if (weaveWorker) weaveWorker.terminate();
    weaveWorker = new Worker(getWorkerBlobUrl());
}

const runWeaveWorkerAction = (action, buffer, hexId) => new Promise(resolve => {
    weaveWorker.onmessage = (e) => resolve(e.data);
    const transfer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    weaveWorker.postMessage({ action, buffer, hexId }, [transfer]);
});

async function handleWeaveFiles(files) {
    isWeaveCancelled = false;
    document.getElementById('btn-cancel-weave').classList.remove('hidden');
    document.getElementById('btn-cancel-weave').textContent = "Stop Loom";
    document.getElementById('weave-status-box').classList.remove('hidden');

    const updateHeaderStatus = (m) => { document.getElementById('weave-status-text').textContent = m; };

    if (!weaveWorker) initWeaveWorker();

    class VirtualStorage {
        constructor(name) { this.name = name; this.files = new Map(); }
        async getFileHandle(name, options) {
            if (!this.files.has(name)) this.files.set(name, []);
            const self = this;
            return {
                name, kind: 'file',
                async createWritable() {
                    self.files.set(name, []);
                    return { async write(d) { self.files.get(name).push(d instanceof Blob ? d : new Uint8Array(d)); }, async close() { } };
                },
                async getFile() { return new Blob(self.files.get(name)); }
            };
        }
        async *entries() { for (const key of this.files.keys()) { yield [key, await this.getFileHandle(key)]; } }
        async removeEntry(name) { this.files.delete(name); }
    }

    let isVirtual = false;
    let opfsRoot;

    try {
        const opfsSupported = navigator.storage && navigator.storage.getDirectory;
        if (!opfsSupported) throw new Error("SecurityError_VirtualMap");

        const currentSession = Date.now().toString();
        opfsRoot = await navigator.storage.getDirectory();

        try {
            await cleanOldOPFSSessions(currentSession);
            if (!weaveDir) weaveDir = await opfsRoot.getDirectoryHandle(`weave_session_${currentSession}`, { create: true });
        } catch (e) {
            if (e.name === 'SecurityError') throw new Error("SecurityError_VirtualMap");
            else throw e;
        }

    } catch (err) {
        if (err.message === "SecurityError_VirtualMap" || err.name === "SecurityError") {
            isVirtual = true;
            opfsRoot = new VirtualStorage('virtual_root');
            if (!weaveDir) weaveDir = new VirtualStorage(`weave_virtual`);
            showToast("Local mode (file://). OPFS replaced by RAM storage.", "info");
        } else {
            console.error(err);
            updateHeaderStatus("File System Access Error.");
            showToast("FS access error", "error");
            return;
        }
    }

    try {
        for (let f of files) {
            if (isWeaveCancelled) break;

            if (f.name.toLowerCase().endsWith('.zip')) {
                updateHeaderStatus(`Extrayendo ${f.name}...`);
                const zipBuf = await f.arrayBuffer();
                const unzipped = fflate.unzipSync(new Uint8Array(zipBuf));
                for (let filename in unzipped) {
                    const extractedUint8 = unzipped[filename];
                    files.push(new File([extractedUint8], filename));
                }
                continue;
            }

            if (f.name.endsWith('.loom')) {
                updateHeaderStatus(`Cargando mapa ${f.name}...`);
                const text = await f.text();
                try {
                    AppState.weaveLoomData = JSON.parse(text);
                    const cleanName = deobfuscateString(AppState.weaveLoomData.originalName);
                    AppState.weaveLoomData.originalName = cleanName;
                    document.getElementById('weave-file-name').textContent = cleanName;
                    showToast(`Map loaded`, 'success');
                } catch (e) {
                    showToast("Invalid .loom file", 'error');
                }
            }
            else {
                AppState.weaveFileCountRead++;
                const sliced = f.slice(0, CONSTANTS.HEADER_SIZE);
                const headerBuf = await sliced.arrayBuffer();

                let parsed;
                try {
                    parsed = parseFragmentHeader(headerBuf);
                } catch (e) {
                    continue;
                }

                if (parsed && parsed.isLoom) {
                    if (AppState.weaveFragments.has(parsed.blockIdHex)) {
                        showToast(`Already added fragment ignored`, 'warning');
                        continue;
                    }

                    const fileBodyBlob = f.slice(CONSTANTS.HEADER_SIZE);
                    const cipheredBuffer = await fileBodyBlob.arrayBuffer();

                    const workerRes = await runWeaveWorkerAction('validate', cipheredBuffer, parsed.blockIdHex);

                    if (workerRes.crc16 !== parsed.checksum) {
                        AppState.weaveCorrupts.add(parsed.blockIdHex);
                    } else {
                        const fileHandle = await weaveDir.getFileHandle(parsed.blockIdHex, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(f);
                        await writable.close();

                        AppState.weaveFragments.set(parsed.blockIdHex, fileHandle);
                    }
                }

                if (AppState.weaveFileCountRead % 5 === 0 || files.length < 10) {
                    updateHeaderStatus(`Analizando ${f.name}...`);
                    updateWeaveUI();
                }
            }
        }

        if (isWeaveCancelled) {
            updateHeaderStatus("Proceso cancelado.");
            document.getElementById('btn-cancel-weave').classList.add('hidden');
            return;
        }

        updateHeaderStatus(`Analysis completed.`);
        updateWeaveUI();
    } catch (err) {
        showToast(err.message || "Error processing files", "error");
    }
}

function updateWeaveUI() {
    if (!AppState.weaveLoomData) {
        document.getElementById('weave-status-text').textContent = 'Missing .loom file to assemble';
        return;
    }

    const { blockMap } = AppState.weaveLoomData;
    let foundCount = 0;

    for (let expectedHex of blockMap) {
        if (AppState.weaveFragments.has(expectedHex)) foundCount++;
    }

    const statusObj = document.getElementById('weave-fragments');
    const corruptSize = AppState.weaveCorrupts.size;
    const missingCount = blockMap.length - foundCount;

    statusObj.textContent = `${foundCount} / ${blockMap.length} healthy fragments`;

    document.getElementById('weave-corrupts').textContent = corruptSize;
    if (corruptSize > 0) {
        document.getElementById('corrupt-item').style.background = 'rgba(255, 0, 0, 0.15)';
    } else {
        document.getElementById('corrupt-item').style.background = 'rgba(255, 255, 255, 0.03)';
    }

    const pct = Math.round((foundCount / blockMap.length) * 100) || 0;
    document.getElementById('weave-fill').style.width = pct + '%';
    document.getElementById('weave-percentage').textContent = pct + '%';

    if (foundCount > 0) {
        document.getElementById('btn-reconstruct').classList.remove('hidden');
        if (foundCount === blockMap.length && corruptSize === 0) {
            document.getElementById('weave-status-text').textContent = `Health: 100% (Ready)`;
        } else {
            document.getElementById('weave-status-text').textContent = `Tolerance activated: ${missingCount} Missing | ${corruptSize} Corrupted`;
        }
    } else {
        document.getElementById('weave-status-text').textContent = `Waiting for fragments...`;
        document.getElementById('btn-reconstruct').classList.add('hidden');
    }
}

async function doReconstruction() {
    const btn = document.getElementById('btn-reconstruct');
    const updateHeaderStatus = (m) => { document.getElementById('weave-status-text').textContent = m; };
    btn.disabled = true;
    btn.textContent = 'Processing data...';

    isWeaveCancelled = false;
    document.getElementById('btn-cancel-weave').classList.remove('hidden');

    try {
        if (!weaveWorker) initWeaveWorker();

        const { blockMap, originalName, hash } = AppState.weaveLoomData;
        const blobParts = [];

        let guessedChunkSize = 1048576;
        const firstValidId = blockMap.find(id => AppState.weaveFragments.has(id));
        if (firstValidId) {
            const hndl = AppState.weaveFragments.get(firstValidId);
            const firstFile = await hndl.getFile();
            guessedChunkSize = firstFile.size > CONSTANTS.HEADER_SIZE ? (firstFile.size - CONSTANTS.HEADER_SIZE) : guessedChunkSize;
        }

        for (let i = 0; i < blockMap.length; i++) {
            if (isWeaveCancelled) break;

            const hexId = blockMap[i];
            updateHeaderStatus(`Decrypting block ${i + 1}/${blockMap.length}...`);

            if (!AppState.weaveFragments.has(hexId) || AppState.weaveCorrupts.has(hexId)) {
                blobParts.push(new Uint8Array(guessedChunkSize));
                continue;
            }

            const fileHandle = AppState.weaveFragments.get(hexId);
            const fileObj = await fileHandle.getFile();

            const cipheredBlob = fileObj.slice(CONSTANTS.HEADER_SIZE);
            const cipheredBuffer = await cipheredBlob.arrayBuffer();

            const workerRes = await runWeaveWorkerAction('weave', cipheredBuffer, hexId);
            blobParts.push(workerRes.pureBuffer);
        }

        if (isWeaveCancelled) {
            updateHeaderStatus("Reconstrucción cancelada.");
            throw new Error("Cancelled by user");
        }

        updateHeaderStatus("Assembling final file...");

        const finalBlob = new Blob(blobParts);

        if (hash && hash !== "n/a" && hash !== "file-too-large-for-memory-hash" && finalBlob.size < 500 * 1024 * 1024) {
            updateHeaderStatus("Comprobando firma SHA-256...");
            const finalArrayBuffer = await finalBlob.slice().arrayBuffer();
            const finalHashRaw = await crypto.subtle.digest('SHA-256', finalArrayBuffer);
            const finalHashStr = buffToHex(finalHashRaw);
            if (finalHashStr !== hash) {
                throw new Error("Final file does not match the map SHA-256 signature.");
            }
        }

        downloadBlob(finalBlob, originalName);
        updateHeaderStatus("Weaving completed at 100%");
        showToast(`File "${originalName}" built and downloaded.`, 'success');

    } catch (e) {
        showToast(e.message || "Error reconstructing", "error");
    } finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Reconstruct File';
            document.getElementById('btn-cancel-weave').classList.add('hidden');
        }, 1000);
    }
}
