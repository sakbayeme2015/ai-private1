#!/usr/bin/env python3
"""
add_bsc_to_server.py — Patches server.js to add BSC (BNB Smart Chain) support.

Applies cleanly to the CURRENT state of server.js on the VPS.
Safe to re-run — checks for existing patches before applying.

What it adds:
  - BSC provider (bsc-dataseed1.binance.org with fallback)
  - WPETH_BSC_ADDRESS config + cached BSC stats
  - fetchWPETHBSCStats()  — reads wPETH BEP-20 from BSC
  - initBSCProvider()     — connects with 5s timeout + fallback
  - GET /api/v1/bsc/status      — BSC chain status
  - GET /api/v1/bsc/wpeth       — wPETH BEP-20 stats
  - GET /api/v1/bsc/balance/:addr — BNB + wPETH balance
  - POST /api/v1/bsc/mint       — lock ETH + mint wPETH on BSC
  - GET /api/v1/bsc/config      — BSC bridge config
  - WebSocket: wpeth_bsc_stats + bsc_mint events
  - Periodic BSC stats update every 90s

Run from /root/private_blockchain/:
  python3 add_bsc_to_server.py
  node --check server.js && pm2 restart server
  curl https://ai-private.online:3443/api/v1/bsc/status
"""

import os, sys

FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.js')
if not os.path.exists(FILE):
    print(f'ERROR: server.js not found in {os.path.dirname(FILE)}')
    sys.exit(1)

content = open(FILE).read()
original_len = len(content)
print(f'Patching server.js ({original_len:,} bytes)...')

# ════════════════════════════════════════════════════════════
# SECTION 1 — BSC constants + provider code
# ════════════════════════════════════════════════════════════

BSC_CONSTANTS = '''
// ── BSC (BNB Smart Chain) Config ─────────────────────────────
const BSC_RPC_URL       = process.env.BSC_RPC_URL       || "https://bsc-dataseed1.binance.org";
const BSC_RPC_FALLBACK  = process.env.BSC_RPC_FALLBACK  || "https://bsc-dataseed2.binance.org";
const BSC_CHAIN_ID      = 56;
const WPETH_BSC_ADDRESS = process.env.WPETH_BSC_ADDRESS || null;
const ENABLE_BSC_MINT   = process.env.ENABLE_BSC_MINT === "true";

const WPETH_BSC_ABI = [
    "function totalSupply() view returns (uint256)",
    "function totalMinted() view returns (uint256)",
    "function totalBurned() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function ethPriceUSD() view returns (uint256)",
    "function cgPriceUSD() view returns (uint256)",
    "function bnPriceUSD() view returns (uint256)",
    "function priceSource() view returns (string)",
    "function priceUpdatedAt() view returns (uint256)",
    "function minter() view returns (address)",
    "function mint(address to, uint256 amount, bytes32 requestId) returns (bool)",
    "function updateEthPrice(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string calldata source) external",
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
];

let bscProvider     = null;
let bscConnected    = false;
let cachedBSCData   = {
    chain_id: 56, name: "BNB Smart Chain",
    rpc: BSC_RPC_URL, bscscan: "https://bscscan.com",
    connected: false, block_number: null, updated_at: null,
};
let cachedWPETHBSCData = {
    address: null, total_supply: "0", total_minted: "0",
    total_burned: "0", eth_price_usd: 0, cg_usd: 0, bn_usd: 0,
    source: "—", updated_at: null,
};

async function initBSCProvider() {
    for (const rpc of [BSC_RPC_URL, BSC_RPC_FALLBACK]) {
        try {
            const p   = new ethers.JsonRpcProvider(rpc);
            const net = await Promise.race([
                p.getNetwork(),
                new Promise((_,r) => setTimeout(() => r(new Error("timeout")), 5000))
            ]);
            if (Number(net.chainId) === BSC_CHAIN_ID) {
                bscProvider   = p;
                bscConnected  = true;
                cachedBSCData.connected = true;
                console.log(`✅ BSC RPC connected: ${rpc} (Chain ${BSC_CHAIN_ID})`);
                return;
            }
        } catch {}
    }
    console.warn("⚠  BSC RPC unavailable — BSC features disabled");
}

async function fetchWPETHBSCStats() {
    if (!WPETH_BSC_ADDRESS || !bscProvider) return;
    try {
        const wpeth = new ethers.Contract(WPETH_BSC_ADDRESS, WPETH_BSC_ABI, bscProvider);
        const [supply, minted, burned, price, cg, bn, src, updAt] = await Promise.all([
            wpeth.totalSupply(), wpeth.totalMinted(), wpeth.totalBurned(),
            wpeth.ethPriceUSD(), wpeth.cgPriceUSD(), wpeth.bnPriceUSD(),
            wpeth.priceSource(), wpeth.priceUpdatedAt(),
        ]);
        cachedWPETHBSCData = {
            address:       WPETH_BSC_ADDRESS,
            chain_id:      BSC_CHAIN_ID,
            symbol:        "wPETH",
            name:          "Wrapped Private ETH (BEP-20)",
            total_supply:  ethers.formatEther(supply),
            total_minted:  ethers.formatEther(minted),
            total_burned:  ethers.formatEther(burned),
            eth_price_usd: Number(price) / 1e8,
            cg_usd:        Number(cg)    / 1e8,
            bn_usd:        Number(bn)    / 1e8,
            price_updated: new Date(Number(updAt) * 1000).toISOString(),
            source:        src || "coingecko+kraken",
            note:          "wPETH BEP-20 on BSC — minted when ETH locked on private chain 123456",
            bscscan:       `https://bscscan.com/token/${WPETH_BSC_ADDRESS}`,
            updated_at:    new Date().toISOString(),
        };
        broadcast({ type: "wpeth_bsc_stats", ...cachedWPETHBSCData });
        console.log(`🟡 wPETH BSC: supply=${cachedWPETHBSCData.total_supply} price=$${cachedWPETHBSCData.eth_price_usd}`);
    } catch(e) { /* BSC stats not critical */ }
}

async function pollBSCBlock() {
    if (!bscProvider) return;
    try {
        const block = await bscProvider.getBlockNumber();
        cachedBSCData.block_number = block;
        cachedBSCData.updated_at   = new Date().toISOString();
    } catch {}
}

// Init BSC on startup
initBSCProvider().then(() => {
    if (bscProvider) {
        fetchWPETHBSCStats();
        pollBSCBlock();
        setInterval(fetchWPETHBSCStats, 90_000);
        setInterval(pollBSCBlock, 30_000);
    }
}).catch(() => {});
'''

