let scatterWorkers = [];
let currentWorkerIdx = 0;
let pendingTasks = new Map();
let isScatterCancelled = false;

function initScatter() {
    const dropZone = document.getElementById('drop-scatter');
    const fileInput = document.getElementById('file-scatter');
    const btnCancel = document.getElementById('btn-cancel-scatter');

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleScatter(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleScatter(fileInput.files[0]);
        fileInput.value = '';
    });

    btnCancel.addEventListener('click', () => {
        isScatterCancelled = true;
        btnCancel.textContent = "Cancelling...";
        scatterWorkers.forEach(w => w.terminate());
        scatterWorkers = [];
        pendingTasks.clear();
    });
}

function initScatterWorkers(num = navigator.hardwareConcurrency || 4) {
    scatterWorkers.forEach(w => w.terminate());
    scatterWorkers = [];
    pendingTasks.clear();
    for (let i = 0; i < num; i++) {
        const w = new Worker(getWorkerBlobUrl());
        w.onmessage = (e) => {
            const hid = e.data.hexId;
            if (pendingTasks.has(hid)) {
                pendingTasks.get(hid)(e.data);
                pendingTasks.delete(hid);
            }
        };
        scatterWorkers.push(w);
    }
    currentWorkerIdx = 0;
}

const runScatterWorker = (buffer, hexId, fakeHexId = null, mode = 'NORMAL', password = 'default', saltHex = '') => new Promise((resolve) => {
    pendingTasks.set(hexId, resolve);
    const w = scatterWorkers[currentWorkerIdx];
    currentWorkerIdx = (currentWorkerIdx + 1) % scatterWorkers.length;
    const transfer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    w.postMessage({ action: 'scatter', buffer, hexId, fakeHexId, mode, password, saltHex }, [transfer]);
});

