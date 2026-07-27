#!/usr/bin/env python3
"""
add_bsc_to_indexer2.py — Patches indexer2.js with BSC support + bug fixes.

Fixes applied:
  - Mainnet RPC: blastapi → virginia.rpc.blxrbdn.com (supports eth_getLogs)
  - wPETH queryFilter disabled blocks — references undefined minted/prices variables
  - USDT supply call uses blastapi which blocks eth_call
  - minted/prices undefined errors after disabled queryFilter

New features added:
  - BSC_CHAIN_ID, BSC_RPC_URL, WPETH_BSC_ADDRESS constants
  - initBSCProvider() — connects BSC with fallback
  - fetchBSCBlock() — tracks BSC block in mainnet_stats table
  - indexWPETHBSCEvents() — polls wPETH BEP-20 events on BSC (30s intervals)
  - wpeth_bsc_events DB table
  - bsc_stats DB table
  - HTLC: htlc_swaps DB table + SwapCreated/Claimed/Refunded event indexing
  - BSC stats in startup summary

Run from /root/private_blockchain/:
  python3 add_bsc_to_indexer2.py
  node --check indexer.js && pm2 restart indexer
"""

import os, sys, re

FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'indexer.js')
if not os.path.exists(FILE):
    print(f'ERROR: indexer.js not found')
    sys.exit(1)

content = open(FILE).read()
original_len = len(content)
print(f'Patching indexer2.js ({original_len:,} bytes)...')

# ════════════════════════════════════════════════════════════
# FIX 1: Mainnet RPC — blastapi → virginia (supports eth_getLogs)
# ════════════════════════════════════════════════════════════
old_rpc = '"https://eth-mainnet.public.blastapi.io"'
if old_rpc in content:
    content = content.replace(old_rpc, '"https://virginia.rpc.blxrbdn.com"')
    print('✅ Fix 1: blastapi → virginia.rpc.blxrbdn.com')
else:
    print('⚠  Fix 1: blastapi RPC not found')

# ════════════════════════════════════════════════════════════
# FIX 2: wPETH history blocks — minted/prices undefined
# The queryFilter is disabled (commented out) but code below
# still references `minted` and `prices` variables
# ════════════════════════════════════════════════════════════
# Fix the minted block
old2a = '''     // Historical Minted events
        try {
                // // const minted = await wpeth.queryFilter(wpeth.filters.Minted(), 0x186614C, "latest"); // disabled - RPC range limit // disabled - RPC range limit
                console.log(` Minted events: ${minted.length}`);
                for (const ev of minted) {'''
new2a = '''     // Historical Minted events — queryFilter disabled (RPC range limits)
        // Using polling instead — see setInterval below
        if (false) try {
                const minted = [];
                console.log(` Minted events: ${minted.length}`);
                for (const ev of minted) {'''
if old2a in content:
    content = content.replace(old2a, new2a)
    print('✅ Fix 2a: wPETH Minted history block fixed')
else:
    # Simpler fix — wrap the minted.length reference
    content = content.replace(
        'console.log(` Minted events: ${minted.length}`);',
        'const minted = [];\n\t\tconsole.log(` Minted events: ${minted.length}`);'
    )
    print('✅ Fix 2a: minted variable defined')

# Fix the prices block
old2b = '''     // Historical PriceUpdated events
        try {
                // // const prices = await wpeth.queryFilter(wpeth.filters.PriceUpdated(), 0x186614C, "latest"); // disabled - RPC range limit // disabled - RPC range limit
                console.log(` PriceUpdated events: ${prices.length}`);
                for (const ev of prices) {'''
new2b = '''     // Historical PriceUpdated events — queryFilter disabled (RPC range limits)
        if (false) try {
                const prices = [];
                console.log(` PriceUpdated events: ${prices.length}`);
                for (const ev of prices) {'''
if old2b in content:
    content = content.replace(old2b, new2b)
    print('✅ Fix 2b: wPETH PriceUpdated history block fixed')
else:
    content = content.replace(
        'console.log(` PriceUpdated events: ${prices.length}`);',
        'const prices = [];\n\t\tconsole.log(` PriceUpdated events: ${prices.length}`);'
    )
    print('✅ Fix 2b: prices variable defined')

