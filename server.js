require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const multer    = require("multer");
const path      = require("path");
const fs        = require("fs");
const { ethers }= require("ethers");
const { Pool }  = require("pg");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════
const PORT                     = process.env.PORT                   || 3000;
const CHAIN_ID                 = process.env.CHAIN_ID               || "123456";
const RPC_URL                  = process.env.RPC_URL                || "http://localhost:8545";
const ADMIN_API_KEY            = process.env.ADMIN_API_KEY          || "change-me";
const NGINX_DOMAIN             = process.env.NGINX_DOMAIN           || "ai-private.online";
const VPS_IP                   = process.env.VPS_IP                 || "68.183.30.13";
const EXPLORER_DOMAIN          = process.env.EXPLORER_DOMAIN        || `${NGINX_DOMAIN}:3000`;
const PROTOCOL                 = process.env.PROTOCOL               || "https";
const P2P_PORT                 = parseInt(process.env.P2P_PORT      || "30303");
const GETH_ADMIN_RPC           = process.env.GETH_ADMIN_RPC         || "http://localhost:8545";
const PUBLIC_RPC_URL           = process.env.PUBLIC_RPC_URL         || `https://${NGINX_DOMAIN}:8545`;
const PUBLIC_WS_URL            = process.env.PUBLIC_WS_URL          || `wss://${NGINX_DOMAIN}:8546`;
const ETH_MAINNET_RPC_URL      = process.env.ETH_MAINNET_RPC_URL    || "https://rpc.flashbots.net";
const MAINNET_CHAIN_ID         = parseInt(process.env.MAINNET_CHAIN_ID || "1");
const PRIVATE_BRIDGE_ADDRESS   = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS || null;
const DEPLOYER_PRIVATE_KEY     = process.env.DEPLOYER_PRIVATE_KEY   || null;
const ETH_LOGO_URL             = "https://raw.githubusercontent.com/sakbayeme2015/token-asset4/main/eth.png";
const SUSDC_LOGO_URL           = "https://raw.githubusercontent.com/sakbayeme2015/token-asset3/main/0x22f1f5ee41df61e4d66dda698b2120c74c9c3be8.png";
const SUSDC = {
    address:     process.env.SUSDC_CONTRACT_ADDRESS || "",
    price:       process.env.SUSDC_PRICE_USD        || "1.000000",
    symbol:      "sUSDC", name: "Stablecoin USDC",
    decimals:    6, totalSupply: "100000000000",
};

// ── Token Bridge Config ─────────────────────────────────────
// sUSDC (private chain) → USDT (Ethereum Mainnet) direct bridge
const SUSDC_PRIVATE_ADDRESS = process.env.SUSDC_CONTRACT_ADDRESS  || "0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8";
const USDT_MAINNET_ADDRESS  = process.env.USDT_MAINNET_ADDRESS    || "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TOKEN_BRIDGE_ADDRESS  = process.env.TOKEN_BRIDGE_ADDRESS    || null;
const WPETH_ADDRESS         = process.env.WPETH_ADDRESS            || null;