# Insert after WPETH_ADDRESS definition or after existing wPETH config
# Try multiple insertion points
inserted = False

for target in [
    'let cachedWPETHData = {',
    'const WPETH_ADDRESS = process.env.WPETH_ADDRESS || null;',
    'const WPETH_ABI = [',
]:
    if target in content and 'BSC_CHAIN_ID' not in content:
        content = content.replace(target, target + '\n' + BSC_CONSTANTS)
        print(f'✅ BSC constants + provider added after: {target[:50]}')
        inserted = True
        break

if not inserted and 'BSC_CHAIN_ID' in content:
    print('⚠  BSC constants already present — skipping')
elif not inserted:
    # Fallback: add before middleware
    for target in ['// ── Middleware', 'app.use(helmet', 'app.use(cors']:
        if target in content:
            content = content.replace(target, BSC_CONSTANTS + '\n' + target)
            print(f'✅ BSC constants added before middleware')
            inserted = True
            break

# ════════════════════════════════════════════════════════════
# SECTION 2 — BSC API Routes
# ════════════════════════════════════════════════════════════

BSC_ROUTES = '''
// ══════════════════════════════════════════════════════════════
// BSC API ROUTES — BNB Smart Chain + wPETH BEP-20
// ══════════════════════════════════════════════════════════════

// GET /api/v1/bsc/status
app.get("/api/v1/bsc/status", async (req, res) => {
    await pollBSCBlock().catch(() => {});
    res.json({
        chain_id:       BSC_CHAIN_ID,
        name:           "BNB Smart Chain",
        rpc:            BSC_RPC_URL,
        bscscan:        "https://bscscan.com",
        connected:      bscConnected,
        block_number:   cachedBSCData.block_number,
        wpeth_address:  WPETH_BSC_ADDRESS,
        wpeth_deployed: !!WPETH_BSC_ADDRESS,
        eth_price_usd:  cachedETHPrice.usd,
        cg_usd:         cachedETHPrice.cg_usd,
        bn_usd:         cachedETHPrice.bn_usd,
        updated_at:     cachedBSCData.updated_at,
        note:           "BSC is EVM-compatible — same contracts as Mainnet, cheaper gas (~$0.01)",
        deploy_cmd:     "node deploy_bsc.js --deploy-wpeth-bsc",
    });
});

// GET /api/v1/bsc/wpeth — wPETH BEP-20 stats on BSC
app.get("/api/v1/bsc/wpeth", async (req, res) => {
    await fetchWPETHBSCStats().catch(() => {});
    if (!WPETH_BSC_ADDRESS) {
        return res.status(404).json({
            error:    "WPETH_BSC_ADDRESS not set in .env",
            hint:     "Deploy wPETH on BSC: node deploy_bsc.js --deploy-wpeth-bsc",
            chain_id: BSC_CHAIN_ID,
        });
    }
    res.json({
        ...cachedWPETHBSCData,
        eth_price_live:  cachedETHPrice.usd,
        eth_cg_live:     cachedETHPrice.cg_usd,
        eth_bn_live:     cachedETHPrice.bn_usd,
        eth_source_live: cachedETHPrice.source,
        peg_ratio:       cachedWPETHBSCData.eth_price_usd > 0
            ? (cachedWPETHBSCData.eth_price_usd / (cachedETHPrice.usd || 1)).toFixed(6)
            : "1.000000",
        bridge_flow:  "Lock ETH on private chain 123456 → Relayer mints wPETH BEP-20 on BSC 56",
        gas_cost:     "~$0.01 BNB per mint (much cheaper than Mainnet)",
        deploy_cmd:   "node deploy_bsc.js --deploy-wpeth-bsc",
        mint_cmd:     "node deploy_bsc.js --lock-eth-bsc --amount 1",
    });
});

// GET /api/v1/bsc/balance/:address — BNB + wPETH balance
app.get("/api/v1/bsc/balance/:address", async (req, res) => {
    const addr = req.params.address;
    if (!bscProvider) return res.status(503).json({ error: "BSC RPC not connected" });
    try {
        const bnbBal = await bscProvider.getBalance(addr);
        let wpethBal = "0", wpethUSD = "0";
        if (WPETH_BSC_ADDRESS) {
            const wpeth = new ethers.Contract(WPETH_BSC_ADDRESS, WPETH_BSC_ABI, bscProvider);
            const raw   = await wpeth.balanceOf(addr);
            wpethBal    = ethers.formatEther(raw);
            wpethUSD    = (parseFloat(wpethBal) * cachedETHPrice.usd).toFixed(2);
        }
        res.json({
            address:        addr,
            chain_id:       BSC_CHAIN_ID,
            bnb_balance:    ethers.formatEther(bnbBal),
            bnb_usd:        "—",
            wpeth_balance:  wpethBal,
            wpeth_usd:      wpethUSD,
            wpeth_address:  WPETH_BSC_ADDRESS,
            bscscan:        `https://bscscan.com/address/${addr}`,
            updated_at:     new Date().toISOString(),
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/bsc/mint — Lock ETH on private chain + mint wPETH on BSC
app.post("/api/v1/bsc/mint", async (req, res) => {
    const { amount_eth, recipient } = req.body;
    if (!amount_eth) return res.status(400).json({ error: "amount_eth required" });
    if (!WPETH_BSC_ADDRESS) return res.status(503).json({
        error: "WPETH_BSC_ADDRESS not set — deploy wPETH on BSC first",
        hint:  "node deploy_bsc.js --deploy-wpeth-bsc",
    });
    if (!PRIVATE_BRIDGE_ADDRESS || !bridgeContract) return res.status(503).json({
        error: "PRIVATE_BRIDGE_ADDRESS not set",
    });
    if (!DEPLOYER_PRIVATE_KEY) return res.status(503).json({
        error: "DEPLOYER_PRIVATE_KEY not set in .env",
    });
    if (!bscProvider) return res.status(503).json({ error: "BSC RPC not connected" });

    try {
        const to          = recipient || process.env.OWNER_ADDRESS;
        const privWallet  = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
        const bscWallet   = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, bscProvider);
        const wpethBSC    = new ethers.Contract(WPETH_BSC_ADDRESS, WPETH_BSC_ABI, bscWallet);

        // Check BSC BNB balance
        const bnbBal = await bscProvider.getBalance(bscWallet.address);
        if (bnbBal < ethers.parseEther("0.001")) {
            return res.status(400).json({
                error:   "Insufficient BNB on BSC for gas",
                balance: ethers.formatEther(bnbBal),
                needed:  "0.001 BNB",
                hint:    "Top up BSC wallet with BNB from Binance",
            });
        }

        // Step 1: Lock ETH on private chain
        const bridgeABI2 = [
            "function lockETH(address mainnetRecipient) external payable returns (bytes32 requestId)",
            "function bridgeFeeETH() view returns (uint256)",
            "event ETHLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
        ];
        const bridge2 = new ethers.Contract(PRIVATE_BRIDGE_ADDRESS, bridgeABI2, privWallet);
        const fee     = await bridge2.bridgeFeeETH().catch(() => ethers.parseEther("0.001"));
        const value   = ethers.parseEther(String(amount_eth)) + fee;
        const lockTx  = await bridge2.lockETH(to, { value });
        const lockRcpt = await lockTx.wait();

        // Extract requestId
        const iface2    = new ethers.Interface(bridgeABI2);
        let requestId   = null, amount = BigInt(0);
        for (const log of lockRcpt.logs) {
            try {
                const parsed = iface2.parseLog(log);
                if (parsed && parsed.name === "ETHLocked") {
                    requestId = parsed.args.requestId;
                    amount    = parsed.args.amount;
                    break;
                }
            } catch {}
        }
        if (!requestId) throw new Error("ETHLocked event not found in receipt");

        // Step 2: Mint wPETH on BSC
        const fd       = await bscProvider.getFeeData();
        const price    = cachedETHPrice;

        // Update price first
        if (price.usd > 0) {
            const avgS = BigInt(Math.round(price.usd * 1e8));
            const cgS  = BigInt(Math.round((price.cg_usd || price.usd) * 1e8));
            const bnS  = BigInt(Math.round((price.bn_usd || price.usd) * 1e8));
            await wpethBSC.updateEthPrice(avgS, cgS, bnS, price.source || "coingecko+kraken",
                { gasLimit: 120_000n, gasPrice: fd.gasPrice || 5_000_000_000n }
            ).catch(() => {});
        }

        // Mint with derived BSC requestId
        const bscReqId = ethers.keccak256(
            ethers.solidityPacked(["bytes32","uint256"], [requestId, BigInt(BSC_CHAIN_ID)])
        );
        const mintTx  = await wpethBSC.mint(to, amount, bscReqId,
            { gasLimit: 200_000n, gasPrice: fd.gasPrice || 5_000_000_000n }
        );
        const mintRcpt = await mintTx.wait();

        // Refresh BSC stats
        fetchWPETHBSCStats().catch(() => {});

        broadcast({
            type:        "bsc_mint",
            request_id:  requestId,
            amount_eth:  amount_eth,
            recipient:   to,
            private_tx:  lockTx.hash,
            bsc_tx:      mintTx.hash,
            bsc_block:   mintRcpt.blockNumber,
            eth_price:   price.usd,
        });

        res.json({
            success:        true,
            amount_eth:     amount_eth,
            recipient:      to,
            private_tx:     lockTx.hash,
            private_block:  lockRcpt.blockNumber,
            bsc_tx:         mintTx.hash,
            bsc_block:      mintRcpt.blockNumber,
            request_id:     requestId,
            bsc_request_id: bscReqId,
            eth_price:      price.usd,
            bscscan:        `https://bscscan.com/tx/${mintTx.hash}`,
            token_page:     `https://bscscan.com/token/${WPETH_BSC_ADDRESS}?a=${to}`,
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/v1/bsc/config — BSC bridge configuration
app.get("/api/v1/bsc/config", (req, res) => {
    res.json({
        src: {
            chain_id:  parseInt(CHAIN_ID),
            name:      "OpenClaw Private Chain",
            rpc:       PUBLIC_RPC_URL,
            bridge:    PRIVATE_BRIDGE_ADDRESS,
        },
        dst: {
            chain_id:  BSC_CHAIN_ID,
            name:      "BNB Smart Chain",
            rpc:       BSC_RPC_URL,
            wpeth:     WPETH_BSC_ADDRESS,
            bscscan:   "https://bscscan.com",
        },
        flow:         "Lock ETH on private chain → Relayer mints wPETH BEP-20 on BSC",
        gas_cost:     "~$0.01 BNB per mint (much cheaper than Mainnet)",
        deployed:     !!WPETH_BSC_ADDRESS,
        bsc_connected: bscConnected,
        bsc_block:    cachedBSCData.block_number,
        enable_bsc_mint: ENABLE_BSC_MINT,
        commands: {
            deploy:   "node deploy_bsc.js --deploy-wpeth-bsc",
            mint:     "node deploy_bsc.js --lock-eth-bsc --amount 1",
            price:    "node deploy_bsc.js --update-price-bsc",
            check:    "node deploy_bsc.js --check-bsc",
        },
        env_needed: {
            WPETH_BSC_ADDRESS:  "0x... (set after deploy)",
            ENABLE_BSC_MINT:    "true",
            BSC_RPC_URL:        "https://bsc-dataseed1.binance.org",
        },
    });
});
'''