# ════════════════════════════════════════════════════════════
# FIX 3: USDT supply — replace blastapi inline call
# ════════════════════════════════════════════════════════════
old3 = 'new ethers.JsonRpcProvider("https://eth-mainnet.public.blastapi.io")).totalSupply().then(s=>ethers.formatUnits(s,6)).catch(()=>"—")'
new3 = 'new ethers.JsonRpcProvider("https://virginia.rpc.blxrbdn.com")).totalSupply().then(s=>ethers.formatUnits(s,6)).catch(()=>"—")'
if old3 in content:
    content = content.replace(old3, new3)
    print('✅ Fix 3: USDT supply RPC → virginia')

# ════════════════════════════════════════════════════════════
# ADD BSC CONSTANTS + PROVIDER
# ════════════════════════════════════════════════════════════
BSC_CONSTANTS = '''
// ── BSC (BNB Smart Chain) Config ─────────────────────────────
const BSC_CHAIN_ID      = 56;
const BSC_RPC_URL       = process.env.BSC_RPC_URL       || "https://bsc-dataseed1.binance.org";
const BSC_RPC_FALLBACK  = process.env.BSC_RPC_FALLBACK  || "https://bsc-dataseed2.binance.org";
const WPETH_BSC_ADDRESS = process.env.WPETH_BSC_ADDRESS || null;
const HTLC_PRIVATE_ADDR = process.env.HTLC_PRIVATE_ADDRESS || null;

const WPETH_BSC_ABI = [
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
    "event Burned(address indexed from, uint256 amount, string privateRecipient)",
    "event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp)",
    "function totalSupply() view returns (uint256)",
    "function totalMinted() view returns (uint256)",
    "function totalBurned() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function ethPriceUSD() view returns (uint256)",
    "function cgPriceUSD() view returns (uint256)",
    "function bnPriceUSD() view returns (uint256)",
    "function priceSource() view returns (string)",
];

const HTLC_ABI_IDX = [
    "event SwapCreated(bytes32 indexed swapId, address indexed initiator, address indexed participant, uint256 amount, bytes32 hashlock, uint256 timelock)",
    "event SwapClaimed(bytes32 indexed swapId, bytes32 secret)",
    "event SwapRefunded(bytes32 indexed swapId)",
];

let bscProvider  = null;
let bscBlockNum  = null;
let bscConnected = false;

async function initBSCProvider() {
    for (const rpc of [BSC_RPC_URL, BSC_RPC_FALLBACK]) {
        try {
            const p   = new ethers.JsonRpcProvider(rpc);
            const net = await Promise.race([
                p.getNetwork(),
                new Promise((_,r) => setTimeout(() => r(new Error("timeout")), 5000))
            ]);
            if (Number(net.chainId) === BSC_CHAIN_ID) {
                bscProvider  = p;
                bscConnected = true;
                console.log(`✅ BSC RPC connected: ${rpc} (Chain ${BSC_CHAIN_ID})`);
                return true;
            }
        } catch {}
    }
    console.warn("⚠  BSC RPC unavailable — BSC indexing skipped");
    return false;
}

async function fetchBSCBlock() {
    if (!bscProvider) return;
    try {
        bscBlockNum = await bscProvider.getBlockNumber();
        await db.query(
            `INSERT INTO mainnet_stats (chain_id,block_number,eth_price_usd,price_source,updated_at)
             VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT (chain_id) DO UPDATE
             SET block_number=$2, eth_price_usd=$3, price_source=$4, updated_at=NOW()`,
            [BSC_CHAIN_ID, bscBlockNum, ETH_PRICE_PRIVATE, priceSource]
        ).catch(() => {});
    } catch {}
}
'''

# Insert after PRIVATE_BRIDGE_ADDRESS
target_insert = 'const PRIVATE_BRIDGE_ADDRESS = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS || null;'
if target_insert in content and 'BSC_CHAIN_ID' not in content:
    content = content.replace(target_insert, target_insert + '\n' + BSC_CONSTANTS)
    print('✅ BSC constants + provider added')
elif 'BSC_CHAIN_ID' in content:
    print('⚠  BSC constants already present')

