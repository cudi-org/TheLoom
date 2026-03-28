#  The Loom

**The Loom** is a production-grade, secure, and highly resilient in-browser file fragmentation and reconstruction system. It allows you to scatter large files into obfuscated, encrypted fragments (noise) and later "weave" them back into the original file seamlessly using a `.loom` map. 

Built with performance, stealth, and fault-tolerance in mind, The Loom operates entirely on the client-side within the browser, leveraging **Web Workers** for multi-threading and the **Origin Private File System (OPFS)** for memory-efficient streaming of extremely large files (e.g., `.ova` or `.iso` images).

---

##  Core Features

- **Advanced Cryptography:** Files are secured using **AES-256-GCM** authenticated encryption with **PBKDF2** key derivation, ensuring maximum security before the data is scattered.
- **Memory-Efficient Streaming:** Replaces memory-intensive operations with robust reading/writing to **OPFS**. This enables multi-gigabyte files to be processed incrementally without crashing the browser's RAM.
- **Content-Aware Deduplication (DDE) & Zero-Skip:** Includes intelligent detection of Zero-blocks and data deduplication via incremental **SHA-256 hashing**. Reduces both processing time and the final storage footprint for sparse files.
- **Fault-Tolerant Reconstruction (Parity):** Employs **Error Parity (XOR+2)** generating redundant fragments to ensure the original file can still be recovered even if partial fragments are lost or corrupted.
- **Stealth & Obfuscation:** Fragments are exported under disguised file extensions (`.sys`, `.dll`, `.dat`, `.chk`), effectively blending sensitive payload data with normal operating system noise.
- **Deterministic Recovery:** No `.loom` map file? No problem. You can forcefully reconstruct your file using an *Exact Original Name* and a *Master Crypto Key* using the deterministic map generation mechanism.
- **Self-Contained Portable Runtime:** Want to extract data offline in the future? Use the **Export Runtime** feature to download a fully functional, self-hosted HTML mini-version of The Loom, guaranteeing data access forever without external dependencies.
- **Multi-threaded Worker Pool:** Features dynamic scaling using Web Workers for parallel processing of cryptographic hashing, encryption, and chunk generation.

---

## 🐈 The "Schrödinger's File": Probabilistic Existence

I have named this concept the **"Schrödinger's File"** for a fundamental technical reason:

- **State of Scatter**: While the file is in a state of Scatter (dispersed), the original file as a unit of information has ceased to exist in the logical space. What remains is a "cloud of probabilities" (`.cudi` fragments).
- **Data Superposition**: An individual fragment is not "a part" of the file (as it would be in a split `.zip`), but a cryptographic transformation that, on its own, holds no coherent information.
- **State Collapse (Weaving)**: The original file only "collapses" back into reality when the Weaver observes enough fragments and applies the correct cryptographic key.
- **Quantum Resilience (Parity)**: Thanks to the XOR parity, the system allows a piece of the "box" to be missing, yet the final file still emerges intact. The "observer" (the user with their `.loom` map) forces the reconstruction of the original reality out of entropy.

---

##  How it Works

The application interfaces through two primary modes:

### 1. Scatter (Fragment Your Files)
1. **Drop a file:** Select large files, directories, or disk images.
2. **Configure Security:** Define a custom Crypto Key (Seed), select your block size (512KB to 4MB), and specify camouflage extensions.
3. **Data Processing:** The file is hashed in chunks, compressed, encrypted, and split into multiple `.bin` or disguised binary objects.
4. **Output:** You receive the obfuscated data chunks plus a single `.loom` file which holds the JSON-based metadata map (locations, original names, salts) required to rebuild the file.

### 2. Weaving (Reconstruct Data)
1. **Drop data:** Import your `.loom` metadata map alongside all the generated scattered fragments. 
2. **Analysis:** The Weaver parses the map, hashes the inputted chunks, and validates the integrity of each part. It instantly flags missing or corrupted chunks.
3. **Reconstruction:** Clicking "Reconstruct" seamlessly streams the decrypted, unzipped chunks from OPFS directly to your local file system, re-creating the original file perfectly.

---

##  Tech Stack & Architecture

- **Vanilla JavaScript (ES6+)** - Pure client-side execution logic.
- **Web Workers API** - Off-main-thread dynamic worker pool for heavy cryptography.
- **Origin Private File System (OPFS)** - High-performance temporary local storage.
- **CryptoJS** - Provides AES-256-GCM and PBKDF2 logic.
- **fflate** - Extremely fast and lightweight streaming Zip / Deflate implementation in JS.
- **HTML5 / CSS3** - Responsive, glassmorphism-themed UI.

---

##  Getting Started

Because The Loom relies entirely on Client-Side technologies (and strict Origin Private File System contexts), it must be served through a local HTTP Server. 

1. **Clone or Download** this repository.
2. **Run a local static server**. For example, using Python:
   ```bash
   python -m http.server 8000
   ```
   *Or using Node.js:*
   ```bash
   npx serve .
   ```
3. **Open your browser** and navigate to `http://localhost:8000`
4. Enjoy private, serverless file scattering.

---

##  License & Privacy

All operations in **The Loom** occur locally on your machine. No data, seeds, hashes, or fragments are ever transmitted to any external server. 
*(See the `LICENSE` file for full terms and conditions).*