function formatTime(secs) {
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

async function handleScatter(file) {
    if (file.name.toLowerCase().endsWith('.zip') && file.size > 4294967296) {
        showToast("ZIP too large. Extract manually and drag fragments.", "error");
        return;
    }
    isScatterCancelled = false;
    initScatterWorkers();

    let chunkSize = parseInt(document.getElementById('chunk-size').value, 10) || CONSTANTS.DEFAULT_CHUNK_SIZE;
    const totalSize = file.size;
    const seedInput = document.getElementById('cudi-seed').value;
    const seed = seedInput ? seedInput.trim() : "";
    const finalSeed = seed || "default";

    const masterSaltBytes = crypto.getRandomValues(new Uint8Array(16));
    const masterSaltHex = buffToHex(masterSaltBytes);

    if (totalSize > 500 * 1024 * 1024) {
        chunkSize = Math.max(chunkSize, 4 * 1024 * 1024);
    }

    const progContainer = document.getElementById('progress-scatter-container');
    const progFill = document.getElementById('scatter-fill');
    const progStatus = document.getElementById('scatter-status');
    const progPercentage = document.getElementById('scatter-percentage');
    const memoryWarning = document.getElementById('memory-warning');
    const btnCancel = document.getElementById('btn-cancel-scatter');
    const etaSpan = document.getElementById('scatter-eta');

    btnCancel.classList.remove('hidden');
    btnCancel.textContent = "Stop Loom";
    etaSpan.textContent = "";

    let opfsRoot, scatterDir;
    let isVirtual = false;

    let hasher = null;
    if (typeof CryptoJS !== 'undefined') {
        hasher = CryptoJS.algo.SHA256.create();
    }

    class VirtualStorage {
        constructor(name) { this.name = name; this.files = new Map(); }
        async getFileHandle(name, options) {
            if (!this.files.has(name)) this.files.set(name, []);
            const self = this;
            return {
                name, kind: 'file',
                async createWritable() {
                    self.files.set(name, []);
                    return { async write(d) { self.files.get(name).push(new Uint8Array(d)); }, async close() { } };
                },
                async getFile() { return new Blob(self.files.get(name)); }
            };
        }
        async *entries() { for (const key of this.files.keys()) { yield [key, await this.getFileHandle(key)]; } }
        async removeEntry(name) { this.files.delete(name); }
    }

    try {
        const opfsSupported = navigator.storage && navigator.storage.getDirectory;
        if (!opfsSupported) throw new Error("SecurityError_VirtualMap");

        opfsRoot = await navigator.storage.getDirectory();
        const currentSession = Date.now().toString();

        try {
            await cleanOldOPFSSessions(currentSession);
            scatterDir = await opfsRoot.getDirectoryHandle(`scatter_${currentSession}`, { create: true });
        } catch (e) {
            if (e.name === 'SecurityError') throw new Error("SecurityError_VirtualMap");
            else throw e;
        }

        memoryWarning.classList.add('hidden');
    } catch (err) {
        if (err.message === "SecurityError_VirtualMap" || err.name === "SecurityError") {
            isVirtual = true;
            opfsRoot = new VirtualStorage('virtual_root');
            scatterDir = new VirtualStorage(`scatter_virtual`);
            const mbs = (totalSize / 1024 / 1024).toFixed(0);
            if (totalSize > 500 * 1024 * 1024) {
                memoryWarning.classList.remove('hidden');
                memoryWarning.innerHTML = ` Local Mode. Files size: ${mbs}MB.`;
            } else {
                showToast("OPFS replaced by virtual RAM.", "info");
            }
        } else {
            console.error(err);
            progStatus.textContent = "Error initializing scatter";
            showToast("FS access error", "error");
            return;
        }
    }

    try {
        progContainer.classList.remove('hidden');
        progStatus.textContent = `Preparing fragments...`;
        progFill.style.width = '0%';

        const ddeModeSelect = document.getElementById('dde-mode');
        const mode = ddeModeSelect ? ddeModeSelect.value : 'NORMAL';
        const enableParity = document.getElementById('chk-parity') && document.getElementById('chk-parity').checked;

        const ddeDb = new Map(); 

        const loomMap = {
            originalName: obfuscateString(file.name),
            totalSize: totalSize,
            masterSaltHex: masterSaltHex,
            hash: "n/a",
            blockMap: [],
            deleteTokens: []
        };

        const mapSegments = [];

        const totalChunks = Math.ceil(totalSize / chunkSize);
        showToast(`Fragmenting ${file.name} into ${totalChunks} chunks with multithreading...`, 'info');

        const stream = file.stream();
        const reader = stream.getReader();
        let chunkIndex = 0;

        let accumulated = new Uint8Array(chunkSize);
        let accLen = 0;
        let isDone = false;

        const startTime = Date.now();
        let bytesProcessed = 0;
        
        let parityBlocks = [];

        const processPromises = [];
        const MAX_INFLIGHT = scatterWorkers.length * 2;

        while (!isDone && !isScatterCancelled) {
            const { value, done } = await reader.read();
            if (done) {
                isDone = true;
                if (accLen > 0) {
                    processPromises.push(processAndWriteChunk(accumulated.slice(0, accLen), chunkIndex++));
                }
                break;
            }

            let offset = 0;
            while (offset < value.byteLength && !isScatterCancelled) {
                const space = chunkSize - accLen;
                const toCopy = Math.min(space, value.byteLength - offset);

                accumulated.set(value.subarray(offset, offset + toCopy), accLen);
                accLen += toCopy;
                offset += toCopy;

                if (accLen === chunkSize) {
                    processPromises.push(processAndWriteChunk(accumulated.slice(), chunkIndex++));
                    accLen = 0;

                    if (processPromises.length >= MAX_INFLIGHT) {
                        await Promise.all(processPromises);
                        processPromises.length = 0;
                    }
                }
            }
        }

        await Promise.all(processPromises);

        async function processAndWriteChunk(slice, i) {
            if (isScatterCancelled) return;

            if (hasher) {
                const wordArray = CryptoJS.lib.WordArray.create(slice);
                hasher.update(wordArray);
            }

            let hexId;
            if (typeof CryptoJS !== 'undefined') {
                const hmac = CryptoJS.HmacSHA256(file.name + "_" + i, finalSeed + "_CUDI_SALT");
                hexId = hmac.toString(CryptoJS.enc.Hex).substring(0, 16);
            } else {
                const idBuffer = new Uint8Array(8);
                crypto.getRandomValues(idBuffer);
                hexId = buffToHex(idBuffer);
            }

            let writeChunk = true;
            if (mode === 'DDE' && typeof CryptoJS !== 'undefined') {
                 const blockHashRaw = CryptoJS.lib.WordArray.create(slice);
                 const blockHashHex = CryptoJS.SHA256(blockHashRaw).toString(CryptoJS.enc.Hex);
                 if (ddeDb.has(blockHashHex)) {
                      hexId = ddeDb.get(blockHashHex);
                      writeChunk = false;
                 } else {
                      ddeDb.set(blockHashHex, hexId);
                 }
            }

            if (enableParity && writeChunk) {
                 if (parityBlocks.length === 0) {
                      parityBlocks.push(new Uint8Array(chunkSize));
                      parityBlocks.push(new Uint8Array(chunkSize));
                 }
                 for (let k = 0; k < slice.byteLength; k++) {
                      parityBlocks[0][k] ^= slice[k];
                      parityBlocks[1][k] ^= (slice[k] ^ ((k % 255) + 1));
                 }
            }

            if (writeChunk) {
                 const workerResult = await runScatterWorker(slice, hexId, null, mode, finalSeed, masterSaltHex);
                 if (workerResult.action === 'skip_zero' || workerResult.isZero) {
                     mapSegments.push({ i, hexId: "Z" });
                 } else {
                     mapSegments.push({ i, hexId });
                     if (typeof CryptoJS !== 'undefined') {
                          loomMap.deleteTokens.push(CryptoJS.HmacSHA256(hexId, finalSeed + "_DELETE").toString(CryptoJS.enc.Hex).substring(0, 16));
                     }
                     const combinedBuffer = workerResult.combinedBuffer;
                     const randomName = `${hexId}.cudi`;
                     const fileHandle = await scatterDir.getFileHandle(randomName, { create: true });
                     const writable = await fileHandle.createWritable();
                     await writable.write(combinedBuffer);
                     await writable.close();
                     bytesProcessed += combinedBuffer.byteLength;
                     const elapsed = (Date.now() - startTime) / 1000;
                     if (elapsed > 1 && bytesProcessed > 0) {
                         const mbps = (bytesProcessed / 1024 / 1024) / elapsed;
                         const remainingBytes = totalSize - (i * chunkSize);
                         const secsRemaining = Math.max(0, Math.floor((remainingBytes / 1024 / 1024) / mbps));
                         etaSpan.textContent = `Estimated remaining: ${formatTime(secsRemaining)}`;
                     }
                 }
            } else {
                 mapSegments.push({ i, hexId });
            }

            const pct = Math.round(((i + 1) / totalChunks) * 100);
            progFill.style.width = pct + '%';
            progPercentage.textContent = pct + '%';
            progStatus.textContent = `Written block ${i + 1} of ${totalChunks}`;
            
            if (enableParity && parityBlocks.length > 0 && ((i + 1) % 10 === 0 || i === totalChunks - 1)) {
                 const p1Hex = CryptoJS.HmacSHA256(hexId + "_P1", finalSeed + "_CUDI_SALT").toString(CryptoJS.enc.Hex).substring(0, 16);
                 const p2Hex = CryptoJS.HmacSHA256(hexId + "_P2", finalSeed + "_CUDI_SALT").toString(CryptoJS.enc.Hex).substring(0, 16);
                 mapSegments.push({ i: i + 0.1, hexId: "P" + p1Hex });
                 mapSegments.push({ i: i + 0.2, hexId: "P" + p2Hex });
                 let w1 = await runScatterWorker(parityBlocks[0], "P" + p1Hex, p1Hex, 'NORMAL', finalSeed, masterSaltHex);
                 let h1 = await scatterDir.getFileHandle(`${p1Hex}.cudi`, { create: true });
                 let wr1 = await h1.createWritable();
                 await wr1.write(w1.combinedBuffer);
                 await wr1.close();
                 let w2 = await runScatterWorker(parityBlocks[1], "P" + p2Hex, p2Hex, 'NORMAL', finalSeed, masterSaltHex);
                 let h2 = await scatterDir.getFileHandle(`${p2Hex}.cudi`, { create: true });
                 let wr2 = await h2.createWritable();
                 await wr2.write(w2.combinedBuffer);
                 await wr2.close();
                 parityBlocks = [];
            }
        }

        if (isScatterCancelled) {
            progStatus.textContent = "Process cancelled by user.";
            showToast("Scatter cancelled", "warning");
            setTimeout(() => { progContainer.classList.add('hidden'); btnCancel.classList.add('hidden'); etaSpan.textContent = ""; }, 3000);
            return;
        }

        mapSegments.sort((a, b) => a.i - b.i);
        loomMap.blockMap = mapSegments.map(s => s.hexId);

        if (hasher) {
            loomMap.hash = hasher.finalize().toString(CryptoJS.enc.Hex);
            progStatus.textContent = "SHA-256 signature completed.";
        }

        etaSpan.textContent = "Finishing...";
        progStatus.textContent = "Streaming ZIP to OPFS (Max RAM Saved)...";
        await delay(50);

        const zipFileHandle = await scatterDir.getFileHandle(`${file.name}.zip`, { create: true });
        const zipWritable = await zipFileHandle.createWritable();

        let wrapPromise = Promise.resolve();

        const zip = new fflate.Zip((err, dat, final) => {
            if (!err && dat.length) {
                wrapPromise = wrapPromise.then(() => zipWritable.write(dat));
            }
            if (final) {
                wrapPromise.then(async () => {
                    await zipWritable.close();

                    const finalZipFile = await zipFileHandle.getFile();
                    downloadBlob(finalZipFile, `Loom_${file.name}.zip`);

                    progStatus.textContent = "Scatter completed";
                    etaSpan.textContent = "";
                    showToast("ZIP Streaming process finished successfully.", "success");
                    setTimeout(() => { progContainer.classList.add('hidden'); btnCancel.classList.add('hidden'); }, 3000);
                });
            }
        });

        const fakeExtsInput = document.getElementById('fake-exts').value.trim();
        const extsArr = fakeExtsInput ? fakeExtsInput.split(',').map(e => e.trim()) : CONSTANTS.FAKE_EXTS;

        const uniqueBlocks = [...new Set(loomMap.blockMap)];

        for (let j = 0; j < uniqueBlocks.length; j++) {
            const hexIdRaw = uniqueBlocks[j];
            if (hexIdRaw === 'Z') continue;
            const isParity = hexIdRaw.startsWith("P");
            const hexId = isParity ? hexIdRaw.substring(1) : hexIdRaw;
            const name = `${hexId}.cudi`;

            const ext = extsArr[Math.floor(Math.random() * extsArr.length)];
            const pureExt = ext.startsWith('.') ? ext : `.${ext}`;
            const zName = `dx_${hexId.substring(0, 6)}${pureExt}`;

            const handle = await scatterDir.getFileHandle(name);
            const subFile = await handle.getFile();
            const def = new fflate.ZipPassThrough(zName);
            zip.add(def);

            const stream = subFile.stream();
            const reader = stream.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (value) {
                    def.push(value);
                    await wrapPromise;
                }
                if (done) {
                    def.push(new Uint8Array(0), true);
                    await wrapPromise;
                    break;
                }
            }
        }

        const loomMetaBuffer = new TextEncoder().encode(JSON.stringify(loomMap, null, 2));
        const loomDef = new fflate.ZipPassThrough(`${obfuscateString(file.name).substring(0, 6)}.loom`);
        zip.add(loomDef);
        loomDef.push(loomMetaBuffer, true);
        await wrapPromise;
        zip.end();

    } catch (e) {
        console.error(e);
        progStatus.textContent = "Error scattering";
        showToast(e.message || "Error processing file", "error");
    }
}