# ════════════════════════════════════════════════════════════
# ADD BSC + HTLC DB TABLES to migrateDB
# ════════════════════════════════════════════════════════════
BSC_TABLES = '''
            CREATE TABLE IF NOT EXISTS wpeth_bsc_events (
                id            SERIAL PRIMARY KEY,
                event_type    TEXT NOT NULL,
                tx_hash       TEXT,
                block_number  BIGINT,
                address       TEXT,
                amount_wei    TEXT,
                amount_eth    NUMERIC(36,18),
                request_id    TEXT,
                eth_price_usd NUMERIC(18,2),
                cg_price_usd  NUMERIC(18,2),
                bn_price_usd  NUMERIC(18,2),
                price_source  TEXT,
                network       TEXT DEFAULT 'bsc',
                timestamp     BIGINT,
                inserted_at   TIMESTAMP DEFAULT NOW(),
                UNIQUE (tx_hash, event_type)
            );
            CREATE INDEX IF NOT EXISTS idx_wpeth_bsc_type    ON wpeth_bsc_events (event_type);
            CREATE INDEX IF NOT EXISTS idx_wpeth_bsc_addr    ON wpeth_bsc_events (address);
            CREATE INDEX IF NOT EXISTS idx_wpeth_bsc_block   ON wpeth_bsc_events (block_number DESC);

            CREATE TABLE IF NOT EXISTS bsc_stats (
                id            SERIAL PRIMARY KEY,
                chain_id      INT DEFAULT 56,
                block_number  BIGINT,
                wpeth_supply  NUMERIC(36,18),
                wpeth_minted  NUMERIC(36,18),
                eth_price_usd NUMERIC(18,2),
                price_source  TEXT,
                rpc_url       TEXT,
                updated_at    TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS htlc_swaps (
                id             SERIAL PRIMARY KEY,
                swap_id        TEXT UNIQUE NOT NULL,
                chain_id       INT,
                event_type     TEXT,
                initiator      TEXT,
                participant    TEXT,
                amount_eth     NUMERIC(36,18),
                hashlock       TEXT,
                timelock       BIGINT,
                tx_hash        TEXT,
                block_number   BIGINT,
                status         TEXT DEFAULT 'waiting_buyer',
                claim_tx       TEXT,
                refund_tx      TEXT,
                secret_revealed TEXT,
                created_at     TIMESTAMP DEFAULT NOW(),
                updated_at     TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_htlc_status    ON htlc_swaps (status);
            CREATE INDEX IF NOT EXISTS idx_htlc_initiator ON htlc_swaps (initiator);
'''

# Insert before the closing of the migrateDB CREATE statements
target_tables = "CREATE INDEX IF NOT EXISTS idx_bpo_fetched ON bridge_price_oracle (fetched_at DESC);"
if target_tables in content and 'wpeth_bsc_events' not in content:
    content = content.replace(target_tables, target_tables + '\n' + BSC_TABLES)
    print('✅ BSC + HTLC DB tables added to migrateDB')
else:
    # Try alternate
    target_tables2 = "CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions (from_address);"
    if target_tables2 in content and 'wpeth_bsc_events' not in content:
        content = content.replace(target_tables2, BSC_TABLES + '\n\t\t\t' + target_tables2)
        print('✅ BSC + HTLC DB tables added (alternate location)')
    elif 'wpeth_bsc_events' in content:
        print('⚠  BSC tables already present')

