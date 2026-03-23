use sha2::{Sha256, Digest};
use secp256k1::{Secp256k1, SecretKey};
use tiny_keccak::{Hasher, Keccak};
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use crossbeam_channel::bounded;

const PREFIX: &str = "a1b7c";
const API_ENDPOINT: &str = "http://52.44.108.84:8084/new/record";
const N: &str = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn gen_addr(wallet: &str, seed1: u64, seed2: u32) -> String {
    let mut input = Vec::with_capacity(wallet.len() + 16);
    input.extend_from_slice(wallet.to_lowercase().as_bytes());
    input.extend_from_slice(&seed1.to_be_bytes());
    input.extend_from_slice(&(seed2 as u64).to_be_bytes());

    let hash = Sha256::digest(&input);
    let n = num_bigint::BigUint::parse_bytes(N.as_bytes(), 16).unwrap();
    let pk_int = num_bigint::BigUint::from_bytes_be(&hash) % &n;
    let pk_bytes = {
        let b = pk_int.to_bytes_be();
        let mut arr = [0u8; 32];
        arr[32 - b.len()..].copy_from_slice(&b);
        arr
    };

    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(&pk_bytes).unwrap();
    let pub_key = sk.public_key(&secp).serialize_uncompressed();
    
    let mut keccak = Keccak::v256();
    let mut output = [0u8; 32];
    keccak.update(&pub_key[1..]);
    keccak.finalize(&mut output);
    
    format!("0x{}", hex::encode(&output[12..]))
}

async fn submit(wallet: &str, seed1: u64, seed2: u32) -> bool {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "address": wallet,
        "seed1": seed1,
        "seed2": seed2
    });
    match client.post(API_ENDPOINT)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send().await {
        Ok(res) => {
            if let Ok(data) = res.json::<serde_json::Value>().await {
                let raw = data.to_string();
                return data["code"] == 0 || data["success"] == true ||
                       data["status"] == "ok" || raw.contains("Success");
            }
            false
        }
        Err(_) => false
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: aibtc-rust <WALLETS_CSV> <INDEX>");
        std::process::exit(1);
    }

    let wallets: Vec<&str> = args[1].split(',').collect();
    let idx: usize = args[2].parse().unwrap_or(0);
    let wallet = wallets.get(idx).expect("Wallet index not found");

    println!("⚡ AIBTC Rust Miner");
    println!("🔷 Wallet [{}]: {}", idx, wallet);
    println!("🔷 Threads: {}", num_cpus::get());
    println!("🔷 Prefix : [{}]", PREFIX);
    println!("✅ Mining started...\n");

    let total_hashes = Arc::new(AtomicU64::new(0));
    let found        = Arc::new(AtomicU64::new(0));
    let accepted     = Arc::new(AtomicU64::new(0));

    let (tx, rx) = bounded::<(u64, u32)>(100);
    let num_threads = num_cpus::get();
    let wallet_str = wallet.to_string();

    // Spawn mining threads
    for _ in 0..num_threads {
        let tx = tx.clone();
        let total = Arc::clone(&total_hashes);
        let w = wallet_str.clone();
        std::thread::spawn(move || {
            let mut rng = rand::thread_rng();
            loop {
                let seed1 = now_ms() + rand::Rng::gen_range(&mut rng, 0..1_000_000u64);
                for seed2 in 0u32..2_000_000 {
                    let addr = gen_addr(&w, seed1, seed2);
                    total.fetch_add(1, Ordering::Relaxed);
                    if addr[2..12].contains(PREFIX) {
                        let _ = tx.send((seed1, seed2));
                    }
                }
            }
        });
    }

    // Stats printer
    let total_clone = Arc::clone(&total_hashes);
    let found_clone  = Arc::clone(&found);
    let acc_clone    = Arc::clone(&accepted);
    let start = now_ms();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            let h = total_clone.load(Ordering::Relaxed);
            let secs = (now_ms() - start) as f64 / 1000.0;
            let hps = h as f64 / secs;
            let hps_str = if hps >= 1_000_000.0 {
                format!("{:.2} MH/s", hps / 1_000_000.0)
            } else {
                format!("{:.1} KH/s", hps / 1000.0)
            };
            print!("\r⛏️  {} | {} | Found:{} | ✓{}   ",
                h, hps_str,
                found_clone.load(Ordering::Relaxed),
                acc_clone.load(Ordering::Relaxed)
            );
        }
    });

    // Submit loop
    while let Ok((seed1, seed2)) = rx.recv() {
        found.fetch_add(1, Ordering::Relaxed);
        println!("\n🎯 MATCH! seed1:{} seed2:{}", seed1, seed2);
        let ok = submit(&wallet_str, seed1, seed2).await;
        if ok {
            accepted.fetch_add(1, Ordering::Relaxed);
            println!("✅ ACCEPTED! ({})", accepted.load(Ordering::Relaxed));
        } else {
            println!("❌ REJECTED");
        }
    }
}
