#!/usr/bin/env node
const crypto = require("crypto");
const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

// ─── Fast EC: try native secp256k1, fallback to ethers ───────────────────────
let fastPubkey;
try {
    const secp   = require("secp256k1");
    const keccak = require("keccak");
    fastPubkey = (privBuf) => {
        const pubRaw = secp.publicKeyCreate(Buffer.from(privBuf), false);
        const pub    = Buffer.from(pubRaw).slice(1); // 64 bytes uncompressed
        const hash   = keccak("keccak256").update(pub).digest();
        return "0x" + hash.slice(12).toString("hex");
    };
    if (isMainThread) console.log("\x1b[32m⚡ Native secp256k1 loaded - FAST MODE\x1b[0m");
} catch(e) {
    const { ethers } = require("ethers");
    fastPubkey = (privBuf) => {
        const sk = new ethers.SigningKey("0x" + privBuf.toString("hex"));
        return ethers.computeAddress(sk.publicKey).toLowerCase();
    };
    if (isMainThread) console.log("\x1b[33m⚠ Fallback to ethers (slower)\x1b[0m");
}

const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const CONFIG = {
    prefix:      "a1b7c",
    apiEndpoint: "http://52.44.108.84:8084/new/record",
    statsFile:   path.join(__dirname, ".aibtc.stats"),
    BATCH_SIZE:  2000,
};
const C = { reset:"\x1b[0m",green:"\x1b[32m",yellow:"\x1b[33m",blue:"\x1b[34m",magenta:"\x1b[35m",cyan:"\x1b[36m",red:"\x1b[31m" };