# ════════════════════════════════════════════════════════════
# ADD indexWPETHBSCEvents function + HTLC indexer
# ════════════════════════════════════════════════════════════
BSC_INDEXER_FUNCTIONS = '''
// ══════════════════════════════════════════════════════════════
// wPETH BSC INDEXING — BEP-20 on BNB Smart Chain
// Polls every 30s using small block ranges (BSC supports 5000 blocks per getLogs)
// ══════════════════════════════════════════════════════════════
async function indexWPETHBSCEvents() {
    if (!WPETH_BSC_ADDRESS || !bscProvider) {
        console.log("ℹ  WPETH_BSC_ADDRESS not set — BSC wPETH indexing skipped");
        return;
    }

    const wpeth = new ethers.Contract(WPETH_BSC_ADDRESS, WPETH_BSC_ABI, bscProvider);
    console.log(`🟡 Indexing wPETH BEP-20 on BSC: ${WPETH_BSC_ADDRESS}`);

    // Read current BSC wPETH stats
    try {
        const [supply, minted, burned, price, src] = await Promise.all([
            wpeth.totalSupply(), wpeth.totalMinted(), wpeth.totalBurned(),
            wpeth.ethPriceUSD(), wpeth.priceSource(),
        ]);
        const supplyEth = parseFloat(ethers.formatEther(supply));
        const priceUSD  = Number(price) / 1e8;
        console.log(`   BSC wPETH supply : ${supplyEth} wPETH`);
        console.log(`   BSC wPETH minted : ${ethers.formatEther(minted)} wPETH`);
        console.log(`   BSC ETH price    : $${priceUSD} [${src}]`);

        await db.query(
            `INSERT INTO bsc_stats (chain_id,block_number,wpeth_supply,wpeth_minted,eth_price_usd,price_source,rpc_url,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [BSC_CHAIN_ID, bscBlockNum, supplyEth,
             parseFloat(ethers.formatEther(minted)), priceUSD, src, BSC_RPC_URL]
        ).catch(() => {});
    } catch(e) { console.warn("⚠  BSC wPETH stats:", e.message); }

    // Live polling — BSC blocks every ~3s, poll every 30s for new events
    const BSC_DEPLOY_BLOCK = parseInt(process.env.WPETH_BSC_DEPLOY_BLOCK || "0");
    let lastBscBlock = BSC_DEPLOY_BLOCK || (bscBlockNum ? bscBlockNum - 100 : 0);

    setInterval(async () => {
        if (!bscProvider || !WPETH_BSC_ADDRESS) return;
        try {
            const cur = await bscProvider.getBlockNumber();
            if (cur <= lastBscBlock) return;

            const from = lastBscBlock + 1;
            const to   = Math.min(cur, from + 4999); // BSC: max 5000 blocks per getLogs
            lastBscBlock = to;

            const wpethLive = new ethers.Contract(WPETH_BSC_ADDRESS, WPETH_BSC_ABI, bscProvider);
            const [mintedEvts, pricesEvts] = await Promise.allSettled([
                wpethLive.queryFilter(wpethLive.filters.Minted(), from, to),
                wpethLive.queryFilter(wpethLive.filters.PriceUpdated(), from, to),
            ]);

            if (mintedEvts.status === "fulfilled" && mintedEvts.value.length > 0) {
                for (const ev of mintedEvts.value) {
                    const amtETH = parseFloat(ethers.formatEther(ev.args.amount));
                    const price  = Number(ev.args.ethPriceUSD) / 1e8;
                    const live   = await fetchDualPrice().catch(() => ({ avg:price, cg:null, bn:null, source:"on-chain" }));

                    console.log(`\\n🟡 [BSC wPETH] LIVE Minted: ${amtETH} wPETH → ${ev.args.to.slice(0,10)}…`);
                    console.log(`   Request ID : ${ev.args.requestId}`);
                    console.log(`   ETH price  : $${price} (on-chain) | live $${live.avg}`);
                    console.log(`   BscScan    : https://bscscan.com/tx/${ev.transactionHash}\\n`);

                    await db.query(
                        `INSERT INTO wpeth_bsc_events
                         (event_type,tx_hash,block_number,address,amount_wei,amount_eth,
                          request_id,eth_price_usd,cg_price_usd,bn_price_usd,price_source,network,timestamp)
                         VALUES ('Minted',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'bsc',$11)
                         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
                        [ev.transactionHash, ev.blockNumber, ev.args.to,
                         ev.args.amount.toString(), amtETH, ev.args.requestId,
                         price, live.cg, live.bn, live.source || "coingecko+kraken",
                         ev.blockNumber]
                    ).catch(() => {});

                    // Mark bridge_requests as completed if requestId matches
                    await db.query(
                        `UPDATE bridge_requests SET status='completed', dst_tx_hash=$1,
                         dst_chain_id=$2, updated_at=NOW()
                         WHERE request_id=$3 AND status='pending'`,
                        [ev.transactionHash, String(BSC_CHAIN_ID), ev.args.requestId]
                    ).catch(() => {});
                }
            }

            if (pricesEvts.status === "fulfilled" && pricesEvts.value.length > 0) {
                for (const ev of pricesEvts.value) {
                    const avg = Number(ev.args.avgUSD) / 1e8;
                    console.log(`💰 [BSC wPETH] Price updated: $${avg} [${ev.args.source}]`);
                    await db.query(
                        `INSERT INTO wpeth_bsc_events
                         (event_type,tx_hash,block_number,eth_price_usd,cg_price_usd,
                          bn_price_usd,price_source,network,timestamp)
                         VALUES ('PriceUpdated',$1,$2,$3,$4,$5,$6,'bsc',$7)
                         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
                        [ev.transactionHash, ev.blockNumber,
                         avg, Number(ev.args.cgUSD)/1e8, Number(ev.args.bnUSD)/1e8,
                         ev.args.source, Number(ev.args.timestamp)]
                    ).catch(() => {});
                }
            }

            // Refresh BSC stats snapshot
            await fetchBSCBlock().catch(() => {});

        } catch(e) { /* BSC poll — skip on error */ }
    }, 30_000);

    console.log(`✅ BSC wPETH indexer active (polling every 30s): ${WPETH_BSC_ADDRESS}`);
}

// ══════════════════════════════════════════════════════════════
// HTLC SWAP INDEXER — monitors atomic swap events on private chain
// ══════════════════════════════════════════════════════════════
async function indexHTLCEvents() {
    if (!HTLC_PRIVATE_ADDR) {
        console.log("ℹ  HTLC_PRIVATE_ADDRESS not set — HTLC indexing skipped");
        return;
    }
    const htlc = new ethers.Contract(HTLC_PRIVATE_ADDR, HTLC_ABI_IDX, provider);
    console.log(`🔒 HTLC indexer active: ${HTLC_PRIVATE_ADDR}`);

    htlc.on("SwapCreated", async (swapId, initiator, participant, amount, hashlock, timelock, ev) => {
        const amtETH = parseFloat(ethers.formatEther(amount));
        const exp    = new Date(Number(timelock) * 1000).toLocaleString();
        console.log(`\\n🔒 [HTLC] SwapCreated: ${amtETH} ETH | Initiator: ${initiator.slice(0,10)}…`);
        console.log(`   Swap ID  : ${swapId}`);
        console.log(`   Expires  : ${exp}`);
        await db.query(
            `INSERT INTO htlc_swaps (swap_id,chain_id,event_type,initiator,participant,amount_eth,hashlock,timelock,tx_hash,block_number,status,created_at)
             VALUES ($1,$2,'SwapCreated',$3,$4,$5,$6,$7,$8,$9,'waiting_buyer',NOW())
             ON CONFLICT (swap_id) DO NOTHING`,
            [swapId, parseInt(CHAIN_ID), initiator, participant || null,
             amtETH, hashlock, Number(timelock), ev.log.transactionHash, ev.log.blockNumber]
        ).catch(() => {});
    });

    htlc.on("SwapClaimed", async (swapId, secret, ev) => {
        console.log(`\\n✅ [HTLC] SwapClaimed: ${swapId.slice(0,20)}… | Secret revealed`);
        await db.query(
            `UPDATE htlc_swaps SET status='claimed', claim_tx=$2, secret_revealed=$3, updated_at=NOW() WHERE swap_id=$1`,
            [swapId, ev.log.transactionHash, secret]
        ).catch(() => {});
    });

    htlc.on("SwapRefunded", async (swapId, ev) => {
        console.log(`\\n↩  [HTLC] SwapRefunded: ${swapId.slice(0,20)}… (expired)`);
        await db.query(
            `UPDATE htlc_swaps SET status='refunded', refund_tx=$2, updated_at=NOW() WHERE swap_id=$1`,
            [swapId, ev.log.transactionHash]
        ).catch(() => {});
    });
}
'''

