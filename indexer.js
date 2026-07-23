require("dotenv").config();
const { ethers } = require("ethers");
const { Pool }   = require("pg");

const SUSDC_ADDRESS        = process.env.SUSDC_CONTRACT_ADDRESS || "0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8";
const USDT_MAINNET_ADDRESS  = process.env.USDT_MAINNET_ADDRESS    || "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TOKEN_BRIDGE_ADDRESS  = process.env.TOKEN_BRIDGE_ADDRESS    || null;
const WPETH_ADDRESS         = process.env.WPETH_ADDRESS            || null;

const WPETH_EVENTS_ABI = [
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
    "event Burned(address indexed from, uint256 amount, string privateRecipient)",
    "event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function getStats() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,string)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
];
const SUSDC_PRICE_USD      = parseFloat(process.env.SUSDC_PRICE_USD || "1.000000");
const RPC_URL              = process.env.RPC_URL || "http://localhost:8545";
const ETH_MAINNET_RPC_URL  = process.env.ETH_MAINNET_RPC_URL || "https://virginia.rpc.blxrbdn.com";
const P2P_PORT             = parseInt(process.env.P2P_PORT || "30303");
const GETH_ADMIN_RPC       = process.env.GETH_ADMIN_RPC || "http://localhost:8545";
const NGINX_DOMAIN         = process.env.NGINX_DOMAIN || "ai-private.online";
const VPS_IP               = process.env.VPS_IP || "68.183.30.13";
const CHAIN_ID             = process.env.CHAIN_ID || "123456";
const MAINNET_CHAIN_ID     = 1;
const PRIVATE_BRIDGE_ADDRESS = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS || null;

const provider = new ethers.JsonRpcProvider(RPC_URL);
let mainnetProvider = null;
try { mainnetProvider = new ethers.JsonRpcProvider(ETH_MAINNET_RPC_URL); console.log("✅ Mainnet RPC:", ETH_MAINNET_RPC_URL); }
catch(e) { console.warn("⚠  Mainnet RPC:", e.message); }

const db = new Pool({
    host:     process.env.POSTGRES_HOST     || "localhost",
    port:     parseInt(process.env.POSTGRES_PORT || "5432"),
    user:     process.env.POSTGRES_USER     || "blockscout",
    password: process.env.POSTGRES_PASSWORD || "susdc_secure_2024",
    database: process.env.POSTGRES_DB       || "blockscout",
    max: 5, idleTimeoutMillis: 30000,
});