function log(msg, c="reset") {
    const ts = new Date().toISOString();
    console.log(C[c] + msg + C.reset);
    try { fs.appendFileSync(path.join(__dirname,".aibtc.log"), "["+ts+"] "+msg+"\n"); } catch(_){}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function save(s) { try { fs.writeFileSync(CONFIG.statsFile, JSON.stringify(s,null,2)); } catch(_){} }
function load() {
    try { return JSON.parse(fs.readFileSync(CONFIG.statsFile,"utf8")); } catch(_){}
    return { totalHashes:0, found:0, accepted:0, rejected:0, startTime:null, wallet:null };
}

// ─── Fast address generation (no object alloc per call) ──────────────────────
const _walletBufs = {};
function genAddr(wallet, seed1, seed2) {
    if (!_walletBufs[wallet]) {
        const ab = Buffer.from(wallet.toLowerCase(), "utf8");
        _walletBufs[wallet] = { ab, cb: Buffer.allocUnsafe(ab.length + 16) };
        ab.copy(_walletBufs[wallet].cb, 0);
    }
    const { ab, cb } = _walletBufs[wallet];
    cb.writeBigInt64BE(BigInt(seed1), ab.length);
    cb.writeBigInt64BE(BigInt(seed2), ab.length + 8);
    const hash = crypto.createHash("sha256").update(cb).digest();
    let pk = BigInt("0x" + hash.toString("hex")) % N;
    if (pk === 0n) pk = 1n;
    const privBuf = Buffer.from(pk.toString(16).padStart(64,"0"), "hex");
    return fastPubkey(privBuf).toLowerCase();
}

async function submit(wallet, seed1, seed2) {
    try {
        const res = await axios.post(CONFIG.apiEndpoint,
            { address: wallet, seed1, seed2 },
            { timeout: 10000, headers: { "Content-Type": "application/json" } }
        );
        const data = res.data, raw = JSON.stringify(data);
        const ok = data && (
            data.code===0 || data.success===true ||
            data.status==="ok" || data.status==="success" ||
            raw==='"ok"' || raw==='"success"' ||
            (data.data?.message?.toLowerCase().includes("success"))
        ) && !(
            data.success===false || data.error!==undefined ||
            data.status==="error" || data.code===1 ||
            raw.toLowerCase().includes("invalid") ||
            raw.toLowerCase().includes("reject") ||
            raw.toLowerCase().includes("duplicate")
        );
        return { ok, raw };
    } catch(e) {
        return { ok: false, raw: e.response ? JSON.stringify(e.response.data) : e.message };
    }
}

// ─── WORKER THREAD: pure hashing loop ────────────────────────────────────────
if (!isMainThread) {
    const { wallet, prefix } = workerData;
    let hashes = 0;
    const REPORT_EVERY = 5000;

    while (true) {
        const seed1 = Date.now() + Math.floor(Math.random() * 1_000_000);
        for (let seed2 = 0; seed2 <= 2_000_000; seed2++) {
            const addr   = genAddr(wallet, seed1, seed2);
            const addr40 = addr.slice(2);
            hashes++;

            if (hashes % REPORT_EVERY === 0) {
                parentPort.postMessage({ type: "hashes", count: REPORT_EVERY });
            }

            if (addr40.slice(0, 10).includes(prefix)) {
                parentPort.postMessage({ type: "found", addr, seed1, seed2 });
                // wait for main thread ack before continuing
                const buf = new Int32Array(new SharedArrayBuffer(4));
                Atomics.wait(buf, 0, 0, 30000); // max 30s wait
            }
        }
    }
}

// ─── MAIN THREAD ─────────────────────────────────────────────────────────────
async function mine(wallet, cpu) {
    const { ethers } = require("ethers");
    if (!ethers.isAddress(wallet)) { log("❌ Invalid wallet: " + wallet, "red"); process.exit(1); }

    // Number of threads: 2 on GitHub Actions (2 vCPU), more on beefier machines
    const NUM_THREADS = Math.max(1, require("os").cpus().length);

    const stats = load();
    stats.startTime = Date.now();
    stats.wallet = wallet;
    save(stats);

    console.log("\n" + C.cyan +
        "╔══════════════════════════════════════════════════════════╗\n" +
        "║      ⛏️  AIBTC MINER v5.0 - MULTI-THREAD FAST ⛏️        ║\n" +
        "╚══════════════════════════════════════════════════════════╝"
    + C.reset + "\n");
    log("🔷 Wallet  : " + wallet, "blue");
    log("🔷 Threads : " + NUM_THREADS + " (one per CPU core)", "blue");
    log("🔷 Prefix  : [" + CONFIG.prefix + "]", "blue");
    console.log("");

    let totalHashes = 0, found = 0, accepted = 0, rejected = 0;
    const startTime = Date.now();

    // Spawn worker threads
    const workers = [];
    for (let i = 0; i < NUM_THREADS; i++) {
        const w = new Worker(__filename, {
            workerData: { wallet, prefix: CONFIG.prefix }
        });

        w.on("message", async (msg) => {
            if (msg.type === "hashes") {
                totalHashes += msg.count;
                const secs = (Date.now() - startTime) / 1000;
                const hps = Math.floor(totalHashes / secs);
                const hpsStr = hps > 1000000
                    ? (hps/1000000).toFixed(2) + " MH/s"
                    : hps > 1000
                    ? (hps/1000).toFixed(1) + " KH/s"
                    : hps + " H/s";
                process.stdout.write(
                    "\r" + C.cyan +
                    "⛏️  " + totalHashes.toLocaleString() +
                    " | " + hpsStr +
                    " | Threads: " + NUM_THREADS +
                    " | Found: " + found +
                    " | " + C.green + "✓" + accepted + C.cyan +
                    " | " + C.red + "✗" + rejected + C.cyan +
                    C.reset + "   "
                );
            } else if (msg.type === "found") {
                found++;
                console.log("");
                log("🎯 MATCH FOUND for " + wallet.slice(0,10) + "...", "green");
                log("   Addr  : " + msg.addr, "yellow");
                log("   Seed1 : " + msg.seed1, "yellow");
                log("   Seed2 : " + msg.seed2, "yellow");

                const r = await submit(wallet, msg.seed1, msg.seed2);
                log("📨 " + r.raw, r.ok ? "green" : "red");
                if (r.ok) { accepted++; log("✅ ACCEPTED! (" + accepted + ")", "green"); }
                else       { rejected++; log("❌ REJECTED (" + rejected + ")", "red"); }

                const s = load();
                s.totalHashes = (s.totalHashes||0) + totalHashes;
                s.found = (s.found||0) + found;
                s.accepted = (s.accepted||0) + accepted;
                s.rejected = (s.rejected||0) + rejected;
                save(s);
            }
        });

        w.on("error", e => log("Worker error: " + e.message, "red"));
        workers.push(w);
    }

    log("✅ " + NUM_THREADS + " threads mining... Ctrl+C to stop", "green");
    console.log("");

    process.on("SIGINT",  () => { workers.forEach(w=>w.terminate()); process.exit(0); });
    process.on("SIGTERM", () => { workers.forEach(w=>w.terminate()); process.exit(0); });

    // Keep main thread alive
    await new Promise(() => {});
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];

if (cmd === "run-single") {
    const walletsStr  = process.argv[3] || "";
    const walletIndex = parseInt(process.argv[4], 10) || 0;
    const cpuArg      = parseInt(process.argv[5], 10);
    const cpu         = (!isNaN(cpuArg) && cpuArg>=1 && cpuArg<=100) ? cpuArg : 100;
    const wallets     = walletsStr.split(",").map(w=>w.trim()).filter(Boolean);
    const wallet      = wallets[walletIndex];
    if (!wallet) { log("❌ Wallet index " + walletIndex + " not found!", "red"); process.exit(1); }
    log("🎯 Mining for wallet [" + walletIndex + "]: " + wallet, "cyan");
    mine(wallet, cpu);
} else if (cmd === "run") {
    const wallet = process.argv[3];
    const cpuArg = parseInt(process.argv[4], 10);
    const cpu    = (!isNaN(cpuArg) && cpuArg>=1 && cpuArg<=100) ? cpuArg : 100;
    if (!wallet) { console.log("Usage: node aibtc.js run <WALLET> [cpu%]"); process.exit(1); }
    mine(wallet, cpu);
} else {
    console.log("Usage:");
    console.log("  node aibtc.js run-single <WALLETS_CSV> <INDEX> [cpu%]");
    console.log("  node aibtc.js run <WALLET> [cpu%]");
    process.exit(0);
}