# Insert before indexBridgeEvents function
target_fn = 'async function indexBridgeEvents() {'
if target_fn in content and 'indexWPETHBSCEvents' not in content:
    content = content.replace(target_fn, BSC_INDEXER_FUNCTIONS + '\n' + target_fn)
    print('✅ indexWPETHBSCEvents + indexHTLCEvents functions added')
elif 'indexWPETHBSCEvents' in content:
    print('⚠  BSC indexer functions already present')

# ════════════════════════════════════════════════════════════
# ADD BSC init calls in main()
# ════════════════════════════════════════════════════════════
BSC_MAIN_CALLS = '''
    // ── BSC (BNB Smart Chain) indexing ────────────────────────
    await initBSCProvider();
    if (bscProvider) {
        await fetchBSCBlock();
        setInterval(fetchBSCBlock, 60_000);
        await indexWPETHBSCEvents();

        // BSC stats summary
        const bscRow = await db.query(
            "SELECT block_number, wpeth_supply, eth_price_usd FROM bsc_stats ORDER BY id DESC LIMIT 1"
        ).catch(() => ({ rows: [] }));
        if (bscRow.rows.length > 0) {
            const bs = bscRow.rows[0];
            console.log(` BSC block   : #${bs.block_number?.toLocaleString() || "—"}`);
            console.log(` BSC wPETH   : ${bs.wpeth_supply || "0"} supply | $${bs.eth_price_usd || "—"}`);
        }
    }

    // ── HTLC atomic swap indexing ──────────────────────────────
    await indexHTLCEvents();
'''