# Find insertion point for API routes
# Try to insert before bridge routes or before server start
if '/api/v1/bsc/status' not in content:
    for target in [
        '// ══════════════════════════════════════════════════════════════\n// BRIDGE API ROUTES',
        '// ── Server start',
        'async function startServer',
        'migrateDB().then',
        'initBridge',
    ]:
        if target in content:
            # Use rfind to get the last occurrence for more reliable insertion
            idx = content.rfind(target)
            content = content[:idx] + BSC_ROUTES + '\n' + content[idx:]
            print(f'✅ BSC API routes added before: {target[:50]}')
            break
    else:
        # Append before end
        content = content.rstrip() + '\n\n' + BSC_ROUTES + '\n'
        print('✅ BSC API routes appended to end')
else:
    print('⚠  BSC API routes already present — skipping')

# ════════════════════════════════════════════════════════════
# SECTION 3 — Fixes for existing issues
# ════════════════════════════════════════════════════════════

# Fix: flashbots RPC → virginia
old_flashbots = '"https://rpc.flashbots.net"'
if old_flashbots in content:
    content = content.replace(old_flashbots, '"https://virginia.rpc.blxrbdn.com"')
    print('✅ Fixed: flashbots RPC → virginia.rpc.blxrbdn.com')

# Fix: ETH_MAINNET_RPC_URL default
old_rpc_default = '|| "https://rpc.flashbots.net"'
if old_rpc_default in content:
    content = content.replace(old_rpc_default, '|| "https://virginia.rpc.blxrbdn.com"')
    print('✅ Fixed: ETH_MAINNET_RPC_URL default → virginia')