// State
let ETH_PRICE_PRIVATE = 1865.51, ETH_PRICE_MAINNET = 1865.51;
let CG_PRICE = null, BN_PRICE = null;
let priceSource = "cached", p2pPeerCount = 0, mainnetBlockNum = null;

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
            CREATE TABLE IF NOT EXISTS p2p_stats (
                port INT PRIMARY KEY, peer_count INT DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS wpeth_events (
                id SERIAL PRIMARY KEY,
                event_type   TEXT NOT NULL,
                tx_hash      TEXT,
                block_number BIGINT,
                address      TEXT,
                amount_wei   TEXT,
                amount_eth   NUMERIC(36,18),
                request_id   TEXT,
                eth_price_usd NUMERIC(18,2),
                cg_price_usd  NUMERIC(18,2),
                bn_price_usd  NUMERIC(18,2),
                price_source  TEXT,
                network      TEXT DEFAULT 'mainnet',
                timestamp    BIGINT,
                inserted_at  TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_wpeth_type    ON wpeth_events (event_type);
            CREATE INDEX IF NOT EXISTS idx_wpeth_address ON wpeth_events (address);
            CREATE TABLE IF NOT EXISTS token_bridge_requests (
                id SERIAL PRIMARY KEY, request_id TEXT UNIQUE,
                sender TEXT, recipient TEXT,
                amount_tokens TEXT, amount_usd NUMERIC(18,2),
                src_token TEXT, dst_token TEXT,
                status TEXT DEFAULT 'pending', direction TEXT DEFAULT 'susdc_to_usdt',
                src_chain_id TEXT, dst_chain_id TEXT, bridge_address TEXT,
                usdt_price_cg NUMERIC(18,6), usdt_price_bn NUMERIC(18,6), usdt_price_avg NUMERIC(18,6),
                oracle_fetched_at TIMESTAMP,
                src_tx_hash TEXT, dst_tx_hash TEXT,
                timestamp BIGINT, inserted_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS token_bridge_price_oracle (
                id SERIAL PRIMARY KEY, bridge_address TEXT, direction TEXT,
                src_token TEXT, dst_token TEXT, src_chain_id TEXT, dst_chain_id TEXT,
                private_eth_cg NUMERIC(18,2), private_eth_bn NUMERIC(18,2),
                mainnet_eth_cg NUMERIC(18,2), mainnet_eth_bn NUMERIC(18,2),
                usdt_cg_usd NUMERIC(18,6), usdt_bn_usd NUMERIC(18,6), usdt_avg_usd NUMERIC(18,6),
                amount_tokens TEXT, amount_usd NUMERIC(18,2), fetched_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS mainnet_stats (
                chain_id INT PRIMARY KEY, block_number BIGINT,
                eth_price_usd NUMERIC(18,2), cg_usd NUMERIC(18,2), bn_usd NUMERIC(18,2),
                price_source TEXT, updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS bridge_requests (
                id SERIAL PRIMARY KEY,
                request_id    TEXT UNIQUE,
                sender        TEXT,
                recipient     TEXT,
                amount_wei    TEXT,
                amount_eth    NUMERIC(36,18),
                amount_usd    NUMERIC(18,2),
                status        TEXT DEFAULT 'pending',
                direction     TEXT DEFAULT 'private_to_mainnet',
                src_chain_id  TEXT,
                dst_chain_id  TEXT,
                src_tx_hash   TEXT,
                dst_tx_hash   TEXT,
                bridge_address TEXT,
                eth_price_usd_private NUMERIC(18,2),
                eth_price_usd_mainnet NUMERIC(18,2),
                eth_price_source_priv TEXT,
                eth_price_source_main TEXT,
                cg_price_private  NUMERIC(18,2),
                bn_price_private  NUMERIC(18,2),
                cg_price_mainnet  NUMERIC(18,2),
                bn_price_mainnet  NUMERIC(18,2),
                oracle_fetched_at TIMESTAMP,
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
            CREATE INDEX IF NOT EXISTS idx_tx_from     ON transactions (from_address);
            CREATE INDEX IF NOT EXISTS idx_tx_to       ON transactions (to_address);
            CREATE INDEX IF NOT EXISTS idx_tx_block    ON transactions (block_number DESC);
            CREATE INDEX IF NOT EXISTS idx_br_dir      ON bridge_requests (direction);
            CREATE INDEX IF NOT EXISTS idx_bpo_addr    ON bridge_price_oracle (bridge_address);
            CREATE INDEX IF NOT EXISTS idx_bpo_fetched ON bridge_price_oracle (fetched_at DESC);
        `);
        const cols=[["transactions","value_usd","TEXT"],["transactions","gas_fee_usd","TEXT"],["transactions","tx_type","TEXT DEFAULT 'ETH'"],["transactions","input_data","TEXT"],["transactions","nonce","BIGINT"],["transactions","timestamp","BIGINT"]];
        for(const[t,c,tp]of cols)await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${tp}`).catch(()=>{});
        console.log("✅ DB migration complete");
    } catch(e){console.error("❌ Migration:",e.message);}finally{client.release();}
}

// ══════════════════════════════════════════════════════════════
//  DUAL PRICE ORACLE — CoinGecko + Binance simultaneously
// ══════════════════════════════════════════════════════════════
async function fetchCG() {
    const res=await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",{signal:AbortSignal.timeout(9000)});
    if(res.status===429)throw Object.assign(new Error("rate_limited"),{code:429});
    if(!res.ok)throw new Error(`CG ${res.status}`);
    const d=await res.json(); return parseFloat(d.ethereum.usd);
}
async function fetchBN() {
    const res=await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD",{signal:AbortSignal.timeout(9000)});
    if(!res.ok)throw new Error(`BN ${res.status}`);
    const d=await res.json(); return parseFloat(d.price);
}

// USDT price — CG + Binance simultaneously
async function fetchUSDTPrice() {
    const [cgR, bnR] = await Promise.allSettled([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null),
        fetch("https://api.kraken.com/0/public/Ticker?pair=USDTUSD",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    const cg = cgR.status==="fulfilled"&&cgR.value ? parseFloat(cgR.value.tether?.usd||1) : null;
    const bn = bnR.status==="fulfilled"&&bnR.value ? parseFloat(bnR.value?.result?.USDTUSD?.c?.[0]||1) : null;
    const avg = cg&&bn?parseFloat(((cg+bn)/2).toFixed(6)):cg||bn||1.0;
    const source = cg&&bn?"coingecko+binance":cg?"coingecko":bn?"binance":"cached";
    console.log(`💵 USDT: $${avg} [${source}] CG:$${cg||"—"} BN:$${bn||"—"}`);
    // Track on both chains simultaneously
    const [privSupply, mainSupply] = await Promise.allSettled([
        provider&&SUSDC_ADDRESS ? new ethers.Contract(SUSDC_ADDRESS,["function totalSupply() view returns (uint256)","function decimals() view returns (uint8)"],provider).totalSupply().then(s=>ethers.formatUnits(s,6)).catch(()=>"—") : Promise.resolve("—"),
        mainnetProvider&&USDT_MAINNET_ADDRESS ? new ethers.Contract(USDT_MAINNET_ADDRESS,["function totalSupply() view returns (uint256)"],mainnetProvider).totalSupply().then(s=>ethers.formatUnits(s,6)).catch(()=>"—") : Promise.resolve("—"),
    ]);
    try { await db.query(`INSERT INTO token_prices (address,symbol,name,price_usd,updated_at) VALUES ($1,'USDT','Tether USD',$2,NOW()) ON CONFLICT (address) DO UPDATE SET price_usd=$2,updated_at=NOW()`,[USDT_MAINNET_ADDRESS.toLowerCase(),avg]); } catch {}
    return { avg, cg_usd:cg, bn_usd:bn, source, susdc_supply_private:privSupply.value||"—", usdt_supply_mainnet:mainSupply.value||"—" };
}

async function fetchDualPrice() {
    const[cgR,bnR]=await Promise.allSettled([fetchCG(),fetchBN()]);
    const cg=cgR.status==="fulfilled"?cgR.value:null;
    const bn=bnR.status==="fulfilled"?bnR.value:null;
    CG_PRICE=cg; BN_PRICE=bn;
    if(cg&&bn) return {avg:parseFloat(((cg+bn)/2).toFixed(2)),cg,bn,source:"coingecko+binance"};
    if(cg)     return {avg:cg,cg,bn:null,source:"coingecko"};
    if(bn)     return {avg:bn,cg:null,bn,source:"binance"};
    return {avg:ETH_PRICE_PRIVATE,cg:null,bn:null,source:"cached"};
}

// Bridge oracle: fetch both chains at exact event time
async function fetchBridgeOraclePrice(bridgeAddr, direction) {
    const[privR,mainR]=await Promise.allSettled([fetchDualPrice(),fetchDualPrice()]);
    const priv=privR.status==="fulfilled"?privR.value:{avg:ETH_PRICE_PRIVATE,cg:CG_PRICE,bn:BN_PRICE,source:"cached"};
    const main=mainR.status==="fulfilled"?mainR.value:{avg:ETH_PRICE_MAINNET,cg:CG_PRICE,bn:BN_PRICE,source:"cached"};
    ETH_PRICE_PRIVATE=priv.avg; ETH_PRICE_MAINNET=main.avg; priceSource=priv.source;
    const delta=priv.avg-main.avg;
    console.log(`🔮 [OracleIndexer] private=$${priv.avg} mainnet=$${main.avg} Δ${delta>=0?"+":""}${delta.toFixed(2)}`);
    try{await db.query(`INSERT INTO bridge_price_oracle (bridge_address,direction,src_chain_id,dst_chain_id,private_cg_usd,private_bn_usd,private_avg_usd,mainnet_cg_usd,mainnet_bn_usd,mainnet_avg_usd,price_delta_usd,fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [bridgeAddr,direction,CHAIN_ID,String(MAINNET_CHAIN_ID),priv.cg,priv.bn,priv.avg,main.cg,main.bn,main.avg,delta]);}
    catch(e){console.warn("⚠  oracle insert:",e.message);}
    return {priv,main,delta};
}

async function fetchPrices() {
    const pd=await fetchDualPrice().catch(()=>null);
    if(!pd){console.warn("⚠  Price fetch failed — using cached");return;}
    ETH_PRICE_PRIVATE=pd.avg; ETH_PRICE_MAINNET=pd.avg; priceSource=pd.source;
    console.log(`💰 ETH: $${pd.avg} [${pd.source}] CG:$${pd.cg} BN:$${pd.bn}`);
    try{await db.query(`INSERT INTO eth_price (symbol,price_usd,updated_at) VALUES ('ETH',$1,NOW()) ON CONFLICT (symbol) DO UPDATE SET price_usd=$1,updated_at=NOW()`,[pd.avg]);}catch(e){console.warn("⚠  eth_price:",e.message);}
    try{await db.query(`INSERT INTO token_prices (address,symbol,name,price_usd,updated_at) VALUES ($1,'sUSDC','Stablecoin USDC',$2,NOW()) ON CONFLICT (address) DO UPDATE SET price_usd=$2,updated_at=NOW()`,[SUSDC_ADDRESS.toLowerCase(),SUSDC_PRICE_USD]);}catch{}
    // Track mainnet block
    if(mainnetProvider){try{mainnetBlockNum=await mainnetProvider.getBlockNumber();await db.query(`INSERT INTO mainnet_stats (chain_id,block_number,eth_price_usd,cg_usd,bn_usd,price_source,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (chain_id) DO UPDATE SET block_number=$2,eth_price_usd=$3,cg_usd=$4,bn_usd=$5,price_source=$6,updated_at=NOW()`,[MAINNET_CHAIN_ID,mainnetBlockNum,pd.avg,pd.cg,pd.bn,pd.source]).catch(()=>{});console.log(`🌐 Mainnet block: #${mainnetBlockNum?.toLocaleString()}`);}catch{}}
}

async function fetchP2PPeerCount() {
    try{const res=await fetch(GETH_ADMIN_RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:"admin_peers",params:[],id:1}),signal:AbortSignal.timeout(5000)});if(!res.ok)return;const d=await res.json();if(Array.isArray(d.result)){p2pPeerCount=d.result.length;await db.query(`INSERT INTO p2p_stats (port,peer_count,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (port) DO UPDATE SET peer_count=$2,updated_at=NOW()`,[P2P_PORT,p2pPeerCount]).catch(()=>{});if(p2pPeerCount>0)console.log(`🔗 P2P peers: ${p2pPeerCount}`);}}catch{}
}

// ══════════════════════════════════════════════════════════════
//  BRIDGE EVENT INDEXING — Private → Mainnet Direct
// ══════════════════════════════════════════════════════════════
const BRIDGE_ABI=[
    "event ETHLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "event ETHReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
];

async function indexBridgeEvents() {
    if(!PRIVATE_BRIDGE_ADDRESS){console.log("ℹ  PRIVATE_BRIDGE_ADDRESS not set — bridge indexing skipped");return;}
    const bridge=new ethers.Contract(PRIVATE_BRIDGE_ADDRESS,BRIDGE_ABI,provider);

    // Historical events
    try {
        const[locked,released]=await Promise.all([bridge.queryFilter(bridge.filters.ETHLocked()),bridge.queryFilter(bridge.filters.ETHReleased())]);
        console.log(`🌉 Bridge history: ${locked.length} locked, ${released.length} released`);
        for(const ev of locked){
            const{sender,recipient,amount,requestId}=ev.args;
            const amtETH=parseFloat(ethers.formatEther(amount));
            const amtUSD=(amtETH*ETH_PRICE_PRIVATE).toFixed(2);
            await db.query(`INSERT INTO bridge_requests (request_id,sender,recipient,amount_wei,amount_eth,amount_usd,status,direction,src_chain_id,dst_chain_id,bridge_address,eth_price_usd_private,eth_price_usd_mainnet,block_number,timestamp) VALUES ($1,$2,$3,$4,$5,$6,'pending','private_to_mainnet',$7,$8,$9,$10,$10,$11,$12) ON CONFLICT (request_id) DO NOTHING`,
                [requestId,sender,recipient,amount.toString(),amtETH,amtUSD,CHAIN_ID,String(MAINNET_CHAIN_ID),PRIVATE_BRIDGE_ADDRESS,ETH_PRICE_PRIVATE,ev.blockNumber,0]).catch(()=>{});
        }
        for(const ev of released){const{requestId}=ev.args;await db.query("UPDATE bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});}
    } catch(e){console.warn("⚠  Bridge history:",e.message);}

    // Live listener
    bridge.on("ETHLocked",async(sender,recipient,amount,requestId,ev)=>{
        const amtETH=parseFloat(ethers.formatEther(amount));
        console.log(`\n🌉 LIVE ETHLocked: ${amtETH} ETH | ${sender.slice(0,10)}… → Mainnet ${recipient.slice(0,10)}…`);
        const oracle=await fetchBridgeOraclePrice(PRIVATE_BRIDGE_ADDRESS,"private_to_mainnet").catch(()=>null);
        const privP=oracle?.priv?.avg||ETH_PRICE_PRIVATE;
        const mainP=oracle?.main?.avg||ETH_PRICE_MAINNET;
        const amtUSD=(amtETH*privP).toFixed(2);
        await db.query(`INSERT INTO bridge_requests (request_id,sender,recipient,amount_wei,amount_eth,amount_usd,status,direction,src_chain_id,dst_chain_id,bridge_address,eth_price_usd_private,eth_price_usd_mainnet,eth_price_source_priv,eth_price_source_main,cg_price_private,bn_price_private,cg_price_mainnet,bn_price_mainnet,oracle_fetched_at,block_number,timestamp) VALUES ($1,$2,$3,$4,$5,$6,'pending','private_to_mainnet',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,EXTRACT(EPOCH FROM NOW())::BIGINT) ON CONFLICT (request_id) DO NOTHING`,
            [requestId,sender,recipient,amount.toString(),amtETH,amtUSD,CHAIN_ID,String(MAINNET_CHAIN_ID),PRIVATE_BRIDGE_ADDRESS,privP,mainP,oracle?.priv?.source||"cached",oracle?.main?.source||"cached",oracle?.priv?.cg,oracle?.priv?.bn,oracle?.main?.cg,oracle?.main?.bn,ev.blockNumber]).catch(e=>console.warn("⚠  bridge_requests:",e.message));
        console.log(`   ✅ Recorded: priv=$${privP} main=$${mainP} Δ$${((oracle?.delta)||0).toFixed(2)}`);
    });
    bridge.on("ETHReleased",async(recipient,amount,requestId)=>{
        console.log(`✅ ETHReleased: ${ethers.formatEther(amount)} ETH → ${recipient.slice(0,10)}…`);
        await db.query("UPDATE bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    });
    console.log(`✅ Bridge listening: ${PRIVATE_BRIDGE_ADDRESS} (Private → Mainnet, no L2)`);
}

// ══════════════════════════════════════════════════════════════
//  wPETH INDEXING — Wrapped Private ETH events on Mainnet
// ══════════════════════════════════════════════════════════════
async function indexWPETHEvents() {
    if (!WPETH_ADDRESS || !mainnetProvider) {
        console.log("ℹ  WPETH_ADDRESS not set — wPETH indexing skipped");
        return;
    }
    const wpeth = new ethers.Contract(WPETH_ADDRESS, WPETH_EVENTS_ABI, mainnetProvider);
    console.log(`🪙 Indexing wPETH events: ${WPETH_ADDRESS}`);

    // Historical Minted events
    try {
        const minted = await wpeth.queryFilter(wpeth.filters.Minted());
        console.log(`   Minted events: ${minted.length}`);
        for (const ev of minted) {
            const amtETH = parseFloat(ethers.formatEther(ev.args.amount));
            const price  = Number(ev.args.ethPriceUSD) / 1e8;
            await db.query(`INSERT INTO wpeth_events
                (event_type,tx_hash,block_number,address,amount_wei,amount_eth,
                 request_id,eth_price_usd,network,timestamp)
                VALUES ('Minted',$1,$2,$3,$4,$5,$6,$7,'mainnet',$8)
                ON CONFLICT DO NOTHING`,
                [ev.transactionHash, ev.blockNumber, ev.args.to,
                 ev.args.amount.toString(), amtETH, ev.args.requestId,
                 price, ev.blockNumber]).catch(()=>{});
        }
    } catch(e) { console.warn("⚠  wPETH history:", e.message); }

    // Historical PriceUpdated events
    try {
        const prices = await wpeth.queryFilter(wpeth.filters.PriceUpdated());
        console.log(`   PriceUpdated events: ${prices.length}`);
        for (const ev of prices) {
            const avg = Number(ev.args.avgUSD) / 1e8;
            const cg  = Number(ev.args.cgUSD)  / 1e8;
            const bn  = Number(ev.args.bnUSD)  / 1e8;
            await db.query(`INSERT INTO wpeth_events
                (event_type,tx_hash,block_number,eth_price_usd,cg_price_usd,
                 bn_price_usd,price_source,network,timestamp)
                VALUES ('PriceUpdated',$1,$2,$3,$4,$5,$6,'mainnet',$7)
                ON CONFLICT DO NOTHING`,
                [ev.transactionHash, ev.blockNumber, avg, cg, bn,
                 ev.args.source, Number(ev.args.timestamp)]).catch(()=>{});
        }
    } catch(e) { console.warn("⚠  wPETH price history:", e.message); }

    // Live listener — Minted event
    wpeth.on("Minted", async (to, amount, requestId, ethPrice, ev) => {
        const amtETH = parseFloat(ethers.formatEther(amount));
        const price  = Number(ethPrice) / 1e8;
        const [ethP, usdtP] = await Promise.allSettled([fetchDualPrice(), fetchUSDTPrice()]);
        const live = ethP.status==="fulfilled" ? ethP.value : {avg:price,cg_usd:null,bn_usd:null,source:"on-chain"};
        console.log(`
🪙 [wPETH] LIVE Minted: ${amtETH} wPETH → ${to.slice(0,10)}…`);
        console.log(`   Request ID:  ${requestId}`);
        console.log(`   ETH price:   $${price} (on-chain) | live CG:$${live.cg_usd||"—"} BN:$${live.bn_usd||"—"}`);
        console.log(`   Value USD:   ~$${(amtETH*price).toFixed(2)}
`);
        await db.query(`INSERT INTO wpeth_events
            (event_type,tx_hash,block_number,address,amount_wei,amount_eth,
             request_id,eth_price_usd,cg_price_usd,bn_price_usd,price_source,network,timestamp)
            VALUES ('Minted',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'mainnet',$11)
            ON CONFLICT DO NOTHING`,
            [ev.transactionHash, ev.blockNumber, to, amount.toString(), amtETH,
             requestId, price, live.cg_usd, live.bn_usd, live.source,
             ev.blockNumber]).catch(()=>{});
    });

    // Live listener — PriceUpdated event
    wpeth.on("PriceUpdated", async (avgUSD, cgUSD, bnUSD, priceSrc, timestamp) => {
        const avg = Number(avgUSD)/1e8, cg = Number(cgUSD)/1e8, bn = Number(bnUSD)/1e8;
        console.log(`💰 [wPETH] Price updated on-chain: avg=$${avg} CG=$${cg} BN=$${bn} [${priceSrc}]`);
        await db.query(`INSERT INTO wpeth_events
            (event_type,eth_price_usd,cg_price_usd,bn_price_usd,price_source,network,timestamp)
            VALUES ('PriceUpdated',$1,$2,$3,$4,'mainnet',$5)`,
            [avg, cg, bn, priceSrc, Number(timestamp)]).catch(()=>{});
    });

    console.log(`✅ wPETH indexer active: ${WPETH_ADDRESS}`);
}

// ══════════════════════════════════════════════════════════════
//  TOKEN BRIDGE INDEXING — sUSDC (Private) → USDT (Mainnet)
// ══════════════════════════════════════════════════════════════
const TOKEN_BRIDGE_ABI_EVENTS = [
    "event TokensLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "event TokensReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
];

async function indexTokenBridgeEvents() {
    if (!TOKEN_BRIDGE_ADDRESS||!provider) { console.log("ℹ  TOKEN_BRIDGE_ADDRESS not set — token bridge indexing skipped"); return; }
    const bridge = new ethers.Contract(TOKEN_BRIDGE_ADDRESS, TOKEN_BRIDGE_ABI_EVENTS, provider);
    try {
        const [locked, released] = await Promise.all([
            bridge.queryFilter(bridge.filters.TokensLocked()),
            bridge.queryFilter(bridge.filters.TokensReleased()),
        ]);
        console.log(`🌉 Token bridge history: ${locked.length} locked, ${released.length} released`);
        for (const ev of locked) {
            const {sender,recipient,amount,requestId} = ev.args;
            const amtTokens = ethers.formatUnits(amount, 6);
            const amtUSD = (parseFloat(amtTokens)*1.0).toFixed(2);
            await db.query(`INSERT INTO token_bridge_requests
                (request_id,sender,recipient,amount_tokens,amount_usd,src_token,dst_token,status,direction,src_chain_id,dst_chain_id,bridge_address,timestamp)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','susdc_to_usdt',$8,$9,$10,$11) ON CONFLICT (request_id) DO NOTHING`,
                [requestId,sender,recipient,amtTokens,amtUSD,SUSDC_ADDRESS.toLowerCase(),USDT_MAINNET_ADDRESS.toLowerCase(),"123456","1",TOKEN_BRIDGE_ADDRESS.toLowerCase(),ev.blockNumber]).catch(()=>{});
        }
        for (const ev of released) {
            await db.query("UPDATE token_bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[ev.args.requestId]).catch(()=>{});
        }
    } catch(e) { console.warn("⚠  Token bridge history:", e.message); }

    bridge.on("TokensLocked", async(sender,recipient,amount,requestId,ev) => {
        const amtTokens = ethers.formatUnits(amount, 6);
        // Fetch USDT price on both chains simultaneously
        const usdtP = await fetchUSDTPrice().catch(()=>({avg:1.0,cg_usd:null,bn_usd:null,source:"cached"}));
        const amtUSD = (parseFloat(amtTokens)*usdtP.avg).toFixed(2);
        console.log(`
🌉 [TokenBridge] LIVE TokensLocked: ${amtTokens} sUSDC → Mainnet USDT | $${amtUSD} | USDT:$${usdtP.avg} [${usdtP.source}]`);
        await db.query(`INSERT INTO token_bridge_requests
            (request_id,sender,recipient,amount_tokens,amount_usd,src_token,dst_token,status,direction,src_chain_id,dst_chain_id,bridge_address,usdt_price_cg,usdt_price_bn,usdt_price_avg,oracle_fetched_at,timestamp)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','susdc_to_usdt',$8,$9,$10,$11,$12,$13,NOW(),$14) ON CONFLICT (request_id) DO NOTHING`,
            [requestId,sender,recipient,amtTokens,amtUSD,SUSDC_ADDRESS.toLowerCase(),USDT_MAINNET_ADDRESS.toLowerCase(),"123456","1",TOKEN_BRIDGE_ADDRESS.toLowerCase(),usdtP.cg_usd,usdtP.bn_usd,usdtP.avg,ev.blockNumber]).catch(e=>console.warn("⚠",e.message));
    });
    bridge.on("TokensReleased", async(recipient,amount,requestId) => {
        console.log(`✅ [TokenBridge] TokensReleased: ${ethers.formatUnits(amount,6)} USDT → ${recipient.slice(0,10)}…`);
        await db.query("UPDATE token_bridge_requests SET status='completed',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    });
    console.log(`✅ Token bridge indexer: ${TOKEN_BRIDGE_ADDRESS}`);
}

// ══════════════════════════════════════════════════════════════
//  BLOCK + TX INDEXING
// ══════════════════════════════════════════════════════════════
async function indexBlock(num) {
    try {
        const block=await provider.getBlock(num,true);
        if(!block)return;
        await db.query(`INSERT INTO blocks (number,hash,miner,timestamp,tx_count,gas_used,gas_limit) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (number) DO NOTHING`,
            [block.number,block.hash,block.miner,block.timestamp,block.transactions.length,block.gasUsed?.toString(),block.gasLimit?.toString()]);
        for(const tx of(block.prefetchedTransactions||[]))await indexTx(tx,block);
        if(block.transactions.length>0)console.log(`✅ Block #${num} — ${block.transactions.length} txs`);
    }catch(e){console.error(`❌ Block #${num}:`,e.message);}
}

async function indexTx(tx,block) {
    try {
        const receipt=await provider.getTransactionReceipt(tx.hash);
        if(!receipt)return;
        const ethVal=parseFloat(ethers.formatEther(tx.value||0n));
        const gasFeeEth=parseFloat(ethers.formatEther((receipt.gasUsed||0n)*(tx.gasPrice||0n)));
        const isSUSDC=tx.to?.toLowerCase()===SUSDC_ADDRESS.toLowerCase();
        const status=receipt.status===1?"success":"failed";
        const txType=isSUSDC?"sUSDC":ethVal>0?"ETH":"CONTRACT";
        const valueUSD=(ethVal*ETH_PRICE_PRIVATE).toFixed(2);
        const feeUSD=(gasFeeEth*ETH_PRICE_PRIVATE).toFixed(6);
        await db.query(`INSERT INTO transactions (hash,block_number,from_address,to_address,value,value_usd,gas_used,gas_fee_usd,status,tx_type,input_data,nonce,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (hash) DO UPDATE SET value_usd=$6,gas_fee_usd=$8,status=$9,tx_type=$10,input_data=$11,nonce=$12`,
            [tx.hash,tx.blockNumber,tx.from,tx.to,tx.value?.toString(),valueUSD,receipt.gasUsed?.toString(),feeUSD,status,txType,tx.data||"0x",tx.nonce,block.timestamp]);
        if(ethVal>0&&tx.to)await db.query(`INSERT INTO eth_transfers (tx_hash,from_address,to_address,value_wei,value_eth,value_usd,block_number,timestamp,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tx_hash) DO NOTHING`,
            [tx.hash,tx.from,tx.to,tx.value?.toString(),ethVal,valueUSD,tx.blockNumber,block.timestamp,status]).catch(()=>{});
        if(isSUSDC||receipt.logs?.length>0)await indexTokenTransfers(receipt,block);
    }catch(e){console.error(`❌ TX ${tx.hash?.slice(0,10)}:`,e.message);}
}

async function indexTokenTransfers(receipt,block) {
    const SIG="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    for(const log of receipt.logs){
        if(log.address.toLowerCase()!==SUSDC_ADDRESS.toLowerCase())continue;
        if(log.topics[0]!==SIG||log.topics.length<3)continue;
        try{const from="0x"+log.topics[1].slice(26).toLowerCase();const to="0x"+log.topics[2].slice(26).toLowerCase();const value=BigInt(log.data||"0x0");const dec=parseFloat(ethers.formatUnits(value,6));await db.query(`INSERT INTO token_transfers (tx_hash,block_number,token_address,token_symbol,from_address,to_address,value,value_decimal,value_usd,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tx_hash,from_address,to_address,value) DO NOTHING`,[receipt.hash,receipt.blockNumber,SUSDC_ADDRESS.toLowerCase(),"sUSDC",from,to,value.toString(),dec,(dec*SUSDC_PRICE_USD).toFixed(2),block.timestamp]);console.log(`   💸 sUSDC: ${dec} | ${from.slice(0,10)}… → ${to.slice(0,10)}…`);}catch{}
    }
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║  OpenClaw Chain Indexer                              ║");
    console.log(`║  Private RPC: ${RPC_URL.padEnd(40)}║`);
    console.log(`║  Mainnet RPC: ${ETH_MAINNET_RPC_URL.padEnd(40)}║`);
    console.log(`║  Domain:  https://${NGINX_DOMAIN.padEnd(35)}║`);
    console.log(`║  VPS IP:  ${VPS_IP.padEnd(44)}║`);
    console.log(`║  P2P:     port ${P2P_PORT}  Bridge: ${(PRIVATE_BRIDGE_ADDRESS||"not set").slice(0,24).padEnd(24)}║`);
    console.log("║  Dual Oracle: CG+BN on BOTH chains per bridge event  ║");
    console.log("║  Auto DB migration ON                                ║");
    console.log("╚══════════════════════════════════════════════════════╝\n");

    try{await db.connect();console.log("✅ PostgreSQL connected");}catch(e){console.warn("⚠  PostgreSQL:",e.message);}
    await migrateDB();
    await fetchPrices();
    await fetchP2PPeerCount();
    setInterval(fetchPrices,90_000);
    setInterval(fetchP2PPeerCount,30_000);

    const latest=(await provider.getBlockNumber());
    const{rows}=await db.query("SELECT COUNT(*) FROM blocks");
    const indexed=parseInt(rows[0].count);
    const toIndex=latest-indexed;

    console.log(`📦 Chain head:      #${latest.toLocaleString()}`);
    console.log(`✅ Already indexed: ${indexed.toLocaleString()}`);
    console.log(`⏳ To index:        ${toIndex.toLocaleString()}`);
    console.log(`💰 ETH private:     $${ETH_PRICE_PRIVATE} CG:$${CG_PRICE} BN:$${BN_PRICE}`);
    console.log(`🌐 Mainnet block:   #${mainnetBlockNum?.toLocaleString()||"—"}`);
    console.log(`🔗 P2P peers:       ${p2pPeerCount}\n`);

    if(toIndex>0){
        console.log("📜 Indexing historical blocks…\n");
        const t0=Date.now();
        for(let i=indexed;i<=latest;i++){
            await indexBlock(i);
            if(i%500===0&&i>0)console.log(`📊 ${i.toLocaleString()}/${latest.toLocaleString()} (${Math.round(i/latest*100)}%) | ${(i/((Date.now()-t0)/1000)).toFixed(0)} blk/s`);
        }
        console.log("\n✅ Historical indexing complete");
    }else{console.log("✅ Up to date — watching live blocks\n");}

    await indexBridgeEvents();
    await indexTokenBridgeEvents();
    await indexWPETHEvents();
    // Fetch USDT price on both chains simultaneously
    const usdtData = await fetchUSDTPrice().catch(()=>null);
    if (usdtData) console.log(`💵 USDT: $${usdtData.avg} [${usdtData.source}] | sUSDC supply: ${usdtData.susdc_supply_private} | USDT mainnet: ${usdtData.usdt_supply_mainnet}`);
    setInterval(fetchUSDTPrice, 90_000);

    const[blkR,txR,ttR,brR,oR]=await Promise.all([
        db.query("SELECT COUNT(*) FROM blocks"),
        db.query("SELECT COUNT(*) FROM transactions"),
        db.query("SELECT COUNT(*) FROM token_transfers"),
        db.query("SELECT direction,status,COUNT(*) FROM bridge_requests GROUP BY direction,status").catch(()=>({rows:[]})),
        db.query("SELECT COUNT(*) FROM bridge_price_oracle").catch(()=>({rows:[{count:0}]})),
    ]);
    console.log("── DB Stats ──────────────────────────────────────────");
    console.log(`   Blocks:            ${parseInt(blkR.rows[0].count).toLocaleString()}`);
    console.log(`   Transactions:      ${parseInt(txR.rows[0].count).toLocaleString()}`);
    console.log(`   Token Transfers:   ${parseInt(ttR.rows[0].count).toLocaleString()}`);
    console.log(`   Bridge Requests:`); brR.rows.forEach(r=>console.log(`     ${r.direction} / ${r.status}: ${r.count}`));
    console.log(`   Oracle Events:     ${oR.rows[0].count}`);
    console.log(`   ETH:               $${ETH_PRICE_PRIVATE} [${priceSource}]`);
    console.log(`   P2P:               ${p2pPeerCount} peers (port ${P2P_PORT})`);
    console.log(`   Nginx domain:      https://${NGINX_DOMAIN}`);
    console.log("──────────────────────────────────────────────────────\n");

    console.log("👁  Watching live blocks…\n");
    provider.on("block",async(num)=>{await indexBlock(num);console.log(`🔴 Live block #${num.toLocaleString()}`);});
}

main().catch(e=>{console.error("💥 Indexer crashed:",e.message);process.exit(1);});