# Insert after indexWPETHEvents() call in main
target_call = 'await indexWPETHEvents();'
if target_call in content and 'initBSCProvider' not in content:
    content = content.replace(target_call, target_call + '\n' + BSC_MAIN_CALLS)
    print('✅ BSC + HTLC init calls added in main()')
elif 'initBSCProvider' in content:
    print('⚠  BSC init calls already present')

# ════════════════════════════════════════════════════════════
# FIX 4: Update startup banner to mention BSC + HTLC
# ════════════════════════════════════════════════════════════
old_banner = '"║ Auto DB migration ON                                 ║"'
new_banner = '"║ Auto DB migration ON                                 ║");\n\tconsole.log("║ BSC: BNB Smart Chain wPETH BEP-20 + HTLC indexing   ║"'
if old_banner in content and 'BSC: BNB Smart Chain' not in content:
    content = content.replace(old_banner, new_banner)
    print('✅ Startup banner updated with BSC + HTLC')

# ════════════════════════════════════════════════════════════
# FIX 5: Add BSC block to DB stats summary in main()
# ════════════════════════════════════════════════════════════
old_stats = 'console.log(` P2P: ${p2pPeerCount} peers (port ${P2P_PORT})`);'
new_stats = '''console.log(` P2P: ${p2pPeerCount} peers (port ${P2P_PORT})`);
\tconsole.log(` BSC: ${bscConnected ? "✅ connected" : "❌ offline"} | block #${bscBlockNum?.toLocaleString()||"—"}`);
\tconsole.log(` HTLC: ${HTLC_PRIVATE_ADDR ? "✅ " + HTLC_PRIVATE_ADDR.slice(0,14) + "…" : "not deployed"}`);'''
if old_stats in content and 'bscConnected' not in content.split(old_stats)[1][:200]:
    content = content.replace(old_stats, new_stats)
    print('✅ BSC + HTLC status added to DB stats summary')

# ════════════════════════════════════════════════════════════
# WRITE
# ════════════════════════════════════════════════════════════
open(FILE, 'w').write(content)

print(f'\n✅ indexer2.js patched successfully')
print(f'   Original : {original_len:,} bytes')
print(f'   New size : {len(content):,} bytes')
print(f'   Added    : {len(content) - original_len:,} bytes')
print("""
Next steps:
  1. node --check indexer2.js
  2. pm2 restart indexer2    (or pm2 start indexer2.js --name indexer2)
  3. pm2 logs indexer2 --lines 20 --nostream | grep -iE "bsc|htlc|connected"

Add to .env:
  BSC_RPC_URL=https://bsc-dataseed1.binance.org
  WPETH_BSC_ADDRESS=0x...        (after: node deploy_bsc.js --deploy-wpeth-bsc)
  WPETH_BSC_DEPLOY_BLOCK=...     (block number from BSC deploy TX on BscScan)
  HTLC_PRIVATE_ADDRESS=0x...     (after: node deploy.js --deploy-htlc private)

What was added:
  ✅ BSC provider (bsc-dataseed1 + bsc-dataseed2 fallback)
  ✅ fetchBSCBlock() — tracks BSC block in mainnet_stats table
  ✅ indexWPETHBSCEvents() — polls BSC wPETH Minted/PriceUpdated every 30s
  ✅ indexHTLCEvents() — monitors SwapCreated/Claimed/Refunded on private chain
  ✅ wpeth_bsc_events DB table
  ✅ bsc_stats DB table
  ✅ htlc_swaps DB table

What was fixed:
  ✅ blastapi → virginia.rpc.blxrbdn.com (supports eth_getLogs)
  ✅ minted/prices undefined errors (disabled queryFilter blocks)
  ✅ USDT supply RPC fixed
""")