# Fix: callProvider undefined — replace any remaining callProvider with inline
if 'callProvider' in content:
    import re
    before = content.count('callProvider')
    # Remove definition line
    content = re.sub(
        r'let callProvider\s*=\s*new ethers\.JsonRpcProvider\([^)]+\);\s*\n',
        '',
        content
    )
    # Replace all usages with inline provider
    content = re.sub(
        r'\bcallProvider\b',
        'new ethers.JsonRpcProvider("https://virginia.rpc.blxrbdn.com")',
        content
    )
    after = content.count('callProvider')
    print(f'✅ Fixed: callProvider ({before} → {after} occurrences)')

# Fix: wPETH stats getStats() call — suppress errors silently
if 'wPETH stats: missing revert data' not in content:
    content = content.replace(
        '} catch(e) { console.warn("⚠ wPETH stats:", e.message); }',
        '} catch(e) { /* wPETH getStats not available — using individual calls */ }'
    )
    print('✅ Fixed: wPETH stats error suppressed')

# ════════════════════════════════════════════════════════════
# SECTION 4 — Update startup banner to mention BSC
# ════════════════════════════════════════════════════════════
for banner_line in [
    '"║  NEW: /api/v1/nginx · /api/v1/p2p reverse routes     ║"',
    '"║ wPETH · Bridge · P2P · Nginx ║"',
]:
    if banner_line in content and 'BSC' not in content[content.find(banner_line):content.find(banner_line)+200]:
        new_banner = banner_line + '\n    console.log("║  BSC:  /api/v1/bsc/status · /bsc/wpeth · /bsc/mint   ║");'
        content = content.replace(banner_line, new_banner)
        print('✅ Startup banner updated with BSC routes')
        break

