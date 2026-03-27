let weaveWorkers = [];
let weaveWorkerIdx = 0;
let weavePendingTasks = new Map();
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
        weaveWorkers.forEach(w => w.terminate());
        weaveWorkers = [];
        weavePendingTasks.clear();
    });

    document.getElementById('btn-recover-map').addEventListener('click', async () => {
        const fileName = document.getElementById('weave-recover-name').value.trim();
        if (!fileName) return showToast('Enter original name', 'error');
        if (AppState.weaveFragments.size === 0) return showToast('Drop fragments first', 'error');

        let inferredSaltHex = "";
        let foundAny = false;
        for (const handle of AppState.weaveFragments.values()) {
            if (foundAny) break;
            foundAny = true;
            try {
                const fO = await handle.getFile();
                const hBuf = await fO.slice(0, CONSTANTS.HEADER_SIZE).arrayBuffer();
                const parsed = parseFragmentHeader(hBuf);
                inferredSaltHex = parsed.saltHex;
            } catch(e){}
        }

        const seedInput = document.getElementById('weave-seed').value;
        const seed = seedInput ? seedInput.trim() : "";
        const finalSeed = seed || "default";

        let highestFound = -1;
        const blockMap = [];
        const limit = 50000;

        for (let i = 0; i < limit; i++) {
            const hmac = CryptoJS.HmacSHA256(fileName + "_" + i, finalSeed + "_CUDI_SALT");
            const hexId = hmac.toString(CryptoJS.enc.Hex).substring(0, 16);
            blockMap.push(hexId);
            if (AppState.weaveFragments.has(hexId)) {
                highestFound = i;
            }
        }

        if (highestFound === -1) {
            return showToast('No block detected with that data', 'error');
        }

        blockMap.splice(highestFound + 1);

        AppState.weaveLoomData = {
            originalName: fileName,
            totalSize: 0,
            masterSaltHex: inferredSaltHex,
            blockMap: blockMap,
            hash: "n/a",
            deleteTokens: []
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

function initWeaveWorkers(num = navigator.hardwareConcurrency || 4) {
    weaveWorkers.forEach(w => w.terminate());
    weaveWorkers = [];
    weavePendingTasks.clear();
    for (let i = 0; i < num; i++) {
        const w = new Worker(getWorkerBlobUrl());
        w.onmessage = (e) => {
            const hid = e.data.hexId;
            if (weavePendingTasks.has(hid)) {
                const resolver = weavePendingTasks.get(hid);
                weavePendingTasks.delete(hid);
                if (e.data.action === 'error') resolver.reject(new Error(e.data.error));
                else resolver.resolve(e.data);
            }
        };
        weaveWorkers.push(w);
    }
    weaveWorkerIdx = 0;
}

const runWeaveWorkerAction = (action, buffer, hexId, ivHex, password, saltHex) => new Promise((resolve, reject) => {
    weavePendingTasks.set(hexId, {resolve, reject});
    const w = weaveWorkers[weaveWorkerIdx];
    weaveWorkerIdx = (weaveWorkerIdx + 1) % weaveWorkers.length;
    const transfer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    w.postMessage({ action, buffer, hexId, ivHex, password, saltHex }, [transfer]);
});

async function handleWeaveFiles(files) {
    isWeaveCancelled = false;
    document.getElementById('btn-cancel-weave').classList.remove('hidden');
    document.getElementById('btn-cancel-weave').textContent = "Stop Loom";
    document.getElementById('weave-status-box').classList.remove('hidden');

    const updateHeaderStatus = (m) => { document.getElementById('weave-status-text').textContent = m; };

    if (weaveWorkers.length === 0) initWeaveWorkers();

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
        const weaveSeedInput = document.getElementById('weave-seed') ? document.getElementById('weave-seed').value : "";
        const weaveSeed = weaveSeedInput ? weaveSeedInput.trim() : "default";

        for (let f of files) {
            if (isWeaveCancelled) break;

            if (f.name.toLowerCase().endsWith('.zip')) {
                updateHeaderStatus(`Extracting ${f.name}...`);
                if (f.size > 4294967296) {
                    showToast("ZIP too large. Extract manually and drag fragments.", "error");
                    continue;
                }
                let zipBuf;
                try {
                    zipBuf = await f.arrayBuffer();
                } catch(err) {
                    showToast(`ZIP too large (${f.name}). Please extract it manually and drop the files.`, 'error');
                    continue;
                }
                const unzipped = fflate.unzipSync(new Uint8Array(zipBuf));
                for (let filename in unzipped) {
                    const extractedUint8 = unzipped[filename];
                    files.push(new File([extractedUint8], filename));
                }
                continue;
            }

            if (f.name.endsWith('.loom')) {
                updateHeaderStatus(`Loading map ${f.name}...`);
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
                    const pureId = parsed.blockIdHex.startsWith('P') ? parsed.blockIdHex.substring(1) : parsed.blockIdHex;
                    if (AppState.weaveFragments.has(parsed.blockIdHex) || AppState.weaveFragments.has(pureId)) {
                        continue;
                    }

                    const fileBodyBlob = f.slice(CONSTANTS.HEADER_SIZE);
                    const cipheredBuffer = await fileBodyBlob.arrayBuffer();

                    let workerRes = null;
                    let retries = 0;
                    while (retries < 3) {
                         try {
                             const cloneBuffer = cipheredBuffer.slice(0);
                             workerRes = await runWeaveWorkerAction('validate', cloneBuffer, parsed.blockIdHex, parsed.ivHex, weaveSeed, parsed.saltHex);
                             if (workerRes.crc16 === parsed.checksum) break;
                         } catch(e) {
                             if (e.message === 'Invalid password') {
                                 showToast('Invalid password', 'error');
                                 isWeaveCancelled = true;
                                 break;
                             }
                         }
                         retries++;
                    }

                    if (isWeaveCancelled) break;

                    if (!workerRes || workerRes.crc16 !== parsed.checksum) {
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
                    updateHeaderStatus(`Analyzing ${f.name}...`);
                    updateWeaveUI();
                }
            }
        }

        if (isWeaveCancelled) {
            updateHeaderStatus("Process cancelled.");
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

    let { blockMap } = AppState.weaveLoomData;
    let foundCount = 0;
    
    const trueBlockMap = blockMap.filter(x => !x.startsWith("P"));

    for (let expectedHex of blockMap) {
        if (expectedHex === "Z") { foundCount++; continue; }
        const id = expectedHex.startsWith("P") ? expectedHex.substring(1) : expectedHex;
        if (AppState.weaveFragments.has(expectedHex) || AppState.weaveFragments.has(id)) foundCount++;
    }

    const statusObj = document.getElementById('weave-fragments');
    const corruptSize = AppState.weaveCorrupts.size;

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
        let dataBlocksFound = 0;
        for (let id of trueBlockMap) {
             if (id === 'Z') { dataBlocksFound++; continue; }
             if (AppState.weaveFragments.has(id)) dataBlocksFound++;
        }
        if (dataBlocksFound === trueBlockMap.length && corruptSize === 0) {
            document.getElementById('weave-status-text').textContent = `Health: 100% (Ready)`;
        } else {
            document.getElementById('weave-status-text').textContent = `Tolerance activated: ${trueBlockMap.length - dataBlocksFound} Missing Data Blocks | ${corruptSize} Corrupted`;
        }
    } else {
        document.getElementById('weave-status-text').textContent = `Waiting for fragments...`;
        document.getElementById('btn-reconstruct').classList.add('hidden');
    }
}

async function readAndDecryptFragment(hexId, weaveSeed, parsedSaltHex) {
    const pureId = hexId.startsWith("P") ? hexId.substring(1) : hexId;
    const fileHandle = AppState.weaveFragments.get(pureId);
    if (!fileHandle) throw new Error("Missing");
    const fileObj = await fileHandle.getFile();
    const slicedHeader = fileObj.slice(0, CONSTANTS.HEADER_SIZE);
    const headerBuf = await slicedHeader.arrayBuffer();
    const parsed = parseFragmentHeader(headerBuf);
    const cipheredBlob = fileObj.slice(CONSTANTS.HEADER_SIZE);
    const cipheredBuffer = await cipheredBlob.arrayBuffer();
    const workerRes = await runWeaveWorkerAction('weave', cipheredBuffer, hexId, parsed.ivHex, weaveSeed, parsed.saltHex || parsedSaltHex);
    return workerRes.pureBuffer;
}

async function recoverLostBlock(missingIndex, trueBlockMap, fullBlockMap, guessedChunkSize, weaveSeed, parsedSaltHex) {
    const groupStart = Math.floor(missingIndex / 10) * 10;
    const groupEnd = Math.min(groupStart + 10, trueBlockMap.length);
    
    let p1Hex = null;
    let trueBlocksCount = 0;
    for (let i = 0; i < fullBlockMap.length; i++) {
        if (!fullBlockMap[i].startsWith("P")) {
            trueBlocksCount++;
            if (trueBlocksCount === groupEnd) {
                p1Hex = fullBlockMap[i + 1];
                break;
            }
        }
    }

    if (!p1Hex || p1Hex === "Z") {
        throw new Error("Parity missing");
    }

    let recoveredData = new Uint8Array(guessedChunkSize);

    const p1Id = p1Hex.substring(1);
    if (!AppState.weaveFragments.has(p1Id)) throw new Error("Parity file missing");
    const p1Buffer = await readAndDecryptFragment(p1Hex, weaveSeed, parsedSaltHex);
    
    for (let k = 0; k < guessedChunkSize; k++) {
        recoveredData[k] ^= p1Buffer[k];
    }

    for (let i = groupStart; i < groupEnd; i++) {
        if (i === missingIndex) continue;
        
        const siblingHex = trueBlockMap[i];
        if (siblingHex === 'Z') continue;
        
        const siblingBuffer = await readAndDecryptFragment(siblingHex, weaveSeed, parsedSaltHex);
        for (let k = 0; k < guessedChunkSize; k++) {
            recoveredData[k] ^= siblingBuffer[k];
        }
    }

    return recoveredData;
}

async function doReconstruction() {
    const btn = document.getElementById('btn-reconstruct');
    const updateHeaderStatus = (m) => { document.getElementById('weave-status-text').textContent = m; };
    btn.disabled = true;
    btn.textContent = 'Processing data...';

    isWeaveCancelled = false;
    document.getElementById('btn-cancel-weave').classList.remove('hidden');

    try {
        if (weaveWorkers.length === 0) initWeaveWorkers();

        const { blockMap, originalName, hash, masterSaltHex, totalSize } = AppState.weaveLoomData;
        
        const reconstructedHandle = await weaveDir.getFileHandle(originalName.replace(/[/\\?%*:|"<>\0]/g, '_'), { create: true });
        const writable = await reconstructedHandle.createWritable();

        const trueBlockMap = blockMap.filter(x => !x.startsWith("P"));
        
        let guessedChunkSize = 1048576;
        let parsedSaltHex = masterSaltHex || "";
        let bytesWritten = 0;
        const firstValidId = blockMap.find(id => id !== "Z" && (AppState.weaveFragments.has(id) || AppState.weaveFragments.has(id.startsWith("P") ? id.substring(1) : id)));
        if (firstValidId) {
            const hndl = AppState.weaveFragments.get(firstValidId) || AppState.weaveFragments.get(firstValidId.startsWith("P") ? firstValidId.substring(1) : firstValidId);
            const firstFile = await hndl.getFile();
            guessedChunkSize = firstFile.size > CONSTANTS.HEADER_SIZE ? (firstFile.size - CONSTANTS.HEADER_SIZE) : guessedChunkSize;
            if (!parsedSaltHex) {
                 const slicedHeader = firstFile.slice(0, CONSTANTS.HEADER_SIZE);
                 const hBuf = await slicedHeader.arrayBuffer();
                 let tempParsed = parseFragmentHeader(hBuf);
                 parsedSaltHex = tempParsed.saltHex;
            }
        }

        let hashStream = null;
        if (hash && hash !== "n/a" && hash !== "file-too-large-for-memory-hash" && typeof CryptoJS !== 'undefined') {
             hashStream = CryptoJS.algo.SHA256.create();
        }

        const weaveSeedInput = document.getElementById('weave-seed') ? document.getElementById('weave-seed').value : "";
        const weaveSeed = weaveSeedInput ? weaveSeedInput.trim() : "default";

        const batchSize = 6;
        for (let i = 0; i < trueBlockMap.length; i += batchSize) {
            if (isWeaveCancelled) break;
            const batch = trueBlockMap.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (hexId, idx) => {
                 if (hexId === 'Z') {
                      return new Uint8Array(guessedChunkSize).fill(0);
                 }
                 if (!AppState.weaveFragments.has(hexId) || AppState.weaveCorrupts.has(hexId)) {
                      try {
                          updateHeaderStatus(`Recovering corrupted block ${i + idx + 1} mathematically...`);
                          const recovered = await recoverLostBlock(i + idx, trueBlockMap, blockMap, guessedChunkSize, weaveSeed, parsedSaltHex);
                          return recovered;
                      } catch (err) {
                          console.error(err);
                          throw new Error(`Data loss unrecoverable at block ${i + idx + 1}. Parity missing.`);
                      }
                 }
                 const fileHandle = AppState.weaveFragments.get(hexId);
                 const fileObj = await fileHandle.getFile();
                 const slicedHeader = fileObj.slice(0, CONSTANTS.HEADER_SIZE);
                 const headerBuf = await slicedHeader.arrayBuffer();
                 let parsed = parseFragmentHeader(headerBuf);
                 const cipheredBlob = fileObj.slice(CONSTANTS.HEADER_SIZE);
                 const cipheredBuffer = await cipheredBlob.arrayBuffer();
                 try {
                     const workerRes = await runWeaveWorkerAction('weave', cipheredBuffer, hexId, parsed.ivHex, weaveSeed, parsed.saltHex || parsedSaltHex);
                     return workerRes.pureBuffer;
                 } catch(e) {
                     return new Uint8Array(guessedChunkSize).fill(0);
                 }
            });

            updateHeaderStatus(`Decrypting blocks ${i + 1}-${Math.min(i + batchSize, trueBlockMap.length)}/${trueBlockMap.length}...`);
            const results = await Promise.all(batchPromises);
            
            for (let res of results) {
                 let finalRes = new Uint8Array(res);
                 if (totalSize > 0 && bytesWritten + finalRes.byteLength > totalSize) {
                      finalRes = finalRes.slice(0, totalSize - bytesWritten);
                 }
                 if (finalRes.byteLength > 0) {
                      if (hashStream) hashStream.update(CryptoJS.lib.WordArray.create(finalRes));
                      await writable.write(finalRes);
                      bytesWritten += finalRes.byteLength;
                 }
            }
        }

        if (isWeaveCancelled) {
            await writable.close();
            updateHeaderStatus("Reconstruction cancelled.");
            throw new Error("Cancelled by user");
        }

        updateHeaderStatus("Assembling final file...");
        await writable.close();

        if (hashStream) {
            updateHeaderStatus("Verifying SHA-256 signature...");
            const finalHashStr = hashStream.finalize().toString(CryptoJS.enc.Hex);
            if (finalHashStr !== hash) {
                throw new Error("Final file does not match the map SHA-256 signature.");
            }
        }

        const finalFile = await reconstructedHandle.getFile();
        downloadBlob(finalFile, originalName);
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