const WPETH_ABI = [
    "function mint(address to, uint256 amount, bytes32 requestId) returns (bool)",
    "function totalSupply() view returns (uint256)",
    "function totalMinted() view returns (uint256)",
    "function totalBurned() view returns (uint256)",
    "function ethPriceUSD() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function ethPriceUSD() view returns (uint256)",
    "function cgPriceUSD() view returns (uint256)",
    "function bnPriceUSD() view returns (uint256)",
    "function priceSource() view returns (string)",
    "function priceUpdatedAt() view returns (uint256)",
    "function getValueUSD(address) view returns (uint256)",
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
    "event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];

let cachedWPETHData = { address:WPETH_ADDRESS, total_supply:"0", eth_price_usd:0, cg_usd:0, bn_usd:0, source:"—", updated_at:null };

async function fetchWPETHStats() {
    if (!WPETH_ADDRESS || !mainnetProvider) return;
    try {
        const wpethABI2 = [
            "function totalSupply() view returns (uint256)",
            "function totalMinted() view returns (uint256)",
            "function totalBurned() view returns (uint256)",
            "function ethPriceUSD() view returns (uint256)",
            "function cgPriceUSD() view returns (uint256)",
            "function bnPriceUSD() view returns (uint256)",
            "function priceSource() view returns (string)",
            "function priceUpdatedAt() view returns (uint256)",
        ];
        const _p = new ethers.JsonRpcProvider("https://virginia.rpc.blxrbdn.com");
        const wpeth = new ethers.Contract(WPETH_ADDRESS, wpethABI2, _p);
        const [supply,minted,burned,price,cg,bn,src,updAt] = await Promise.all([
            wpeth.totalSupply(), wpeth.totalMinted(), wpeth.totalBurned(),
            wpeth.ethPriceUSD(), wpeth.cgPriceUSD(), wpeth.bnPriceUSD(),
            wpeth.priceSource(), wpeth.priceUpdatedAt(),
        ]);
        cachedWPETHData = {
            address:       WPETH_ADDRESS,
            symbol:        "wPETH",
            name:          "Wrapped Private ETH",
            total_supply:  ethers.formatEther(supply),
            total_minted:  ethers.formatEther(minted),
            total_burned:  ethers.formatEther(burned),
            eth_price_usd: Number(price) / 1e8,
            cg_usd:        Number(cg) / 1e8,
            bn_usd:        Number(bn) / 1e8,
            price_updated: new Date(Number(updAt) * 1000).toISOString(),
            source:        src || "coingecko+binance",
            note:          "1 wPETH = 1 ETH (locked on private chain 123456)",
            etherscan:     `https://etherscan.io/token/${WPETH_ADDRESS}`,
            updated_at:    new Date().toISOString(),
        };
        broadcast({ type:"wpeth_stats", ...cachedWPETHData });
        console.log(`🪙 wPETH: supply=${cachedWPETHData.total_supply} price=$${cachedWPETHData.eth_price_usd} [${cachedWPETHData.source}]`);
    } catch(e) { console.warn("⚠  wPETH stats:", e.message); }
}
setInterval(fetchWPETHStats, 90_000);

// Cached USDT price (always ~$1 but track live for depegging)
let cachedUSDTPrice = { usd:1.0, cg_usd:null, bn_usd:null, source:"cached", updated_at:new Date().toISOString() };
const tokenBridgePriceOracle = new Map(); // token_bridge_address → latest oracle
const tokenBridgeCache = new Map();       // requestId → bridge request

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const TOKEN_BRIDGE_ABI = [
    "event TokensLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "event TokensReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "function lockTokens(address mainnetRecipient, uint256 amount) external returns (bytes32)",
    "function getStats() external view returns (uint256 lockedBalance, uint256 totalRequests)",
    "function approve(address spender, uint256 amount) external returns (bool)",
];

// Nginx config snapshot (used in /api/v1/nginx)
const NGINX_CONFIG = {
    domain:       NGINX_DOMAIN,
    vps_ip:       VPS_IP,
    ssl:          true,
    tls_versions: ["TLSv1.2","TLSv1.3"],
    cert_path:    `/etc/letsencrypt/live/${NGINX_DOMAIN}/fullchain.pem`,
    routes: [
        { listen:`${VPS_IP}:8545 ssl`, purpose:"Private Chain JSON-RPC (Geth)", proxy_pass:"http://127.0.0.1:8545", cors:true, chain_id:CHAIN_ID, url:`https://${NGINX_DOMAIN}:8545` },
        { listen:`${VPS_IP}:8546 ssl`, purpose:"Private Chain WebSocket (Geth)", proxy_pass:"http://127.0.0.1:8546", upgrade:true, chain_id:CHAIN_ID, url:`wss://${NGINX_DOMAIN}:8546` },
        { listen:`${VPS_IP}:3000 ssl`, purpose:"Explorer (server.js)",           proxy_pass:"http://127.0.0.1:3000", upgrade:true, cors:true, url:`https://${NGINX_DOMAIN}:3000` },
    ],
    p2p: { port:P2P_PORT, host:VPS_IP, protocol:"devp2p / rlpx", note:"TCP+UDP direct — not proxied through nginx" },
    reverse_routes: [
        { label:"Private Chain → Ethereum Mainnet (Direct)", from:{chain_id:CHAIN_ID,name:"OpenClaw Private Chain",rpc:PUBLIC_RPC_URL}, to:{chain_id:MAINNET_CHAIN_ID,name:"Ethereum Mainnet",rpc:ETH_MAINNET_RPC_URL}, via:`devp2p P2P port ${P2P_PORT} + nginx SSL ${NGINX_DOMAIN}`, bridge_contract:PRIVATE_BRIDGE_ADDRESS, direction:"private_to_mainnet", bypass_l2:true },
        { label:"Ethereum Mainnet → Private Chain",          from:{chain_id:MAINNET_CHAIN_ID,name:"Ethereum Mainnet"}, to:{chain_id:CHAIN_ID,name:"OpenClaw Private Chain",rpc:PUBLIC_RPC_URL}, via:"Relayer via nginx reverse proxy", direction:"mainnet_to_private" },
    ],
    nginx_snippet:`
server {
    listen ${VPS_IP}:8545 ssl;
    server_name ${NGINX_DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${NGINX_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${NGINX_DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:8545;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;
        if ($request_method = OPTIONS) { return 200; }
    }
}
server {
    listen ${VPS_IP}:8546 ssl;
    server_name ${NGINX_DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${NGINX_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${NGINX_DOMAIN}/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8546;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
server {
    listen ${VPS_IP}:3000 ssl;
    server_name ${NGINX_DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${NGINX_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${NGINX_DOMAIN}/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`
};

// ── PostgreSQL ─────────────────────────────────────────────────
const db = new Pool({
    host:     process.env.POSTGRES_HOST     || "localhost",
    port:     parseInt(process.env.POSTGRES_PORT || "5433"),
    user:     process.env.POSTGRES_USER     || "blockscout",
    password: process.env.POSTGRES_PASSWORD || "susdc_secure_2024",
    database: process.env.POSTGRES_DB       || "blockscout",
    max: 10, idleTimeoutMillis: 30000,
});

// ══════════════════════════════════════════════════════════════
//  AUTO DB MIGRATION
// ══════════════════════════════════════════════════════════════
async function migrateDB() {
    const client = await db.connect();
    try {
        console.log("🔧 Auto DB migration…");
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocks (
                number BIGINT PRIMARY KEY, hash TEXT UNIQUE, miner TEXT,
                timestamp BIGINT, tx_count INT DEFAULT 0,
                gas_used TEXT, gas_limit TEXT, inserted_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS transactions (
                hash TEXT PRIMARY KEY, block_number BIGINT,
                from_address TEXT, to_address TEXT,
                value TEXT, value_usd TEXT, gas_used TEXT, gas_fee_usd TEXT,
                status TEXT, tx_type TEXT DEFAULT 'ETH',
                input_data TEXT, nonce BIGINT,
                timestamp BIGINT, inserted_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS token_transfers (
                id SERIAL PRIMARY KEY, tx_hash TEXT, block_number BIGINT,
                token_address TEXT, token_symbol TEXT,
                from_address TEXT, to_address TEXT,
                value TEXT, value_decimal NUMERIC(36,6), value_usd NUMERIC(18,2),
                timestamp BIGINT, inserted_at TIMESTAMP DEFAULT NOW(),
                UNIQUE (tx_hash, from_address, to_address, value)
            );
            CREATE TABLE IF NOT EXISTS eth_transfers (
                id SERIAL PRIMARY KEY, tx_hash TEXT UNIQUE,
                from_address TEXT, to_address TEXT,
                value_wei TEXT, value_eth NUMERIC(36,18),
                value_usd NUMERIC(18,2), block_number BIGINT,
                timestamp BIGINT, status TEXT DEFAULT 'confirmed',
                inserted_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS eth_price (
                symbol TEXT PRIMARY KEY, price_usd NUMERIC(18,2), updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS token_prices (
                address TEXT PRIMARY KEY, symbol TEXT, name TEXT,
                price_usd NUMERIC(18,6), updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS verified_contracts (
                address TEXT PRIMARY KEY, contract_name TEXT, source_code TEXT,
                compiler_version TEXT, optimization BOOLEAN, verified_at TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS p2p_stats (
                port INT PRIMARY KEY, peer_count INT DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS bridge_requests (
                id SERIAL PRIMARY KEY,
                request_id   TEXT UNIQUE,
                sender       TEXT,
                recipient    TEXT,
                amount_wei   TEXT,
                amount_eth   NUMERIC(36,18),
                amount_usd   NUMERIC(18,2),
                status       TEXT DEFAULT 'pending',
                direction    TEXT DEFAULT 'private_to_mainnet',
                src_chain_id TEXT,
                dst_chain_id TEXT,
                src_tx_hash  TEXT,
                dst_tx_hash  TEXT,
                bridge_address TEXT,
                eth_price_usd_private  NUMERIC(18,2),
                eth_price_usd_mainnet  NUMERIC(18,2),
                eth_price_source_priv  TEXT,
                eth_price_source_main  TEXT,
                cg_price_private       NUMERIC(18,2),
                bn_price_private       NUMERIC(18,2),
                cg_price_mainnet       NUMERIC(18,2),
                bn_price_mainnet       NUMERIC(18,2),
                oracle_fetched_at      TIMESTAMP,
                block_number BIGINT,
                timestamp    BIGINT,
                inserted_at  TIMESTAMP DEFAULT NOW(),
                updated_at   TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS bridge_price_oracle (
                id SERIAL PRIMARY KEY,
                bridge_address   TEXT NOT NULL,
                direction        TEXT,
                src_chain_id     TEXT,
                dst_chain_id     TEXT,
                private_cg_usd   NUMERIC(18,2),
                private_bn_usd   NUMERIC(18,2),
                private_avg_usd  NUMERIC(18,2),
                mainnet_cg_usd   NUMERIC(18,2),
                mainnet_bn_usd   NUMERIC(18,2),
                mainnet_avg_usd  NUMERIC(18,2),
                price_delta_usd  NUMERIC(18,4),
                tx_count         INT DEFAULT 1,
                fetched_at       TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_bpo_addr    ON bridge_price_oracle (bridge_address);
            CREATE INDEX IF NOT EXISTS idx_bpo_fetched ON bridge_price_oracle (fetched_at DESC);
            CREATE INDEX IF NOT EXISTS idx_br_dir      ON bridge_requests (direction);
            CREATE INDEX IF NOT EXISTS idx_br_status   ON bridge_requests (status);
            CREATE INDEX IF NOT EXISTS idx_tx_from     ON transactions (from_address);
            CREATE INDEX IF NOT EXISTS idx_tx_to       ON transactions (to_address);
            CREATE INDEX IF NOT EXISTS idx_tx_block    ON transactions (block_number DESC);
        `);
        const cols = [
            ["transactions","value_usd","TEXT"],["transactions","gas_fee_usd","TEXT"],
            ["transactions","tx_type","TEXT DEFAULT 'ETH'"],["transactions","input_data","TEXT"],
            ["transactions","nonce","BIGINT"],["transactions","timestamp","BIGINT"],
        ];
        for (const [t,c,tp] of cols) await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${tp}`).catch(()=>{});
        // Token bridge tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS token_bridge_requests (
                id SERIAL PRIMARY KEY,
                request_id    TEXT UNIQUE,
                sender        TEXT,
                recipient     TEXT,
                amount_tokens TEXT,
                amount_usd    NUMERIC(18,2),
                src_token     TEXT,
                dst_token     TEXT,
                status        TEXT DEFAULT 'pending',
                direction     TEXT DEFAULT 'susdc_to_usdt',
                src_chain_id  TEXT,
                dst_chain_id  TEXT,
                bridge_address TEXT,
                usdt_price_cg  NUMERIC(18,6),
                usdt_price_bn  NUMERIC(18,6),
                usdt_price_avg NUMERIC(18,6),
                oracle_fetched_at TIMESTAMP,
                src_tx_hash   TEXT,
                dst_tx_hash   TEXT,
                timestamp     BIGINT,
                inserted_at   TIMESTAMP DEFAULT NOW(),
                updated_at    TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS token_bridge_price_oracle (
                id SERIAL PRIMARY KEY,
                bridge_address TEXT,
                direction      TEXT,
                src_token      TEXT,
                dst_token      TEXT,
                src_chain_id   TEXT,
                dst_chain_id   TEXT,
                private_eth_cg NUMERIC(18,2),
                private_eth_bn NUMERIC(18,2),
                mainnet_eth_cg NUMERIC(18,2),
                mainnet_eth_bn NUMERIC(18,2),
                usdt_cg_usd    NUMERIC(18,6),
                usdt_bn_usd    NUMERIC(18,6),
                usdt_avg_usd   NUMERIC(18,6),
                amount_tokens  TEXT,
                amount_usd     NUMERIC(18,2),
                fetched_at     TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_tbr_dir    ON token_bridge_requests (direction);
            CREATE INDEX IF NOT EXISTS idx_tbr_status ON token_bridge_requests (status);
            CREATE INDEX IF NOT EXISTS idx_tbpo_addr  ON token_bridge_price_oracle (bridge_address);
        `).catch(()=>{});
        console.log("✅ DB migration complete");
    } catch(e) { console.error("❌ Migration:", e.message); } finally { client.release(); }
}

// ── RPC Providers ──────────────────────────────────────────────
let provider, mainnetProvider;
try { provider = new ethers.JsonRpcProvider(RPC_URL); console.log("✅ Private RPC:", RPC_URL); } catch(e) { console.warn("⚠  Private RPC:", e.message); }
try { mainnetProvider = new ethers.JsonRpcProvider(ETH_MAINNET_RPC_URL); console.log("✅ Mainnet RPC:", ETH_MAINNET_RPC_URL); } catch(e) { console.warn("⚠  Mainnet RPC:", e.message); }

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs:60_000, max:300 }));
app.use("/admin/", rateLimit({ windowMs:60_000, max:30 }));
const logoDir = path.join(__dirname, "public","images","tokens");
fs.mkdirSync(logoDir, { recursive:true });
const upload = multer({ storage:multer.diskStorage({ destination:logoDir, filename:(req,file,cb)=>{ cb(null,`${(req.body.address||"unk").toLowerCase()}${path.extname(file.originalname)||".svg"}`); }}), limits:{fileSize:1_048_576} });

const tokenPrices = {};
function initTokenPrices() {
    if (SUSDC.address) { tokenPrices[SUSDC.address.toLowerCase()]={ symbol:SUSDC.symbol, name:SUSDC.name, usd:parseFloat(SUSDC.price), decimals:SUSDC.decimals, logo_url:SUSDC_LOGO_URL, updated_at:new Date().toISOString() }; }
}

// ── P2P ────────────────────────────────────────────────────────
let p2pPeers = [], p2pSelf = {};
async function pollP2PPeers() {
    try {
        const res = await fetch(GETH_ADMIN_RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:"admin_peers",params:[],id:1}),signal:AbortSignal.timeout(5000)});
        if (!res.ok) return; const d = await res.json();
        if (d.result) p2pPeers = d.result.map(p=>({id:p.id?.slice(0,16)+"…",name:p.name,enode:p.enode,network:{remoteAddress:p.network?.remoteAddress,inbound:p.network?.inbound}}));
        const sr = await fetch(GETH_ADMIN_RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:"admin_nodeInfo",params:[],id:2}),signal:AbortSignal.timeout(5000)});
        if (sr.ok) { const sd=await sr.json(); if(sd.result) p2pSelf={id:sd.result.id,name:sd.result.name,enode:sd.result.enode,ports:sd.result.ports}; }
    } catch {}
}
pollP2PPeers(); setInterval(pollP2PPeers,30_000);

// ══════════════════════════════════════════════════════════════
//  DUAL PRICE ORACLE
//  Fetches CoinGecko + Binance on both private chain and mainnet
//  simultaneously at the exact moment of each bridge event.
// ══════════════════════════════════════════════════════════════
let cachedETHPrice = { usd:1865.51, change_24h:"-6.80", high_24h:2003.78, low_24h:1866.24, updated_at:new Date().toISOString(), source:"cached" };
let priceHistory   = [];
let cgBackoff      = 60_000;

const bridgePriceOracle = new Map(); // bridge_address → latest oracle entry

async function fetchCG() {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true&include_high_24h=true&include_low_24h=true",{signal:AbortSignal.timeout(9000)});
    if (res.status===429) throw Object.assign(new Error("rate_limited"),{code:429});
    if (!res.ok) throw new Error(`CG ${res.status}`);
    const d=await res.json();
    return { usd:d.ethereum.usd, change_24h:(d.ethereum.usd_24h_change||0).toFixed(2), high_24h:d.ethereum.usd_24h_high, low_24h:d.ethereum.usd_24h_low, source:"coingecko" };
}
async function fetchBN() {
    const [tR,sR]=await Promise.all([fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD",{signal:AbortSignal.timeout(9000)}),fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD",{signal:AbortSignal.timeout(9000)})]);
    if (!tR.ok) throw new Error(`BN ${tR.status}`);
    const t=await tR.json(); const s=sR.ok?await sR.json():{};
    return { usd:parseFloat(t?.result?.XETHZUSD?.c?.[0]||0), change_24h:parseFloat(t?.result?.XETHZUSD?.P?.[0]||0).toFixed(2), high_24h:parseFloat(t?.result?.XETHZUSD?.h?.[0]||0), low_24h:parseFloat(t?.result?.XETHZUSD?.l?.[0]||0), source:"kraken" };
}

// Dual fetch — runs CoinGecko + Binance in parallel, returns avg
async function fetchDualPrice() {
    const [cgR,bnR] = await Promise.allSettled([fetchCG(), fetchBN()]);
    const cg = cgR.status==="fulfilled"?cgR.value:null;
    const bn = bnR.status==="fulfilled"?bnR.value:null;
    if (cg&&bn) return { avg:parseFloat(((cg.usd+bn.usd)/2).toFixed(2)), cg_usd:cg.usd, bn_usd:bn.usd, source:"coingecko+binance", change_24h:cg.change_24h, high_24h:Math.max(cg.high_24h||0,bn.high_24h||0), low_24h:Math.min(cg.low_24h||9999,bn.low_24h||9999) };
    if (cg) return { avg:cg.usd, cg_usd:cg.usd, bn_usd:null, source:"coingecko", change_24h:cg.change_24h, high_24h:cg.high_24h, low_24h:cg.low_24h };
    if (bn) return { avg:bn.usd, cg_usd:null, bn_usd:bn.usd, source:"kraken",   change_24h:bn.change_24h, high_24h:bn.high_24h, low_24h:bn.low_24h };
    return { avg:cachedETHPrice.usd, cg_usd:null, bn_usd:null, source:"cached_fallback", change_24h:cachedETHPrice.change_24h, high_24h:cachedETHPrice.high_24h, low_24h:cachedETHPrice.low_24h };
}

// On-demand oracle at bridge event time — fetches both chains simultaneously
async function fetchBridgeOraclePrice(bridgeAddress, direction) {
    const addr = (bridgeAddress||"").toLowerCase();
    // Private chain price + Mainnet price fetched in parallel
    const [privResult, mainResult] = await Promise.allSettled([fetchDualPrice(), fetchDualPrice()]);
    const priv = privResult.status==="fulfilled" ? privResult.value : { avg:cachedETHPrice.usd, cg_usd:null, bn_usd:null, source:"cached" };
    const main = mainResult.status==="fulfilled" ? mainResult.value : { avg:cachedETHPrice.usd, cg_usd:null, bn_usd:null, source:"cached" };
    const prev  = bridgePriceOracle.get(addr);
    const txCount = prev ? prev.tx_count+1 : 1;
    const delta = priv.avg - main.avg;
    const entry = {
        bridge_address:bridgeAddress, direction, tx_count:txCount, fetched_at:new Date().toISOString(),
        private_chain: { chain_id:CHAIN_ID, cg_usd:priv.cg_usd, bn_usd:priv.bn_usd, avg_usd:priv.avg, source:priv.source },
        mainnet:       { chain_id:MAINNET_CHAIN_ID, cg_usd:main.cg_usd, bn_usd:main.bn_usd, avg_usd:main.avg, source:main.source },
        price_delta_usd: parseFloat(delta.toFixed(4)),
        note:"private_avg - mainnet_avg",
    };
    bridgePriceOracle.set(addr, entry);
    console.log(`🔮 [Oracle] ${addr.slice(0,10)}… private=$${priv.avg} mainnet=$${main.avg} Δ${delta>=0?"+":""}${delta.toFixed(2)} tx#${txCount}`);
    try {
        await db.query(`INSERT INTO bridge_price_oracle
            (bridge_address,direction,src_chain_id,dst_chain_id,private_cg_usd,private_bn_usd,private_avg_usd,mainnet_cg_usd,mainnet_bn_usd,mainnet_avg_usd,price_delta_usd,tx_count,fetched_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
            [addr,direction,CHAIN_ID,MAINNET_CHAIN_ID,priv.cg_usd,priv.bn_usd,priv.avg,main.cg_usd,main.bn_usd,main.avg,delta,txCount]
        );
    } catch {}
    broadcast({ type:"bridge_price_oracle", ...entry });
    return entry;
}

// ── USDT Price Oracle (CG + Binance simultaneously) ──────────
// Fetches USDT price on both private chain + mainnet in parallel
async function fetchUSDTPrice() {
    const [cgR, bnR] = await Promise.allSettled([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd", {signal:AbortSignal.timeout(9000)})
            .then(r=>r.ok?r.json():Promise.reject(new Error(`CG ${r.status}`))),
        fetch("https://api.kraken.com/0/public/Ticker?pair=USDTUSD", {signal:AbortSignal.timeout(9000)})
            .then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    const cg  = cgR.status==="fulfilled" ? parseFloat(cgR.value?.tether?.usd||1) : null;
    const bn  = bnR.status==="fulfilled" && bnR.value ? parseFloat(bnR.value?.result?.USDTUSD?.c?.[0]||1) : null;
    const avg = cg&&bn ? parseFloat(((cg+bn)/2).toFixed(6)) : cg||bn||1.0;
    cachedUSDTPrice = { usd:avg, cg_usd:cg, bn_usd:bn, source:cg&&bn?"coingecko+binance":cg?"coingecko":bn?"binance":"cached", updated_at:new Date().toISOString() };
    // Track USDT on mainnet
    if (mainnetProvider && USDT_MAINNET_ADDRESS) {
        try {
            const usdt = new ethers.Contract(USDT_MAINNET_ADDRESS, ERC20_ABI, mainnetProvider);
            const [supply, decimals] = await Promise.all([usdt.totalSupply(), usdt.decimals()]);
            cachedUSDTPrice.mainnet_total_supply = ethers.formatUnits(supply, decimals);
        } catch {}
    }
    // Track sUSDC on private chain simultaneously
    if (provider && SUSDC_PRIVATE_ADDRESS) {
        try {
            const susdc = new ethers.Contract(SUSDC_PRIVATE_ADDRESS, ERC20_ABI, provider);
            const [supply, decimals] = await Promise.all([susdc.totalSupply(), susdc.decimals()]);
            cachedUSDTPrice.private_susdc_supply = ethers.formatUnits(supply, decimals);
        } catch {}
    }
    try { await db.query(`INSERT INTO token_prices (address,symbol,name,price_usd,updated_at) VALUES ($1,'USDT','Tether USD',$2,NOW()) ON CONFLICT (address) DO UPDATE SET price_usd=$2,updated_at=NOW()`,[USDT_MAINNET_ADDRESS.toLowerCase(),avg]); } catch {}
    broadcast({type:"usdt_price", ...cachedUSDTPrice});
    console.log(`💵 USDT: $${avg} [${cachedUSDTPrice.source}] CG:$${cg||"—"} BN:$${bn||"—"}`);
    return cachedUSDTPrice;
}
setInterval(fetchUSDTPrice, 90_000);

// ── Token Bridge Oracle ───────────────────────────────────────
// On-demand: fetches sUSDC (private) + USDT (mainnet) prices simultaneously
async function fetchTokenBridgeOraclePrice(bridgeAddr, direction, amountTokens) {
    const addr = (bridgeAddr||"").toLowerCase();
    // Fetch both token prices on both chains simultaneously
    const [privR, mainR, usdtR] = await Promise.allSettled([
        fetchDualPrice(),    // ETH price on private chain (for gas)
        fetchDualPrice(),    // ETH price on mainnet (for gas)
        fetchUSDTPrice(),    // USDT price on mainnet
    ]);
    const priv = privR.status==="fulfilled" ? privR.value : {avg:cachedETHPrice.usd,cg_usd:null,bn_usd:null,source:"cached"};
    const main = mainR.status==="fulfilled" ? mainR.value : {avg:cachedETHPrice.usd,cg_usd:null,bn_usd:null,source:"cached"};
    const usdt = usdtR.status==="fulfilled" ? usdtR.value : cachedUSDTPrice;

    // sUSDC balance on private chain (no reserve check)
    let susdcBalancePrivate = "—", usdtBalanceMainnet = "—";
    if (provider && SUSDC_PRIVATE_ADDRESS) {
        try {
            const c = new ethers.Contract(SUSDC_PRIVATE_ADDRESS, ERC20_ABI, provider);
            susdcBalancePrivate = ethers.formatUnits(await c.totalSupply(), 6);
        } catch {}
    }
    // USDT total supply on mainnet (no reserve tracking)
    if (mainnetProvider && USDT_MAINNET_ADDRESS) {
        try {
            const c = new ethers.Contract(USDT_MAINNET_ADDRESS, ERC20_ABI, mainnetProvider);
            usdtBalanceMainnet = ethers.formatUnits(await c.totalSupply(), 6);
        } catch {}
    }

    const amtUSD = (parseFloat(amountTokens||0) * usdt.usd).toFixed(2);
    const entry = {
        bridge_address: bridgeAddr,
        direction, token_type:"sUSDC_to_USDT",
        src_token:  { address:SUSDC_PRIVATE_ADDRESS, symbol:"sUSDC", chain_id:CHAIN_ID,    balance:susdcBalancePrivate },
        dst_token:  { address:USDT_MAINNET_ADDRESS,  symbol:"USDT",  chain_id:MAINNET_CHAIN_ID, balance:usdtBalanceMainnet },
        private_chain: { cg_usd:priv.cg_usd, bn_usd:priv.bn_usd, avg_usd:priv.avg, eth_source:priv.source },
        mainnet:       { cg_usd:main.cg_usd, bn_usd:main.bn_usd, avg_usd:main.avg, eth_source:main.source },
        usdt_price:    { cg_usd:usdt.cg_usd, bn_usd:usdt.bn_usd, avg_usd:usdt.usd, source:usdt.source },
        amount_tokens: amountTokens, amount_usd: amtUSD,
        fetched_at: new Date().toISOString(),
    };
    tokenBridgePriceOracle.set(addr, entry);
    console.log(`🔮 [TokenOracle] sUSDC→USDT ${amountTokens} tokens ($${amtUSD}) | USDT:$${usdt.usd} [${usdt.source}]`);
    try {
        await db.query(`INSERT INTO token_bridge_price_oracle
            (bridge_address,direction,src_token,dst_token,src_chain_id,dst_chain_id,
             private_eth_cg,private_eth_bn,mainnet_eth_cg,mainnet_eth_bn,
             usdt_cg_usd,usdt_bn_usd,usdt_avg_usd,amount_tokens,amount_usd,fetched_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
            [addr,direction,SUSDC_PRIVATE_ADDRESS,USDT_MAINNET_ADDRESS,
             CHAIN_ID,String(MAINNET_CHAIN_ID),
             priv.cg_usd,priv.bn_usd,main.cg_usd,main.bn_usd,
             usdt.cg_usd,usdt.bn_usd,usdt.usd,
             amountTokens,amtUSD]
        );
    } catch {}
    broadcast({type:"token_bridge_oracle",...entry});
    return entry;
}

// ── Token Bridge init ─────────────────────────────────────────
async function initTokenBridge() {
    if (!TOKEN_BRIDGE_ADDRESS||!provider) { console.log("ℹ  TOKEN_BRIDGE_ADDRESS not set — token bridge skipped"); return; }
    const bridge = new ethers.Contract(TOKEN_BRIDGE_ADDRESS, TOKEN_BRIDGE_ABI, provider);
    bridge.on("TokensLocked", async(sender, recipient, amount, requestId) => {
        const amtTokens = ethers.formatUnits(amount, 6);
        console.log(`
🌉 [TokenBridge] TokensLocked: ${amtTokens} sUSDC | ${sender.slice(0,10)}… → Mainnet ${recipient.slice(0,10)}…`);
        const oracle = await fetchTokenBridgeOraclePrice(TOKEN_BRIDGE_ADDRESS, "susdc_to_usdt", amtTokens).catch(()=>null);
        const amtUSD = oracle?.amount_usd || (parseFloat(amtTokens)*cachedUSDTPrice.usd).toFixed(2);
        const entry = { requestId, sender, recipient, amtTokens, amtUSD,
            src_token:SUSDC_PRIVATE_ADDRESS, dst_token:USDT_MAINNET_ADDRESS,
            status:"pending", direction:"susdc_to_usdt", oracle_at:new Date().toISOString() };
        tokenBridgeCache.set(requestId, entry);
        broadcast({type:"token_bridge_locked", ...entry, oracle});
        try {
            await db.query(`INSERT INTO token_bridge_requests
                (request_id,sender,recipient,amount_tokens,amount_usd,src_token,dst_token,
                 status,direction,src_chain_id,dst_chain_id,bridge_address,
                 usdt_price_cg,usdt_price_bn,usdt_price_avg,oracle_fetched_at,timestamp)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','susdc_to_usdt',$8,$9,$10,$11,$12,$13,NOW(),$14)
                ON CONFLICT (request_id) DO NOTHING`,
                [requestId,sender,recipient,amtTokens,amtUSD,
                 SUSDC_PRIVATE_ADDRESS,USDT_MAINNET_ADDRESS,
                 CHAIN_ID,String(MAINNET_CHAIN_ID),TOKEN_BRIDGE_ADDRESS,
                 oracle?.usdt_price?.cg_usd, oracle?.usdt_price?.bn_usd, oracle?.usdt_price?.avg_usd,
                 Math.floor(Date.now()/1000)]
            );
        } catch(e) { console.warn("⚠  token_bridge_requests:", e.message); }
    });
    bridge.on("TokensReleased", async(recipient, amount, requestId) => {
        const amtTokens = ethers.formatUnits(amount, 6);
        console.log(`✅ [TokenBridge] TokensReleased: ${amtTokens} USDT → ${recipient.slice(0,10)}… on Mainnet`);
        if (tokenBridgeCache.has(requestId)) tokenBridgeCache.get(requestId).status="completed";
        broadcast({type:"token_bridge_released", requestId, recipient, amtTokens});
        await db.query("UPDATE token_bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    });
    console.log(`✅ Token Bridge listening: ${TOKEN_BRIDGE_ADDRESS} (sUSDC→USDT direct)`);
}

async function fetchLiveETHPrice() {
    const pd = await fetchDualPrice().catch(()=>null);
    if (!pd) { setTimeout(fetchLiveETHPrice, Math.min(cgBackoff*=2,600_000)); return; }
    cgBackoff = 60_000;
    const prev = cachedETHPrice.usd;
    cachedETHPrice = { usd:pd.avg, change_24h:pd.change_24h, high_24h:pd.high_24h, low_24h:pd.low_24h, updated_at:new Date().toISOString(), source:pd.source, cg_usd:pd.cg_usd, bn_usd:pd.bn_usd };
    priceHistory.push({price:pd.avg,time:Date.now()}); if(priceHistory.length>60)priceHistory.shift();
    console.log(`💰 ETH: $${pd.avg} [${pd.source}] CG:$${pd.cg_usd} BN:$${pd.bn_usd}`);
    broadcast({type:"eth_price",usd:pd.avg,cg_usd:pd.cg_usd,bn_usd:pd.bn_usd,change_24h:pd.change_24h,high_24h:pd.high_24h,low_24h:pd.low_24h,updated_at:cachedETHPrice.updated_at,source:pd.source,direction:pd.avg>prev?"up":pd.avg<prev?"down":"same"});
    try { await db.query(`INSERT INTO eth_price (symbol,price_usd,updated_at) VALUES ('ETH',$1,NOW()) ON CONFLICT (symbol) DO UPDATE SET price_usd=$1,updated_at=NOW()`,[pd.avg]); } catch {}
    setTimeout(fetchLiveETHPrice, cgBackoff);
}

// ── WebSocket ──────────────────────────────────────────────────
function broadcast(data) { const m=JSON.stringify(data); wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(m);}); }
wss.on("connection", ws=>{ ws.send(JSON.stringify({type:"init",chain_id:CHAIN_ID,mainnet_chain_id:MAINNET_CHAIN_ID,eth_price:cachedETHPrice,history:priceHistory.slice(-20),p2p_port:P2P_PORT,nginx_domain:NGINX_DOMAIN,bridge_address:PRIVATE_BRIDGE_ADDRESS})); });
let lastBlock=0;
async function pollBlocks(){if(!provider)return;try{const cur=await provider.getBlockNumber();if(cur>lastBlock){const b=await provider.getBlock(cur);if(b){lastBlock=cur;broadcast({type:"new_block",number:b.number,hash:b.hash,tx_count:b.transactions.length,timestamp:b.timestamp,eth_price:cachedETHPrice.usd});}}}catch{}}
setInterval(pollBlocks,5_000);

// ══════════════════════════════════════════════════════════════
//  BRIDGE — Private Chain → Mainnet DIRECT (no L2)
// ══════════════════════════════════════════════════════════════
const BRIDGE_ABI = [
    "event ETHLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "event ETHReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "function lockETH(address mainnetRecipient) external payable returns (bytes32)",
    "function getStats() external view returns (uint256 balance, uint256 fee, uint256 totalRequests)",
    "function bridgeFee() external view returns (uint256)",
];

let bridgeContract = null;
let bridgeStats    = { address:PRIVATE_BRIDGE_ADDRESS, balance:"0", fee:"0", totalRequests:0 };
const bridgeCache  = new Map();

async function initBridge() {
    if (!PRIVATE_BRIDGE_ADDRESS||!provider) { console.log("ℹ  PRIVATE_BRIDGE_ADDRESS not set — bridge skipped"); return; }
    bridgeContract = new ethers.Contract(PRIVATE_BRIDGE_ADDRESS, BRIDGE_ABI, provider);

    async function refreshStats() {
        try { const s=await bridgeContract.getStats(); bridgeStats={address:PRIVATE_BRIDGE_ADDRESS,balance:ethers.formatEther(s[0]),fee:ethers.formatEther(s[1]),totalRequests:Number(s[2])}; } catch {}
    }
    await refreshStats(); setInterval(refreshStats,30_000);

    bridgeContract.on("ETHLocked", async (sender, recipient, amount, requestId) => {
        const amtETH = ethers.formatEther(amount);
        console.log(`\n🌉 ETHLocked: ${amtETH} ETH | ${sender.slice(0,10)}… → Mainnet ${recipient.slice(0,10)}… [${requestId.slice(0,10)}…]`);
        console.log(`   🔮 Fetching dual oracle prices (private + mainnet simultaneously)…`);

        // Fetch dual prices on BOTH chains at exact event time
        const oracle = await fetchBridgeOraclePrice(PRIVATE_BRIDGE_ADDRESS, "private_to_mainnet").catch(()=>null);
        const privPrice = oracle?.private_chain?.avg_usd || cachedETHPrice.usd;
        const mainPrice = oracle?.mainnet?.avg_usd       || cachedETHPrice.usd;
        const amtUSD    = (parseFloat(amtETH)*privPrice).toFixed(2);

        const entry = { requestId, sender, recipient, amountETH:amtETH, amountUSD:amtUSD, status:"pending", direction:"private_to_mainnet", src_chain_id:CHAIN_ID, dst_chain_id:String(MAINNET_CHAIN_ID), bridge_address:PRIVATE_BRIDGE_ADDRESS, eth_price_private:privPrice, eth_price_mainnet:mainPrice, oracle_at:new Date().toISOString() };
        bridgeCache.set(requestId, entry);
        broadcast({ type:"bridge_locked", ...entry, oracle });

        try {
            await db.query(`INSERT INTO bridge_requests
                (request_id,sender,recipient,amount_wei,amount_eth,amount_usd,status,direction,src_chain_id,dst_chain_id,bridge_address,eth_price_usd_private,eth_price_usd_mainnet,eth_price_source_priv,eth_price_source_main,cg_price_private,bn_price_private,cg_price_mainnet,bn_price_mainnet,oracle_fetched_at,timestamp)
                VALUES ($1,$2,$3,$4,$5,$6,'pending','private_to_mainnet',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),EXTRACT(EPOCH FROM NOW())::BIGINT)
                ON CONFLICT (request_id) DO NOTHING`,
                [requestId,sender,recipient,amount.toString(),amtETH,amtUSD,
                 CHAIN_ID,String(MAINNET_CHAIN_ID),PRIVATE_BRIDGE_ADDRESS,
                 privPrice,mainPrice,
                 oracle?.private_chain?.source||"cached",oracle?.mainnet?.source||"cached",
                 oracle?.private_chain?.cg_usd,oracle?.private_chain?.bn_usd,
                 oracle?.mainnet?.cg_usd,oracle?.mainnet?.bn_usd]
            );
        } catch(e) { console.warn("⚠  bridge_requests INSERT:", e.message); }
    });

    bridgeContract.on("ETHReleased", async (recipient, amount, requestId) => {
        const amtETH = ethers.formatEther(amount);
        console.log(`✅ ETHReleased: ${amtETH} ETH → ${recipient.slice(0,10)}… [${requestId.slice(0,10)}…]`);
        if (bridgeCache.has(requestId)) bridgeCache.get(requestId).status="completed";
        broadcast({ type:"bridge_released", requestId, recipient, amountETH:amtETH });
        await db.query("UPDATE bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    });

    console.log(`✅ Bridge listening: ${PRIVATE_BRIDGE_ADDRESS} (Private → Mainnet direct, no L2)`);
}

// ══════════════════════════════════════════════════════════════
//  HTML PAGE SHELL
// ══════════════════════════════════════════════════════════════
function pageShell(title, content) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title} — OpenClaw Explorer</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#f8f9fa;--card:#fff;--border:#e2e8f0;--blue:#021c48;--blue2:#0784c3;--green:#00a186;--red:#dc2626;--amber:#b45309;--muted:#64748b;--text:#1e293b;--mono:'JetBrains Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;font-size:14px}
a{color:var(--blue2);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--blue);padding:0 28px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.logo{font-family:var(--mono);font-size:14px;color:#fff;font-weight:600}
.back-btn{font-family:var(--mono);font-size:11px;color:rgba(255,255,255,.7);padding:6px 14px;border:1px solid rgba(255,255,255,.25);border-radius:4px;cursor:pointer;background:none}
main{max-width:1100px;margin:0 auto;padding:28px 24px 60px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px}
.card-head{padding:14px 20px;border-bottom:1px solid var(--border);font-weight:600;font-size:13px;display:flex;align-items:center;justify-content:space-between}
.row{display:flex;align-items:flex-start;padding:12px 20px;border-top:1px solid var(--border);font-size:13px;gap:12px}
.row:first-of-type{border-top:none}.row-k{width:180px;min-width:180px;color:var(--muted);font-size:12px}.row-v{flex:1;font-family:var(--mono);font-size:12px;word-break:break-all}
.pill{display:inline-block;padding:2px 8px;border-radius:3px;font-family:var(--mono);font-size:10px;font-weight:600}
.pg{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}.pr{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}
.pb{background:#e8f0fe;color:#1e40af;border:1px solid #c5d5f8}.pa{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
.title{font-family:var(--mono);font-size:22px;font-weight:700;margin-bottom:4px}
.subtitle{color:var(--muted);font-size:12px;margin-bottom:20px;word-break:break-all}
.logs-table{width:100%;border-collapse:collapse}
.logs-table th{padding:8px 14px;background:#f8f9fa;font-family:var(--mono);font-size:9px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;text-align:left;border-bottom:1px solid var(--border)}
.logs-table td{padding:10px 14px;border-top:1px solid var(--border);font-size:11px;font-family:var(--mono);word-break:break-all}
.err-box{background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:20px;text-align:center}
footer{background:var(--blue);color:rgba(255,255,255,.5);padding:16px 28px;font-family:var(--mono);font-size:10px}
</style></head><body>
<header><div class="logo">⛓ OpenClaw Explorer</div><button class="back-btn" onclick="history.back()">← Back</button></header>
<main>${content}</main>
<footer>OpenClaw Chain · ID ${CHAIN_ID} → Mainnet · P2P :${P2P_PORT} · ${NGINX_DOMAIN}</footer>
</body></html>`;
}

// ── /tx/:hash ──────────────────────────────────────────────────
app.get("/tx/:hash", async (req,res) => {
    const hash=req.params.hash;
    try {
        let txRow=null; try{const r=await db.query("SELECT * FROM transactions WHERE hash=$1",[hash]);if(r.rows.length)txRow=r.rows[0];}catch{}
        let tx=null,receipt=null; try{[tx,receipt]=await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);}catch{}
        if(!tx&&!txRow) return res.send(pageShell("TX Not Found",`<div class="err-box"><h2>Transaction Not Found</h2><p style="font-family:var(--mono);font-size:11px;margin-top:8px;word-break:break-all">${hash}</p></div>`));
        const ethVal=tx?.value?parseFloat(ethers.formatEther(tx.value)):0;
        const ethUSD=(ethVal*cachedETHPrice.usd).toFixed(2);
        const gasFeeEth=receipt?.gasUsed&&tx?.gasPrice?parseFloat(ethers.formatEther(tx.gasPrice*receipt.gasUsed)):0;
        const status=receipt?(receipt.status===1?"success":"failed"):(txRow?.status||"pending");
        const blockNum=tx?.blockNumber||txRow?.block_number||"—";
        const from=tx?.from||txRow?.from_address||"—"; const to=tx?.to||txRow?.to_address||"—";
        const stPill=`<span class="pill ${status==="success"?"pg":status==="failed"?"pr":"pa"}">${status.toUpperCase()}</span>`;
        let logsHtml="";
        if(receipt?.logs?.length){logsHtml=`<div class="card" style="margin-top:20px"><div class="card-head">Event Logs (${receipt.logs.length})</div><table class="logs-table"><thead><tr><th>#</th><th>Contract</th><th>Topic 0</th><th>Data</th></tr></thead><tbody>`;receipt.logs.forEach((l,i)=>{logsHtml+=`<tr><td>${i}</td><td><a href="/address/${l.address}">${l.address.slice(0,14)}…</a></td><td>${l.topics[0]?.slice(0,18)||"—"}…</td><td>${l.data?.slice(0,34)||"0x"}…</td></tr>`;});logsHtml+=`</tbody></table></div>`;}
        res.send(pageShell("TX "+hash.slice(0,14)+"…",`
<div class="title">Transaction</div><div class="subtitle">${hash}</div>
<div class="card"><div class="card-head">Details ${stPill}</div>
<div class="row"><span class="row-k">Tx Hash</span><span class="row-v">${hash}</span></div>
<div class="row"><span class="row-k">Status</span><span class="row-v">${stPill}</span></div>
<div class="row"><span class="row-k">Block</span><span class="row-v">${blockNum!=="—"?`<a href="/block/${blockNum}">#${parseInt(blockNum).toLocaleString()}</a>`:"—"}</span></div>
<div class="row"><span class="row-k">From</span><span class="row-v"><a href="/address/${from}">${from}</a></span></div>
<div class="row"><span class="row-k">To</span><span class="row-v">${to?`<a href="/address/${to}">${to}</a>`:"Contract Create"}</span></div>
<div class="row"><span class="row-k">Value</span><span class="row-v">${ethVal.toFixed(8)} ETH <span style="color:var(--muted)">($${ethUSD})</span></span></div>
<div class="row"><span class="row-k">Gas Used</span><span class="row-v">${parseInt(receipt?.gasUsed||txRow?.gas_used||0).toLocaleString()}</span></div>
<div class="row"><span class="row-k">Tx Fee</span><span class="row-v">${gasFeeEth.toFixed(8)} ETH</span></div>
<div class="row"><span class="row-k">ETH Price (CG+BN)</span><span class="row-v">$${cachedETHPrice.usd} (CG:$${cachedETHPrice.cg_usd||"—"} BN:$${cachedETHPrice.bn_usd||"—"})</span></div>
<div class="row"><span class="row-k">Nonce</span><span class="row-v">${tx?.nonce??txRow?.nonce??"—"}</span></div>
<div class="row"><span class="row-k">Input Data</span><span class="row-v" style="max-height:80px;overflow-y:auto;font-size:10px">${tx?.data||txRow?.input_data||"0x"}</span></div>
</div>${logsHtml}`));
    } catch(e){res.send(pageShell("Error",`<div class="err-box"><h2>Error</h2><p>${e.message}</p></div>`));}
});

// ── /block/:number ─────────────────────────────────────────────
app.get("/block/:number", async (req,res) => {
    try {
        const id=req.params.number; const b=await provider.getBlock(id.startsWith("0x")?id:parseInt(id),true);
        if(!b)return res.send(pageShell("Block Not Found",`<div class="err-box"><h2>Block #${id} Not Found</h2></div>`));
        let txHtml="";
        if(b.prefetchedTransactions?.length){txHtml=`<div class="card" style="margin-top:20px"><div class="card-head">Transactions (${b.prefetchedTransactions.length})</div><table class="logs-table"><thead><tr><th>Hash</th><th>From</th><th>To</th><th>ETH</th><th>USD</th></tr></thead><tbody>`;b.prefetchedTransactions.forEach(tx=>{const v=tx.value?parseFloat(ethers.formatEther(tx.value)):0;txHtml+=`<tr><td><a href="/tx/${tx.hash}">${tx.hash.slice(0,18)}…</a></td><td><a href="/address/${tx.from}">${tx.from.slice(0,12)}…</a></td><td>${tx.to?`<a href="/address/${tx.to}">${tx.to.slice(0,12)}…</a>`:"Contract"}</td><td>${v.toFixed(6)}</td><td>$${(v*cachedETHPrice.usd).toFixed(2)}</td></tr>`;});txHtml+=`</tbody></table></div>`;}
        res.send(pageShell("Block #"+b.number.toLocaleString(),`
<div class="title">Block #${b.number.toLocaleString()}</div><div class="subtitle">${b.hash}</div>
<div class="card"><div class="card-head">Block Details</div>
<div class="row"><span class="row-k">Height</span><span class="row-v">#${b.number.toLocaleString()}</span></div>
<div class="row"><span class="row-k">Hash</span><span class="row-v">${b.hash}</span></div>
<div class="row"><span class="row-k">Parent</span><span class="row-v"><a href="/block/${b.number-1}">${b.parentHash}</a></span></div>
<div class="row"><span class="row-k">Timestamp</span><span class="row-v">${new Date(b.timestamp*1000).toUTCString()}</span></div>
<div class="row"><span class="row-k">Miner/Sealer</span><span class="row-v"><a href="/address/${b.miner}">${b.miner}</a></span></div>
<div class="row"><span class="row-k">Transactions</span><span class="row-v">${b.transactions.length}</span></div>
<div class="row"><span class="row-k">Gas Used</span><span class="row-v">${b.gasUsed?.toLocaleString()||"—"}</span></div>
<div class="row"><span class="row-k">ETH Price</span><span class="row-v">$${cachedETHPrice.usd} [CG:$${cachedETHPrice.cg_usd||"—"} BN:$${cachedETHPrice.bn_usd||"—"}]</span></div>
</div>${txHtml}`));
    } catch(e){res.send(pageShell("Error",`<div class="err-box"><h2>Error</h2><p>${e.message}</p></div>`));}
});

// ── /address/:addr ─────────────────────────────────────────────
app.get("/address/:address", async (req,res) => {
    const addr=req.params.address;
    try {
        const [balance,txCount,code]=await Promise.all([provider.getBalance(addr),provider.getTransactionCount(addr),provider.getCode(addr)]);
        const ethBal=ethers.formatEther(balance); const isContract=code!=="0x";
        let tokenBal="0"; if(SUSDC.address){try{const c=new ethers.Contract(SUSDC.address,["function balanceOf(address) view returns (uint256)"],provider);tokenBal=ethers.formatUnits(await c.balanceOf(addr),SUSDC.decimals);}catch{}}
        let txsHtml=""; try{const r=await db.query("SELECT * FROM transactions WHERE LOWER(from_address)=LOWER($1) OR LOWER(to_address)=LOWER($1) ORDER BY block_number DESC LIMIT 20",[addr]);if(r.rows.length){txsHtml=`<div class="card" style="margin-top:20px"><div class="card-head">Transactions</div><table class="logs-table"><thead><tr><th>Hash</th><th>Block</th><th>From</th><th>To</th><th>Value</th><th>Status</th></tr></thead><tbody>`;r.rows.forEach(tx=>{const v=tx.value?parseFloat(ethers.formatEther(BigInt(tx.value||"0"))).toFixed(4):"0";txsHtml+=`<tr><td><a href="/tx/${tx.hash}">${tx.hash.slice(0,14)}…</a></td><td><a href="/block/${tx.block_number}">#${tx.block_number}</a></td><td><a href="/address/${tx.from_address}">${tx.from_address?.slice(0,12)}…</a></td><td><a href="/address/${tx.to_address||""}">${tx.to_address?.slice(0,12)||"—"}…</a></td><td>${v} ETH</td><td><span class="pill ${tx.status==="success"?"pg":"pr"}">${tx.status||"—"}</span></td></tr>`;});txsHtml+=`</tbody></table></div>`;}}catch{}
        const chainHex="0x"+parseInt(CHAIN_ID).toString(16).toUpperCase();
        res.send(pageShell("Address "+addr.slice(0,14)+"…",`
<div class="title">${isContract?"📄 Contract":"🏦 Address"}</div><div class="subtitle">${addr}</div>
<div class="card"><div class="card-head">Overview</div>
<div class="row"><span class="row-k">Address</span><span class="row-v">${addr}</span></div>
<div class="row"><span class="row-k">ETH Balance</span><span class="row-v">${parseFloat(ethBal).toFixed(8)} ETH ($${(parseFloat(ethBal)*cachedETHPrice.usd).toFixed(2)})</span></div>
<div class="row"><span class="row-k">sUSDC Balance</span><span class="row-v">${parseFloat(tokenBal).toLocaleString()} sUSDC</span></div>
<div class="row"><span class="row-k">Tx Count</span><span class="row-v">${txCount}</span></div>
</div>
<div class="card" style="margin-top:20px"><div class="card-head">💸 Send ETH (via MetaMask)</div>
<div style="padding:20px">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">To Address</label><input id="send-to" type="text" placeholder="0x…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:11px"/></div>
<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Amount (ETH)</label><input id="send-amt" type="number" placeholder="0.01" step="0.001" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:11px"/></div>
</div>
<button onclick="sendEthMM('${addr}')" style="padding:10px 20px;background:#0784c3;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">Send via MetaMask →</button>
<div id="send-status" style="margin-top:8px;font-family:var(--mono);font-size:11px;color:var(--muted)"></div>
</div></div>${txsHtml}
<script>
async function sendEthMM(from){
  if(!window.ethereum){document.getElementById('send-status').textContent='MetaMask not found';return;}
  var to=document.getElementById('send-to').value.trim();
  var amt=document.getElementById('send-amt').value.trim();
  if(!to||to.length!==42){document.getElementById('send-status').textContent='❌ Invalid address';return;}
  if(!amt||parseFloat(amt)<=0){document.getElementById('send-status').textContent='❌ Invalid amount';return;}
  document.getElementById('send-status').textContent='⏳ Opening MetaMask…';
  try{
    await window.ethereum.request({method:'eth_requestAccounts'});
    var cur=await window.ethereum.request({method:'eth_chainId'});
    if(cur.toLowerCase()!=='${chainHex}'.toLowerCase()){
      try{await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'${chainHex}'}]});}
      catch(e){if(e.code===4902)await window.ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'${chainHex}',chainName:'OpenClaw Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['${PUBLIC_RPC_URL}'],blockExplorerUrls:['${PROTOCOL}://${EXPLORER_DOMAIN}']}]});}
    }
    var value='0x'+BigInt(Math.round(parseFloat(amt)*1e18)).toString(16);
    var tx=await window.ethereum.request({method:'eth_sendTransaction',params:[{from,to,value,gas:'0x5208'}]});
    document.getElementById('send-status').innerHTML='✅ TX: <a href="/tx/'+tx+'">'+tx.slice(0,22)+'…</a>';
  }catch(e){document.getElementById('send-status').textContent='❌ '+e.message;}
}
</script>`));
    }catch(e){res.send(pageShell("Error",`<div class="err-box"><h2>Error</h2><p>${e.message}</p></div>`));}
});

// ══════════════════════════════════════════════════════════════
//  BRIDGE API ROUTES
// ══════════════════════════════════════════════════════════════
app.get("/api/v1/bridge/config", (req,res) => {
    res.json({ direction:"private_to_mainnet", bypass_l2:true, src:{chain_id:CHAIN_ID,name:"OpenClaw Private Chain",rpc:PUBLIC_RPC_URL,p2p_port:P2P_PORT}, dst:{chain_id:MAINNET_CHAIN_ID,name:"Ethereum Mainnet",rpc:ETH_MAINNET_RPC_URL}, bridge_address:PRIVATE_BRIDGE_ADDRESS, deployed:!!PRIVATE_BRIDGE_ADDRESS, fee_eth:bridgeStats.fee, balance_eth:bridgeStats.balance, total_requests:bridgeStats.totalRequests, dual_oracle:true, note:"Direct Private→Mainnet bridge — no Optimism L2 hop", nginx_domain:NGINX_DOMAIN, p2p_port:P2P_PORT });
});

app.get("/api/v1/bridge/stats", async (req,res) => {
    try {
        const [total,pending,completed,totalETH,oracleRows]=await Promise.all([
            db.query("SELECT COUNT(*) FROM bridge_requests WHERE direction='private_to_mainnet'").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT COUNT(*) FROM bridge_requests WHERE direction='private_to_mainnet' AND status='pending'").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT COUNT(*) FROM bridge_requests WHERE direction='private_to_mainnet' AND status='completed'").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT SUM(amount_eth::numeric) as total FROM bridge_requests WHERE direction='private_to_mainnet'").catch(()=>({rows:[{total:0}]})),
            db.query("SELECT private_avg_usd,mainnet_avg_usd,price_delta_usd,fetched_at FROM bridge_price_oracle WHERE direction='private_to_mainnet' ORDER BY fetched_at DESC LIMIT 1").catch(()=>({rows:[]})),
        ]);
        const latest=oracleRows.rows[0]||null;
        res.json({ direction:"private_to_mainnet", bypass_l2:true, bridge_address:PRIVATE_BRIDGE_ADDRESS, total_requests:parseInt(total.rows[0].count), pending:parseInt(pending.rows[0].count), completed:parseInt(completed.rows[0].count), total_eth_bridged:parseFloat(totalETH.rows[0].total||0).toFixed(4), eth_price_private:cachedETHPrice.usd, eth_price_mainnet:cachedETHPrice.usd, eth_price_source:cachedETHPrice.source, cg_usd:cachedETHPrice.cg_usd, bn_usd:cachedETHPrice.bn_usd, latest_oracle:latest });
    } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/v1/bridge/requests", async (req,res) => {
    const limit=parseInt(req.query.limit||"20");
    try {
        const r=await db.query("SELECT * FROM bridge_requests ORDER BY inserted_at DESC LIMIT $1",[limit]);
        res.json({ requests:r.rows, count:r.rows.length, eth_price_private:cachedETHPrice.usd, eth_price_mainnet:cachedETHPrice.usd, cg_usd:cachedETHPrice.cg_usd, bn_usd:cachedETHPrice.bn_usd });
    } catch(e){const arr=Array.from(bridgeCache.values()).slice(-limit).reverse();res.json({requests:arr,count:arr.length,eth_price:cachedETHPrice.usd,source:"memory_cache"});}
});

app.post("/api/v1/bridge/lock", async (req,res) => {
    const {recipient,amount_eth,private_key}=req.body;
    if (!recipient||!amount_eth) return res.status(400).json({error:"recipient + amount_eth required"});
    if (!bridgeContract) return res.status(503).json({error:"Bridge not deployed — set PRIVATE_BRIDGE_ADDRESS in .env"});
    try {
        const wallet=new ethers.Wallet(private_key||DEPLOYER_PRIVATE_KEY,provider);
        const value =ethers.parseEther(String(amount_eth));
        const balance=await provider.getBalance(wallet.address);
        if(balance<value)return res.status(400).json({error:`Insufficient: ${ethers.formatEther(balance)} ETH`});
        const tx=await bridgeContract.connect(wallet).lockETH(recipient,{value});
        await tx.wait();
        res.json({success:true,tx_hash:tx.hash,from:wallet.address,recipient,amount_eth,direction:"private_to_mainnet",explorer_url:`${PROTOCOL}://${EXPLORER_DOMAIN}/tx/${tx.hash}`});
    }catch(e){res.status(500).json({error:e.message});}
});

// Bridge Price Oracle routes
app.get("/api/v1/bridge-price", (req,res) => {
    const all={};
    for(const[a,e]of bridgePriceOracle.entries())all[a]=e;
    res.json({oracle_count:bridgePriceOracle.size,shared_eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,bridge_address:PRIVATE_BRIDGE_ADDRESS,addresses:all,note:"On-demand dual oracle: CoinGecko+Binance fetched at exact ETHLocked event time on BOTH chains"});
});

app.get("/api/v1/bridge-price/:address", async (req,res) => {
    const addr=req.params.address.toLowerCase();
    const cached=bridgePriceOracle.get(addr);
    if(cached)return res.json(cached);
    try{const live=await fetchBridgeOraclePrice(req.params.address,"private_to_mainnet");return res.json({...live,note:"live fetch — no prior bridge tx on this address"});}
    catch(e){return res.status(404).json({error:e.message});}
});

app.get("/api/v1/bridge-price/:address/history", async (req,res) => {
    const addr=req.params.address.toLowerCase(); const limit=Math.min(parseInt(req.query.limit||"50"),200);
    try{const r=await db.query(`SELECT * FROM bridge_price_oracle WHERE bridge_address=$1 ORDER BY fetched_at DESC LIMIT $2`,[addr,limit]);res.json({bridge_address:req.params.address,latest:bridgePriceOracle.get(addr)||null,history:r.rows,count:r.rows.length});}
    catch(e){res.json({bridge_address:req.params.address,latest:bridgePriceOracle.get(addr)||null,history:[],db_error:e.message});}
});

// ══════════════════════════════════════════════════════════════
//  NGINX CONFIG API
// ══════════════════════════════════════════════════════════════
app.get("/api/v1/nginx", (req,res) => res.json(NGINX_CONFIG));

// ══════════════════════════════════════════════════════════════
//  P2P API
// ══════════════════════════════════════════════════════════════
app.get("/api/v1/p2p", async (req,res) => { await pollP2PPeers(); res.json({port:P2P_PORT,peer_count:p2pPeers.length,peers:p2pPeers,self:p2pSelf,chain_id:CHAIN_ID,host:VPS_IP,reverse_routes:NGINX_CONFIG.reverse_routes,note:"Port 30303 TCP+UDP direct — not proxied"}); });
app.post("/api/v1/p2p/peer",(req,res)=>{const{enode,action}=req.body;if(!enode)return res.status(400).json({error:"enode required"});const method=action==="remove"?"admin_removePeer":"admin_addPeer";fetch(GETH_ADMIN_RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method,params:[enode],id:1}),signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(d=>res.json({success:d.result===true,enode,action:action||"add"})).catch(e=>res.status(500).json({error:e.message}));});

// ══════════════════════════════════════════════════════════════
//  ETH TRANSFER API
// ══════════════════════════════════════════════════════════════
app.post("/api/v1/transfer", async (req,res) => {
    const{to,amount_eth,private_key}=req.body;
    if(!to||!amount_eth)return res.status(400).json({error:"to + amount_eth required"});
    try{const wallet=new ethers.Wallet(private_key||DEPLOYER_PRIVATE_KEY,provider);const value=ethers.parseEther(String(amount_eth));const b=await provider.getBalance(wallet.address);if(b<value)return res.status(400).json({error:`Insufficient: ${ethers.formatEther(b)} ETH`});const feeData=await provider.getFeeData();const tx=await wallet.sendTransaction({to,value,gasLimit:21000n,gasPrice:feeData.gasPrice});const receipt=await tx.wait();broadcast({type:"new_transfer",hash:tx.hash,from:wallet.address,to,value_eth:amount_eth,block:receipt.blockNumber});res.json({success:true,tx_hash:tx.hash,from:wallet.address,to,amount_eth,block_number:receipt.blockNumber,explorer_url:`${PROTOCOL}://${EXPLORER_DOMAIN}/tx/${tx.hash}`});}
    catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/v1/transfer/estimate",async(req,res)=>{try{const f=await provider.getFeeData();const fee=21000n*(f.gasPrice||1n);res.json({gas_limit:"21000",gas_price_gwei:f.gasPrice?(Number(f.gasPrice)/1e9).toFixed(4):"0",estimated_fee_eth:ethers.formatEther(fee),estimated_fee_usd:(parseFloat(ethers.formatEther(fee))*cachedETHPrice.usd).toFixed(6)});}catch(e){res.status(500).json({error:e.message});}});

// ══════════════════════════════════════════════════════════════
//  TOKEN BRIDGE API — sUSDC (Private) → USDT (Mainnet) DIRECT
// ══════════════════════════════════════════════════════════════
app.get("/api/v1/usdt-price", async(req,res) => {
    const p = await fetchUSDTPrice().catch(()=>cachedUSDTPrice);
    // Fetch balances on both chains simultaneously
    const [privBal, mainBal] = await Promise.allSettled([
        SUSDC_PRIVATE_ADDRESS&&provider ? new ethers.Contract(SUSDC_PRIVATE_ADDRESS,ERC20_ABI,provider).totalSupply().then(s=>ethers.formatUnits(s,6)) : Promise.resolve("—"),
        USDT_MAINNET_ADDRESS&&mainnetProvider ? new ethers.Contract(USDT_MAINNET_ADDRESS,ERC20_ABI,mainnetProvider).totalSupply().then(s=>ethers.formatUnits(s,6)) : Promise.resolve("—"),
    ]);
    res.json({
        usdt: { ...p, mainnet_address:USDT_MAINNET_ADDRESS, chain_id:MAINNET_CHAIN_ID, total_supply:mainBal.status==="fulfilled"?mainBal.value:"—" },
        susdc:{ address:SUSDC_PRIVATE_ADDRESS, symbol:"sUSDC", chain_id:CHAIN_ID, price_usd:"1.000000", total_supply:privBal.status==="fulfilled"?privBal.value:"—" },
        oracle_note:"CoinGecko + Binance fetched simultaneously on both chains",
    });
});

app.get("/api/v1/token-bridge/config", (req,res) => res.json({
    deployed: !!TOKEN_BRIDGE_ADDRESS,
    bridge_address: TOKEN_BRIDGE_ADDRESS,
    src_token: { address:SUSDC_PRIVATE_ADDRESS, symbol:"sUSDC", chain_id:CHAIN_ID, decimals:6 },
    dst_token: { address:USDT_MAINNET_ADDRESS,  symbol:"USDT",  chain_id:MAINNET_CHAIN_ID, decimals:6 },
    direction: "susdc_to_usdt",
    mechanism: "Lock sUSDC on private chain → Relayer sends USDT on Ethereum Mainnet (direct, no L2, no reserve)",
    oracle: "CoinGecko + Binance price fetched simultaneously on both chains at event time",
}));

app.get("/api/v1/token-bridge/stats", async(req,res) => {
    try {
        const [total,pending,completed,totalTokens,latestOracle] = await Promise.all([
            db.query("SELECT COUNT(*) FROM token_bridge_requests").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT COUNT(*) FROM token_bridge_requests WHERE status='pending'").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT COUNT(*) FROM token_bridge_requests WHERE status='completed'").catch(()=>({rows:[{count:0}]})),
            db.query("SELECT SUM(amount_tokens::numeric) FROM token_bridge_requests").catch(()=>({rows:[{sum:0}]})),
            db.query("SELECT * FROM token_bridge_price_oracle ORDER BY fetched_at DESC LIMIT 1").catch(()=>({rows:[]})),
        ]);
        const [privBal, mainBal] = await Promise.allSettled([
            SUSDC_PRIVATE_ADDRESS&&provider ? new ethers.Contract(SUSDC_PRIVATE_ADDRESS,ERC20_ABI,provider).totalSupply().then(s=>ethers.formatUnits(s,6)) : Promise.resolve("—"),
            USDT_MAINNET_ADDRESS&&mainnetProvider ? new ethers.Contract(USDT_MAINNET_ADDRESS,ERC20_ABI,mainnetProvider).totalSupply().then(s=>ethers.formatUnits(s,6)) : Promise.resolve("—"),
        ]);
        res.json({
            total_requests: parseInt(total.rows[0].count),
            pending:        parseInt(pending.rows[0].count),
            completed:      parseInt(completed.rows[0].count),
            total_tokens_bridged: parseFloat(totalTokens.rows[0].sum||0).toFixed(2),
            susdc_supply_private: privBal.status==="fulfilled"?privBal.value:"—",
            usdt_mainnet_supply: mainBal.status==="fulfilled"?mainBal.value:"—",
            usdt_price:     cachedUSDTPrice.usd,
            latest_oracle:  latestOracle.rows[0]||null,
        });
    } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/v1/token-bridge/requests", async(req,res) => {
    const limit = parseInt(req.query.limit||"20");
    try {
        const r = await db.query("SELECT * FROM token_bridge_requests ORDER BY inserted_at DESC LIMIT $1",[limit]);
        res.json({requests:r.rows, usdt_price:cachedUSDTPrice, count:r.rows.length});
    } catch {
        const arr = Array.from(tokenBridgeCache.values()).slice(-limit).reverse();
        res.json({requests:arr, count:arr.length, source:"memory_cache"});
    }
});

// Lock sUSDC via MetaMask (server constructs tx data, MetaMask signs)
app.get("/api/v1/token-bridge/lock-data", async(req,res) => {
    const {recipient, amount} = req.query;
    if (!recipient||!amount) return res.status(400).json({error:"recipient + amount required"});
    if (!TOKEN_BRIDGE_ADDRESS) return res.status(503).json({error:"TOKEN_BRIDGE_ADDRESS not set"});
    try {
        const iface = new ethers.Interface(TOKEN_BRIDGE_ABI);
        const amtWei = ethers.parseUnits(amount, 6);
        const data = iface.encodeFunctionData("lockTokens",[recipient,amtWei]);
        const oracle = await fetchTokenBridgeOraclePrice(TOKEN_BRIDGE_ADDRESS,"susdc_to_usdt",amount).catch(()=>null);
        res.json({
            to:TOKEN_BRIDGE_ADDRESS, data,
            approve_first:{ to:SUSDC_PRIVATE_ADDRESS, spender:TOKEN_BRIDGE_ADDRESS, amount:amtWei.toString() },
            amount_tokens:amount, recipient,
            estimated_usd:(parseFloat(amount)*cachedUSDTPrice.usd).toFixed(2),
            oracle,
        });
    } catch(e) { res.status(500).json({error:e.message}); }
});

// Token bridge oracle routes
app.get("/api/v1/token-bridge-oracle", (req,res) => {
    res.json({
        oracle_count: tokenBridgePriceOracle.size,
        usdt_price:   cachedUSDTPrice,
        susdc_address:SUSDC_PRIVATE_ADDRESS,
        usdt_address: USDT_MAINNET_ADDRESS,
        bridge_address:TOKEN_BRIDGE_ADDRESS,
        addresses: Object.fromEntries(tokenBridgePriceOracle),
    });
});

app.get("/api/v1/token-bridge-oracle/:address", async(req,res) => {
    const addr = req.params.address.toLowerCase();
    const cached = tokenBridgePriceOracle.get(addr);
    if (cached) return res.json(cached);
    const live = await fetchTokenBridgeOraclePrice(req.params.address,"susdc_to_usdt","0").catch(e=>({error:e.message}));
    res.json(live);
});

// Both chains balance check simultaneously
app.get("/api/v1/token-balance/both-chains", async(req,res) => {
    const addr = req.query.address;
    if (!addr) return res.status(400).json({error:"address required"});
    const [privR, mainR] = await Promise.allSettled([
        provider&&SUSDC_PRIVATE_ADDRESS ? new ethers.Contract(SUSDC_PRIVATE_ADDRESS,ERC20_ABI,provider).balanceOf(addr).then(b=>ethers.formatUnits(b,6)) : Promise.resolve("—"),
        mainnetProvider&&USDT_MAINNET_ADDRESS ? new ethers.Contract(USDT_MAINNET_ADDRESS,ERC20_ABI,mainnetProvider).balanceOf(addr).then(b=>ethers.formatUnits(b,6)) : Promise.resolve("—"),
    ]);
    res.json({
        address: addr,
        private_chain: { token:"sUSDC", address:SUSDC_PRIVATE_ADDRESS, chain_id:CHAIN_ID, balance:privR.status==="fulfilled"?privR.value:"error" },
        mainnet:        { token:"USDT",  address:USDT_MAINNET_ADDRESS,  chain_id:MAINNET_CHAIN_ID, balance:mainR.status==="fulfilled"?mainR.value:"error" },
        usdt_price:     cachedUSDTPrice.usd,
        fetched_simultaneously: true,
    });
});

// ══════════════════════════════════════════════════════════════
//  wPETH API ROUTES — Wrapped Private ETH on Mainnet
// ══════════════════════════════════════════════════════════════
app.get("/api/v1/wpeth", async (req, res) => {
    await fetchWPETHStats();
    res.json({
        ...cachedWPETHData,
        eth_price_live: cachedETHPrice.usd,
        eth_cg_live:    cachedETHPrice.cg_usd,
        eth_bn_live:    cachedETHPrice.bn_usd,
        eth_source_live:cachedETHPrice.source,
        peg_ratio:      cachedWPETHData.eth_price_usd > 0
            ? (cachedWPETHData.eth_price_usd / cachedETHPrice.usd).toFixed(6)
            : "1.000000",
        deploy_cmd:    "node deploy.js --deploy-wpeth",
        mint_flow:     "Lock ETH on private chain → Relayer detects ETHLocked → Mints wPETH on Mainnet",
    });
});

app.get("/api/v1/wpeth/balance/:address", async (req, res) => {
    if (!WPETH_ADDRESS || !mainnetProvider) return res.status(503).json({error:"WPETH_ADDRESS not set — deploy with: node deploy.js --deploy-wpeth"});
    try {
        const _p2 = new ethers.JsonRpcProvider("https://virginia.rpc.blxrbdn.com");
        const wpeth = new ethers.Contract(WPETH_ADDRESS, WPETH_ABI, _p2);
        const [bal, valueUSD] = await Promise.all([
            wpeth.balanceOf(req.params.address),
            wpeth.getValueUSD(req.params.address),
        ]);
        const balETH = ethers.formatEther(bal);
        res.json({
            address:      req.params.address,
            wpeth_balance: balETH,
            value_usd:    Number(valueUSD).toFixed(2),
            eth_price:    cachedWPETHData.eth_price_usd || cachedETHPrice.usd,
            cg_usd:       cachedWPETHData.cg_usd,
            bn_usd:       cachedWPETHData.bn_usd,
            source:       cachedWPETHData.source,
            wpeth_address: WPETH_ADDRESS,
            etherscan:    `https://etherscan.io/token/${WPETH_ADDRESS}?a=${req.params.address}`,
            note:         `1 wPETH = 1 ETH = $${cachedETHPrice.usd}`,
        });
    } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/v1/wpeth/price", async (req, res) => {
    // Returns wPETH price tracking — same as ETH (CG + BN simultaneously)
    const live = await fetchDualPrice().catch(()=>null);
    res.json({
        wpeth_address:  WPETH_ADDRESS,
        symbol:         "wPETH",
        peg:            "1:1 with ETH",
        price_usd:      live?.avg || cachedETHPrice.usd,
        cg_usd:         live?.cg_usd || cachedETHPrice.cg_usd,
        bn_usd:         live?.bn_usd || cachedETHPrice.bn_usd,
        source:         live?.source || cachedETHPrice.source,
        on_chain_price: cachedWPETHData.eth_price_usd,
        on_chain_cg:    cachedWPETHData.cg_usd,
        on_chain_bn:    cachedWPETHData.bn_usd,
        updated_at:     new Date().toISOString(),
        note:           "wPETH price = ETH price. Oracle updated by relayer at each mint + every 60s",
    });
});

// ══════════════════════════════════════════════════════════════
//  STANDARD API ROUTES
// ══════════════════════════════════════════════════════════════
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/api/v1/eth-price",(req,res)=>res.json({symbol:"ETH",usd:cachedETHPrice.usd.toString(),cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,change_24h:cachedETHPrice.change_24h,high_24h:cachedETHPrice.high_24h,low_24h:cachedETHPrice.low_24h,updated_at:cachedETHPrice.updated_at,source:cachedETHPrice.source,chain_id:CHAIN_ID,history:priceHistory.slice(-20)}));
app.get("/api/v2/stats",async(req,res)=>{try{const bn=await provider.getBlockNumber();res.json({total_blocks:bn,coin_price:cachedETHPrice.usd.toString(),coin_price_change_percentage:cachedETHPrice.change_24h,gas_prices:{average:"1",fast:"2",slow:"1"},eth_price_updated_at:cachedETHPrice.updated_at,eth_price_source:cachedETHPrice.source});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/v2/tokens/:address",async(req,res)=>{const addr=req.params.address.toLowerCase();const price=tokenPrices[addr]||tokenPrices[req.params.address];try{const erc20=new ethers.Contract(req.params.address,["function name() view returns (string)","function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)"],provider);const[name,symbol,decimals,totalSupply]=await Promise.all([erc20.name().catch(()=>price?.name||SUSDC.name),erc20.symbol().catch(()=>price?.symbol||SUSDC.symbol),erc20.decimals().catch(()=>SUSDC.decimals),erc20.totalSupply().catch(()=>0n)]);const logoUrl=price?.logo_url||`${PROTOCOL}://${EXPLORER_DOMAIN}/images/tokens/${addr}.png`;res.json({address:req.params.address,name,symbol,decimals:decimals.toString(),total_supply:totalSupply.toString(),exchange_rate:price?.usd?.toFixed(6)||"1.000000",type:"ERC-20",logo_url:logoUrl,icon_url:logoUrl,image:logoUrl});}catch{const lu=price?.logo_url||`${PROTOCOL}://${EXPLORER_DOMAIN}/images/tokens/${addr}.png`;res.json({address:req.params.address,name:price?.name||SUSDC.name,symbol:price?.symbol||SUSDC.symbol,decimals:SUSDC.decimals.toString(),exchange_rate:price?.usd?.toFixed(6)||"1.000000",type:"ERC-20",logo_url:lu,icon_url:lu,image:lu});}});
app.get("/api/v2/tokens/:address/market-chart",(req,res)=>{const price=tokenPrices[req.params.address.toLowerCase()];const usd=price?.usd||1.0;const now=Date.now();const prices=[];for(let i=24;i>=0;i--)prices.push([now-(i*3600000),usd]);res.json({prices});});
app.get("/api/v1/tokens/:address",(req,res)=>{const price=tokenPrices[req.params.address.toLowerCase()];res.json({contract_address:req.params.address,symbol:price?.symbol||"sUSDC",name:price?.name||"Stablecoin USDC",decimals:price?.decimals||6,exchange_rate:price?.usd?.toFixed(6)||"1.000000",usd_price:price?.usd?.toFixed(6)||"1.000000",current_price:price?.usd||1.0,logo_url:price?.logo_url||""});});
app.get("/api/v1/network",(req,res)=>res.json({chain_id:CHAIN_ID,chain_id_hex:"0x"+parseInt(CHAIN_ID).toString(16).toUpperCase(),chain_name:process.env.CHAIN_NAME||"OpenClaw Chain",rpc_url:PUBLIC_RPC_URL,ws_url:PUBLIC_WS_URL,explorer_url:`${PROTOCOL}://${EXPLORER_DOMAIN}`,currency:{name:"Ether",symbol:"ETH",decimals:18},eth_logo:ETH_LOGO_URL,susdc_contract:SUSDC.address,nginx_domain:NGINX_DOMAIN,vps_ip:VPS_IP,p2p_port:P2P_PORT,mainnet_rpc:ETH_MAINNET_RPC_URL,bridge_address:PRIVATE_BRIDGE_ADDRESS}));
app.get("/api/chain",async(req,res)=>{try{const[bn,net]=await Promise.all([provider.getBlockNumber(),provider.getNetwork()]);res.json({chain_id:net.chainId.toString(),chain_name:process.env.CHAIN_NAME||"OpenClaw Chain",block_height:bn,rpc_url:RPC_URL,public_rpc:PUBLIC_RPC_URL,explorer_url:`${PROTOCOL}://${EXPLORER_DOMAIN}`,nginx_domain:NGINX_DOMAIN,vps_ip:VPS_IP,eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,eth_source:cachedETHPrice.source,p2p_peers:p2pPeers.length,p2p_port:P2P_PORT,bridge_address:PRIVATE_BRIDGE_ADDRESS,mainnet_rpc:ETH_MAINNET_RPC_URL});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/blocks",async(req,res)=>{const limit=parseInt(req.query.limit||"10");try{const latest=await provider.getBlockNumber();const blocks=[];for(let i=latest;i>Math.max(0,latest-limit);i--){const b=await provider.getBlock(i);if(b)blocks.push({number:b.number,hash:b.hash,timestamp:b.timestamp,tx_count:b.transactions.length,miner:b.miner,gas_used:b.gasUsed?.toString(),gas_limit:b.gasLimit?.toString()});}res.json({blocks,total:latest+1});}catch(e){try{const r=await db.query("SELECT * FROM blocks ORDER BY number DESC LIMIT $1",[limit]);res.json({blocks:r.rows,source:"database"});}catch{res.status(500).json({error:e.message});}}});
app.get("/api/blocks/:id",async(req,res)=>{try{const id=req.params.id;const b=await provider.getBlock(id.startsWith("0x")?id:parseInt(id),true);if(!b)return res.status(404).json({error:"Not found"});res.json({number:b.number,hash:b.hash,parent_hash:b.parentHash,timestamp:b.timestamp,miner:b.miner,tx_count:b.transactions.length,transactions:b.prefetchedTransactions?.map(t=>t.hash)||b.transactions,gas_used:b.gasUsed?.toString(),gas_limit:b.gasLimit?.toString()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/transactions/all",async(req,res)=>{const limit=parseInt(req.query.limit||"20");try{const r=await db.query(`SELECT hash,block_number,from_address,to_address,value,value_usd,gas_used,status,tx_type,timestamp FROM transactions ORDER BY block_number DESC LIMIT $1`,[limit]);const txs=r.rows.map(tx=>{const ev=tx.value?parseFloat(ethers.formatEther(BigInt(tx.value||"0"))).toFixed(6):"0";return{...tx,value_eth:ev,value_usd:tx.value_usd||"$"+(parseFloat(ev)*cachedETHPrice.usd).toFixed(2)};});res.json({transactions:txs,eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,count:txs.length});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/transactions/:hash",async(req,res)=>{try{const tx=await provider.getTransaction(req.params.hash);const rc=await provider.getTransactionReceipt(req.params.hash);if(!tx)return res.status(404).json({error:"Not found"});res.json({hash:tx.hash,block_number:tx.blockNumber,from:tx.from,to:tx.to,value:tx.value?.toString(),gas_price:tx.gasPrice?.toString(),nonce:tx.nonce,input:tx.data,status:rc?.status===1?"success":"failed",gas_used:rc?.gasUsed?.toString(),logs:rc?.logs?.length||0});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/address/:address",async(req,res)=>{try{const addr=req.params.address;const[balance,txCount,code]=await Promise.all([provider.getBalance(addr),provider.getTransactionCount(addr),provider.getCode(addr)]);const ethBal=ethers.formatEther(balance);let tokenBal="0";if(SUSDC.address){try{const c=new ethers.Contract(SUSDC.address,["function balanceOf(address) view returns (uint256)"],provider);tokenBal=ethers.formatUnits(await c.balanceOf(addr),SUSDC.decimals);}catch{}}res.json({address:addr,balance_eth:ethBal,balance_usd:(parseFloat(ethBal)*cachedETHPrice.usd).toFixed(2),eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,tx_count:txCount,is_contract:code!=="0x",token_balances:SUSDC.address?[{token:SUSDC.address,symbol:SUSDC.symbol,balance:tokenBal}]:[]});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/stats/db",async(req,res)=>{try{const[blocks,txs,prices,bReqs,oracle]=await Promise.all([db.query("SELECT COUNT(*) FROM blocks").catch(()=>({rows:[{count:"—"}]})),db.query("SELECT COUNT(*) FROM transactions").catch(()=>({rows:[{count:"—"}]})),db.query("SELECT * FROM token_prices").catch(()=>({rows:[]})),db.query("SELECT direction,status,COUNT(*) FROM bridge_requests GROUP BY direction,status").catch(()=>({rows:[]})),db.query("SELECT bridge_address,COUNT(*) as events,MAX(fetched_at) as last_fetch FROM bridge_price_oracle GROUP BY bridge_address").catch(()=>({rows:[]}))]);res.json({blocks:blocks.rows[0].count,transactions:txs.rows[0].count,token_prices:prices.rows,bridge_requests:bReqs.rows,bridge_oracle:oracle.rows,eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,eth_source:cachedETHPrice.source,p2p_peers:p2pPeers.length,nginx_domain:NGINX_DOMAIN});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/contracts/verify",async(req,res)=>{const{address,source_code,contract_name,compiler_version,optimization}=req.body;if(!address||!source_code||!contract_name)return res.status(400).json({error:"address, source_code, contract_name required"});try{await db.query(`INSERT INTO verified_contracts (address,contract_name,source_code,compiler_version,optimization,verified_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (address) DO UPDATE SET source_code=EXCLUDED.source_code,verified_at=NOW()`,[address,contract_name,source_code,compiler_version||"0.8.20",optimization!==false]);res.json({success:true,address,contract_name});}catch{res.json({success:true,address,contract_name,note:"cached"});}});
app.get("/api/v1/exchange-rates",(req,res)=>{const rates={};for(const[addr,t]of Object.entries(tokenPrices)){rates[addr]={usd:t.usd,cg_source:cachedETHPrice.cg_usd,bn_source:cachedETHPrice.bn_usd,last_updated_at:Math.floor(Date.now()/1000),logo_url:t.logo_url};}res.json(rates);});

// ── Admin ──────────────────────────────────────────────────────
function requireAdmin(req,res,next){if((req.headers["x-admin-key"]||req.body?.admin_key)!==ADMIN_API_KEY)return res.status(401).json({error:"Unauthorized"});next();}
app.post("/admin/tokens/price",requireAdmin,(req,res)=>{const{address,price_usd,symbol,name}=req.body;if(!address||!price_usd)return res.status(400).json({error:"address + price_usd required"});const addr=address.toLowerCase();tokenPrices[addr]={...(tokenPrices[addr]||{}),symbol:symbol||"TOKEN",name:name||"Token",usd:parseFloat(price_usd),decimals:tokenPrices[addr]?.decimals||18,updated_at:new Date().toISOString()};broadcast({type:"price_update",address:addr,price_usd});res.json({success:true,address:addr,price_usd:tokenPrices[addr].usd.toFixed(6)});});
app.post("/admin/tokens/add",requireAdmin,(req,res)=>{const{address,symbol,name,price_usd,decimals,logo_url}=req.body;if(!address)return res.status(400).json({error:"address required"});const addr=address.toLowerCase();tokenPrices[addr]={symbol:symbol||"TOKEN",name:name||"Token",usd:parseFloat(price_usd||"0"),decimals:parseInt(decimals||"18"),logo_url:logo_url||"",updated_at:new Date().toISOString()};res.json({success:true,token:tokenPrices[addr]});});
app.get("/admin/tokens",requireAdmin,(req,res)=>res.json({tokens:tokenPrices,count:Object.keys(tokenPrices).length}));
app.get("/admin/stats",requireAdmin,async(req,res)=>{try{const[b,t]=await Promise.all([db.query("SELECT COUNT(*) FROM blocks"),db.query("SELECT COUNT(*) FROM transactions")]);res.json({blocks:b.rows[0].count,transactions:t.rows[0].count,eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,eth_source:cachedETHPrice.source,uptime:process.uptime(),p2p_peers:p2pPeers.length,nginx_domain:NGINX_DOMAIN,bridge_address:PRIVATE_BRIDGE_ADDRESS,bridge_oracle_tracked:bridgePriceOracle.size});}catch(e){res.json({error:e.message,uptime:process.uptime()});}});

// ── Transfer UI ────────────────────────────────────────────────
app.get("/transfer",(req,res)=>{const hex="0x"+parseInt(CHAIN_ID).toString(16).toUpperCase();res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>ETH Transfer — OpenClaw</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}.w{width:480px;padding:20px}.back{font-family:monospace;font-size:11px;color:#4b5563;text-decoration:none;display:inline-flex;align-items:center;gap:6px;margin-bottom:16px}.card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:32px}.t{font-size:18px;font-weight:700;margin-bottom:4px}.s{font-size:11px;color:#6b7280;margin-bottom:24px}.f{margin-bottom:12px}label{display:block;font-size:11px;color:#9ca3af;margin-bottom:5px}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #374151;background:#0f172a;color:#fff;font-size:14px;font-family:monospace}.btn{width:100%;padding:14px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}.b{background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff}.g{background:linear-gradient(135deg,#10b981,#059669);color:#fff}#st{margin-top:14px;padding:11px 14px;border-radius:8px;font-size:12px;display:none}#st.ok{background:#064e3b;color:#6ee7b7}#st.err{background:#450a0a;color:#fca5a5}#st.info{background:#1e3a5f;color:#93c5fd}</style></head><body><div class="w"><a class="back" href="/">← Explorer</a><div class="card"><div class="t">💸 ETH Transfer</div><div class="s">OpenClaw Chain · ID ${CHAIN_ID} · ${NGINX_DOMAIN}</div><div class="f"><button class="btn b" onclick="c()">Connect MetaMask</button></div><div id="bal" style="font-family:monospace;font-size:11px;color:#9ca3af;margin-bottom:12px"></div><div class="f"><label>From (auto)</label><input id="from" readonly/></div><div class="f"><label>To Address</label><input id="to" placeholder="0x…"/></div><div class="f"><label>Amount (ETH)</label><input id="amt" type="number" placeholder="0.01" step="0.001" oninput="e()"/></div><div id="est" style="font-family:monospace;font-size:10px;color:#6b7280;margin-bottom:12px">≈ $— USD · Gas: ~21,000</div><button class="btn g" onclick="s()">Send ETH →</button><div id="st"></div></div></div>
<script>
var p=0,u='';fetch('/api/v1/eth-price').then(r=>r.json()).then(d=>{p=parseFloat(d.usd);});
function st(m,t){var e=document.getElementById('st');e.innerHTML=m;e.className=t;e.style.display='block';}
function e(){var a=parseFloat(document.getElementById('amt').value)||0;document.getElementById('est').textContent='≈ $'+(a*p).toFixed(2)+' USD · Gas: ~21,000';}
async function c(){if(!window.ethereum){st('MetaMask not found','err');return;}var acc=await window.ethereum.request({method:'eth_requestAccounts'});u=acc[0];document.getElementById('from').value=u;var b=await window.ethereum.request({method:'eth_getBalance',params:[u,'latest']});document.getElementById('bal').textContent='Balance: '+(parseInt(b,16)/1e18).toFixed(6)+' ETH';var cur=await window.ethereum.request({method:'eth_chainId'});if(cur.toLowerCase()!=='${hex}'.toLowerCase()){try{await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'${hex}'}]});}catch(e){if(e.code===4902)await window.ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'${hex}',chainName:'OpenClaw Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['${PUBLIC_RPC_URL}'],blockExplorerUrls:['${PROTOCOL}://${EXPLORER_DOMAIN}']}]});}}st('✅ Connected: '+u.slice(0,14)+'…','ok');}
async function s(){if(!u){st('Connect MetaMask first','err');return;}var to=document.getElementById('to').value.trim();var amt=document.getElementById('amt').value;if(!to||to.length!==42){st('❌ Invalid address','err');return;}if(!amt||parseFloat(amt)<=0){st('❌ Invalid amount','err');return;}st('⏳ Review in MetaMask…','info');try{var value='0x'+BigInt(Math.round(parseFloat(amt)*1e18)).toString(16);var tx=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:u,to:to,value:value,gas:'0x5208'}]});st('✅ Sent! <a href="/tx/'+tx+'" style="color:#6ee7b7">View TX</a>','ok');}catch(e){st('❌ '+e.message,'err');}}
</script></body></html>`);});

// ── Health ─────────────────────────────────────────────────────
app.get("/health",async(req,res)=>{let dbOk=false,rpcOk=false,mainnetOk=false;try{await db.query("SELECT 1");dbOk=true;}catch{}try{await provider.getBlockNumber();rpcOk=true;}catch{}try{await mainnetProvider.getBlockNumber();mainnetOk=true;}catch{}res.json({status:"ok",db:dbOk?"connected":"unavailable",rpc_private:rpcOk?"connected":"unavailable",rpc_mainnet:mainnetOk?"connected":"unavailable",uptime:process.uptime(),chain_id:CHAIN_ID,mainnet_chain_id:MAINNET_CHAIN_ID,eth_price:cachedETHPrice.usd,cg_usd:cachedETHPrice.cg_usd,bn_usd:cachedETHPrice.bn_usd,eth_source:cachedETHPrice.source,nginx_domain:NGINX_DOMAIN,vps_ip:VPS_IP,p2p_port:P2P_PORT,p2p_peers:p2pPeers.length,bridge_address:PRIVATE_BRIDGE_ADDRESS,bridge_oracle_tracked:bridgePriceOracle.size});});

// ── Start ──────────────────────────────────────────────────────
initTokenPrices();
db.connect().then(()=>console.log("✅ PostgreSQL connected")).catch(e=>console.warn("⚠  PostgreSQL:",e.message));
server.listen(PORT,"0.0.0.0",async()=>{
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  OpenClaw Explorer · server.js                       ║`);
    console.log(`║  Local:    http://localhost:${PORT}                       ║`);
    console.log(`║  Public:   ${PROTOCOL}://${NGINX_DOMAIN}:3000`.padEnd(55)+"║");
    console.log(`║  Chain:    ${CHAIN_ID} → Mainnet (no L2)`.padEnd(55)+"║");
    console.log(`║  P2P:      :${P2P_PORT} · RPC: ${ETH_MAINNET_RPC_URL.slice(0,28)}`.padEnd(55)+"║");
    console.log(`║  Bridge:   ${(PRIVATE_BRIDGE_ADDRESS||"not deployed").slice(0,42).padEnd(43)}║`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  NEW: Dual Oracle (CG+BN) on BOTH chains per tx      ║`);
    console.log(`║  NEW: /api/v1/bridge/* · /api/v1/bridge-price/*      ║`);
    console.log(`║  NEW: /api/v1/nginx · /api/v1/p2p reverse routes     ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
    await migrateDB();
    fetchLiveETHPrice();
    await initBridge();
    fetchWPETHStats();
    await initTokenBridge();
    fetchUSDTPrice();
});