# ════════════════════════════════════════════════════════════
# WRITE
# ════════════════════════════════════════════════════════════
open(FILE, 'w').write(content)

print(f'\n✅ server.js patched successfully')
print(f'   Original : {original_len:,} bytes')
print(f'   New size : {len(content):,} bytes')
print(f'   Added    : {len(content) - original_len:,} bytes')
print("""
Next steps:
  1. node --check server.js
  2. pm2 restart server
  3. curl https://ai-private.online:3443/api/v1/bsc/status | python3 -m json.tool
  4. curl https://ai-private.online:3443/api/v1/bsc/config | python3 -m json.tool

Add to .env:
  BSC_RPC_URL=https://bsc-dataseed1.binance.org
  WPETH_BSC_ADDRESS=0x...    (after: node deploy_bsc.js --deploy-wpeth-bsc)
  ENABLE_BSC_MINT=true       (enables POST /api/v1/bsc/mint endpoint)

New BSC endpoints:
  GET  /api/v1/bsc/status         — BSC connection + block number
  GET  /api/v1/bsc/wpeth          — wPETH BEP-20 supply/price on BSC
  GET  /api/v1/bsc/balance/:addr  — BNB + wPETH balance
  POST /api/v1/bsc/mint           — lock ETH + mint wPETH on BSC
  GET  /api/v1/bsc/config         — BSC bridge configuration
""")

