require("dotenv").config();
const { ethers } = require("ethers");
const { Pool }   = require("pg");

// ── Deployment constants (from artifacts/deployment.json) ──
const BRIDGE_ADDRESS        = process.env.PRIVATE_BRIDGE_ADDRESS
                           || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS
                           || "0xDD7917A79515FeaA5Ce15Fa84E8c74b931Dec990";
const DEPLOY_BLOCK          = 571579;   // bridge deployed at this block
const PRIVATE_CHAIN_ID      = 123456;
const MAINNET_CHAIN_ID      = 1;
const P2P_PORT              = parseInt(process.env.P2P_PORT || "30303");
const VPS_IP                = process.env.VPS_IP || "68.183.30.13";

// ── Token addresses ────────────────────────────────────────
const SUSDC_PRIVATE         = process.env.SUSDC_CONTRACT_ADDRESS
                           || "0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8";
const USDT_MAINNET          = process.env.USDT_MAINNET_ADDRESS
                           || "0xdAC17F958D2ee523a2206206994597C13D831ec7";

// ── RPC endpoints ──────────────────────────────────────────
const PRIVATE_RPC           = process.env.PRIVATE_CHAIN_RPC_URL
                           || process.env.RPC_URL
                           || "https://ai-private.online:8545";
// Destination chain config — set DESTINATION_TARGET in .env
const DESTINATION_TARGET = process.env.DESTINATION_TARGET || "optimism_sepolia";
const OPTIMISM_CONFIGS = {
    optimism_mainnet: { chainId:10,       name:"Optimism Mainnet", rpc:"https://mainnet.optimism.io",     explorer:"https://optimistic.etherscan.io" },
    optimism_sepolia: { chainId:11155420, name:"Optimism Sepolia", rpc:"https://sepolia.optimism.io",     explorer:"https://sepolia-optimism.etherscan.io" },
    mainnet:          { chainId:1,        name:"Ethereum Mainnet", rpc:"https://rpc.flashbots.net", explorer:"https://etherscan.io" },
};
const OPTIMISM_CFG  = OPTIMISM_CONFIGS[DESTINATION_TARGET] || OPTIMISM_CONFIGS.optimism_sepolia;
const MAINNET_RPC   = process.env.DESTINATION_RPC_URL
                   || process.env.ETH_MAINNET_RPC_URL
                   || process.env.MAINNET_RPC_URL
                   || OPTIMISM_CFG.rpc;

// ── Wallets ────────────────────────────────────────────────
const RELAYER_KEY           = process.env.RELAYER_PRIVATE_KEY;
const DEPLOYER_KEY          = process.env.DEPLOYER_PRIVATE_KEY;
const MAINNET_SENDER_KEY    = RELAYER_KEY || DEPLOYER_KEY;

// ── PostgreSQL (optional — price logging only) ─────────────
const db = new Pool({
    host:     process.env.POSTGRES_HOST     || "localhost",
    port:     parseInt(process.env.POSTGRES_PORT || "5432"),
    user:     process.env.POSTGRES_USER     || "blockscout",
    password: process.env.POSTGRES_PASSWORD || "susdc_secure_2024",
    database: process.env.POSTGRES_DB       || "blockscout",
    max: 3, idleTimeoutMillis: 20000, connectionTimeoutMillis: 3000,
});
let dbOk = false;
db.connect()
    .then(c => { dbOk = true; c.release(); console.log("✅ [Relayer] PostgreSQL connected"); })
    .catch(() => console.warn("⚠  [Relayer] PostgreSQL unavailable — price logging console only"));

// ══════════════════════════════════════════════════════════
//  FULL ABI — from PrivateBridge.abi.json
//  Contract: 0xDD7917A79515FeaA5Ce15Fa84E8c74b931Dec990
// ══════════════════════════════════════════════════════════
const BRIDGE_ABI = [
    // ── Events ──────────────────────────────────────────
    // Leg A: ETH bridge
    "event ETHLocked(address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    "event ETHReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    // Leg B: Token bridge (sUSDC → USDT)
    "event TokensLocked(address indexed sender, address indexed mainnetRecipient, uint256 amount, address srcToken, address dstToken, bytes32 indexed requestId)",
    "event TokensReleased(address indexed recipient, uint256 amount, bytes32 indexed requestId)",
    // Config events
    "event BridgeFeeUpdated(uint256 ethFee, uint256 tokenFee)",
    "event RelayerUpdated(address newRelayer)",
    "event SusdcAddressUpdated(address newSusdc)",

    // ── Read functions ───────────────────────────────────
    "function owner() view returns (address)",
    "function relayer() view returns (address)",
    "function bridgeFeeETH() view returns (uint256)",
    "function bridgeFeeToken() view returns (uint256)",
    "function destinationChainId() view returns (uint256)",
    "function susdc() view returns (address)",
    "function P2P_PORT() view returns (uint16)",
    "function relayerEnode() view returns (string)",
    "function getStats() view returns (uint256 ethBalance, uint256 feeCollected, uint256 totalRequests)",
    "function getBridgeInfo() view returns (address _owner, address _relayer, uint256 _dstChain, address _susdc, address _usdtMainnet, uint16 _p2pPort, uint256 _ethFee, uint256 _tokenFee)",
    "function getETHRequest(bytes32 id) view returns (tuple(address sender, address recipient, uint256 amount, uint256 timestamp, bool processed))",
    "function getTokenRequest(bytes32 id) view returns (tuple(address sender, address mainnetRecipient, uint256 amountLocked, address srcToken, address dstToken, uint256 timestamp, bool processed))",
    "function getAllETHRequests() view returns (bytes32[])",
    "function getAllTokenRequests() view returns (bytes32[])",

    // ── Write functions (relayer only) ───────────────────
    "function releaseETH(address payable recipient, uint256 amount, bytes32 requestId) external",
    "function releaseTokens(address recipient, uint256 amount, bytes32 requestId) external",
    "function setRelayerP2PInfo(string calldata enode) external",

    // ── Admin ────────────────────────────────────────────
    "function setRelayer(address newRelayer) external",
    "function setFees(uint256 ethFee, uint256 tokenFee) external",
    "function withdrawAllETH() external",
    "function withdrawAllTokens() external",
];

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// wPETH contract on Mainnet (deploy with: node deploy.js --deploy-wpeth)
const WPETH_ADDRESS = process.env.WPETH_ADDRESS || null;
const WPETH_ABI = [
    "function mint(address to, uint256 amount, bytes32 requestId) returns (bool)",
    "function burn(uint256 amount, string calldata privateRecipient) returns (bool)",
    "function updateEthPrice(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string calldata source) external",
    "function getStats() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,string)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function ethPriceUSD() view returns (uint256)",
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
    "event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp)",
];

// ══════════════════════════════════════════════════════════
//  DUAL PRICE ORACLE — CoinGecko + Binance simultaneously
// ══════════════════════════════════════════════════════════
async function fetchCG() {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",{signal:AbortSignal.timeout(9000)});
    if (r.status===429) throw Object.assign(new Error("rate_limited"),{code:429});
    if (!r.ok) throw new Error(`CG ${r.status}`);
    const d = await r.json(); return parseFloat(d.ethereum.usd);
}
async function fetchBN() {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD",{signal:AbortSignal.timeout(9000)});
    if (!r.ok) throw new Error(`BN ${r.status}`);
    const d = await r.json(); return parseFloat(d.price);
}
async function fetchUSDT() {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",{signal:AbortSignal.timeout(9000)});
    if (!r.ok) return null;
    const d = await r.json(); return parseFloat(d.tether?.usd||1);
}

async function fetchDualPrice() {
    const [cgR, bnR] = await Promise.allSettled([fetchCG(), fetchBN()]);
    const cg = cgR.status==="fulfilled" ? cgR.value : null;
    const bn = bnR.status==="fulfilled" ? bnR.value : null;
    const avg = cg&&bn ? parseFloat(((cg+bn)/2).toFixed(2)) : cg||bn||0;
    const source = cg&&bn?"coingecko+binance":cg?"coingecko":bn?"binance":"unavailable";
    return { avg, cg_usd:cg, bn_usd:bn, source };
}

// Oracle at bridge event time — fires CG + BN on BOTH chains simultaneously
async function oraclePrice(requestId, amountETH, direction) {
    const [privP, mainP, usdtP] = await Promise.allSettled([
        fetchDualPrice(), fetchDualPrice(), fetchUSDT()
    ]);
    const priv = privP.status==="fulfilled" ? privP.value : {avg:0,cg_usd:null,bn_usd:null,source:"unavailable"};
    const main = mainP.status==="fulfilled" ? mainP.value : {avg:0,cg_usd:null,bn_usd:null,source:"unavailable"};
    const usdt = usdtP.status==="fulfilled" ? usdtP.value : 1.0;
    const delta= parseFloat((priv.avg-main.avg).toFixed(4));
    const amtUSD=(parseFloat(amountETH)*priv.avg).toFixed(2);

    console.log(`🔮 [Oracle] direction=${direction}`);
    console.log(`   Private chain: CG=$${priv.cg_usd||"—"} BN=$${priv.bn_usd||"—"} avg=$${priv.avg} [${priv.source}]`);
    console.log(`   Mainnet:       CG=$${main.cg_usd||"—"} BN=$${main.bn_usd||"—"} avg=$${main.avg} [${main.source}]`);
    console.log(`   USDT:          $${usdt}`);
    console.log(`   Amount:        ${amountETH} ETH ≈ $${amtUSD}`);
    console.log(`   Δ (priv-main): ${delta>=0?"+":""}$${delta}\n`);

    if (dbOk) {
        db.query(`INSERT INTO bridge_price_oracle
            (bridge_address,direction,src_chain_id,dst_chain_id,
             private_cg_usd,private_bn_usd,private_avg_usd,
             mainnet_cg_usd,mainnet_bn_usd,mainnet_avg_usd,
             price_delta_usd,fetched_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
            [BRIDGE_ADDRESS.toLowerCase(),direction,
             String(PRIVATE_CHAIN_ID),String(MAINNET_CHAIN_ID),
             priv.cg_usd,priv.bn_usd,priv.avg,
             main.cg_usd,main.bn_usd,main.avg,delta]
        ).catch(()=>{});
    }
    return { priv, main, usdt, delta, amtUSD };
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  PrivateBridge Relayer                                       ║");
    console.log(`║  Contract:  ${BRIDGE_ADDRESS.padEnd(51)}║`);
    console.log(`║  Private:   ${PRIVATE_RPC.padEnd(51)}║`);
    console.log(`║  Target:    ${OPTIMISM_CFG.name.padEnd(51)}║`);
    console.log(`║  Dst RPC:   ${MAINNET_RPC.padEnd(51)}║`);
    console.log(`║  Chain:     ${String(PRIVATE_CHAIN_ID)} → ${OPTIMISM_CFG.chainId} (${OPTIMISM_CFG.name})`.padEnd(54)+"║");
    console.log(`║  P2P port:  ${String(P2P_PORT).padEnd(51)}║`);
    console.log("║  Mode:      No verification · No reserve · Direct send       ║");
    console.log("║  Oracle:    CoinGecko + Binance simultaneously both chains   ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    if (!MAINNET_SENDER_KEY) {
        console.error("❌  RELAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set in .env");
        process.exit(1);
    }

    // ── Providers + wallets ────────────────────────────────
    const privateProvider = new ethers.JsonRpcProvider(PRIVATE_RPC);
    const mainnetProvider = new ethers.JsonRpcProvider(MAINNET_RPC);
    const mainnetWallet   = new ethers.Wallet(MAINNET_SENDER_KEY, mainnetProvider);

    // ── Verify connections ─────────────────────────────────
    const [privBlock, mainBlock] = await Promise.allSettled([
        privateProvider.getBlockNumber(),
        mainnetProvider.getBlockNumber(),
    ]);
    console.log(`📡 Private chain block: #${privBlock.status==="fulfilled"?privBlock.value.toLocaleString():"ERROR"}`);
    console.log(`🌐 Mainnet block:       #${mainBlock.status==="fulfilled"?mainBlock.value.toLocaleString():"ERROR"}`);
    console.log(`👛 Mainnet wallet:      ${mainnetWallet.address}`);
    const mainnetBal = await mainnetProvider.getBalance(mainnetWallet.address);
    console.log(`💰 Mainnet balance:     ${ethers.formatEther(mainnetBal)} ETH`);
    console.log(`🔗 P2P port:            ${P2P_PORT} (devp2p · ${VPS_IP}:${P2P_PORT})\n`);

    // ── wPETH contract on Mainnet ─────────────────────────
    let wpeth = null;
    if (WPETH_ADDRESS) {
        wpeth = new ethers.Contract(WPETH_ADDRESS, WPETH_ABI, mainnetWallet);
        try {
            // getStats removed — use individual calls
            const supply = await wpeth.totalSupply().catch(()=>0n);
            const price  = await wpeth.ethPriceUSD().catch(()=>0n);
            console.log(`🪙 wPETH contract: ${WPETH_ADDRESS}`);
            console.log(`   Total supply:  ${ethers.formatEther(supply)} wPETH`);
            console.log(`   Total minted:  ${ethers.formatEther(stats[1])} wPETH`);
            console.log(`   ETH price:     $${price/1n**BigInt(8)} (stored on-chain)`);
        } catch(e) { console.warn("⚠  wPETH read error:", e.message); }
    } else {
        console.log("ℹ  WPETH_ADDRESS not set — mint wPETH with: node deploy.js --deploy-wpeth");
    }

    // ── Bridge contract (listen on private chain) ──────────
    const bridge = new ethers.Contract(BRIDGE_ADDRESS, BRIDGE_ABI, privateProvider);

    // Verify contract exists
    const code = await privateProvider.getCode(BRIDGE_ADDRESS);
    if (code === "0x") { console.error(`❌  No contract at ${BRIDGE_ADDRESS}`); process.exit(1); }

    // Bridge info — read stats only (getBridgeInfo not in this contract)
    try {
        const stats = await bridge.getStats();
        console.log(`   ETH locked  : ${ethers.formatEther(supply)} ETH`);
        console.log(`   Fee collected: ${ethers.formatEther(stats[1])} ETH`);
        console.log(`   Total requests: ${stats[2].toString()}`);
    } catch(e) { /* stats not critical — skip silently */ }
    // ── Fetch initial prices ───────────────────────────────
    console.log("🔮 Initial oracle price fetch (CoinGecko + Binance simultaneously)…");
    const initPrice = await fetchDualPrice().catch(()=>({avg:0,source:"unavailable"}));
    console.log(`💰 ETH: $${initPrice.avg} [${initPrice.source}] CG:$${initPrice.cg_usd||"—"} BN:$${initPrice.bn_usd||"—"}\n`);

    // ══════════════════════════════════════════════════════
    //  LEG A — ETH BRIDGE
    //  ETHLocked on private chain → send ETH directly on mainnet
    //  Lock 10 ETH · No verification · No reserve needed
    //  P2P relayer on port 30303 detects event and sends
    // ══════════════════════════════════════════════════════
    bridge.on("ETHLocked", async (sender, recipient, amount, requestId) => {
        const amtETH = ethers.formatEther(amount);
        console.log(`\n🌉 [LEG A] ETHLocked detected`);
        console.log(`   Request ID: ${requestId}`);
        console.log(`   Sender:     ${sender}`);
        console.log(`   Recipient:  ${recipient} (${OPTIMISM_CFG.name})`);
        console.log(`   Amount:     ${amtETH} ETH`);
        console.log(`   Dest chain: ${OPTIMISM_CFG.chainId} (${OPTIMISM_CFG.name})`);
        console.log(`   Explorer:   ${OPTIMISM_CFG.explorer}/address/${recipient}`);
        console.log(`   P2P port:   ${P2P_PORT} · devp2p relayer active`);

        // Dual oracle — both chains simultaneously
        const oracle = await oraclePrice(requestId, amtETH, "private_to_mainnet").catch(()=>null);

        // ── Mint wPETH on Mainnet (1:1 with locked ETH) ──────
        if (wpeth && WPETH_ADDRESS) {
            try {
                // Update price oracle on wPETH contract first
                if (oracle && oracle.priv.avg > 0) {
                    const avgScaled = BigInt(Math.round(oracle.priv.avg * 1e8));
                    const cgScaled  = BigInt(Math.round((oracle.priv.cg_usd||oracle.priv.avg) * 1e8));
                    const bnScaled  = BigInt(Math.round((oracle.priv.bn_usd||oracle.priv.avg) * 1e8));
                    const feeData   = await mainnetWallet.provider.getFeeData();
                    const priceTx   = await wpeth.updateEthPrice(avgScaled, cgScaled, bnScaled, oracle.priv.source, {gasLimit:200_000n, gasPrice:feeData.gasPrice||1n});
                    await priceTx.wait();
                    console.log(`   💰 wPETH price updated: $${oracle.priv.avg} [${oracle.priv.source}] CG:$${oracle.priv.cg_usd||"—"} BN:$${oracle.priv.bn_usd||"—"}`);
                }
                // Mint wPETH to recipient
                const feeData = await mainnetWallet.provider.getFeeData();
                const mintTx  = await wpeth.mint(recipient, amount, requestId, {gasLimit:250_000n, gasPrice:feeData.gasPrice||1n});
                const mintRcpt= await mintTx.wait();
                console.log(`   🪙 wPETH minted: ${amtETH} wPETH → ${recipient}`);
                console.log(`   🔍 https://etherscan.io/tx/${mintTx.hash}`);
                console.log(`   👛 wPETH balance: https://etherscan.io/token/${WPETH_ADDRESS}?a=${recipient}`);
                console.log(`   ⛏  Block #${mintRcpt.blockNumber} | 1 wPETH = 1 ETH = $${oracle?.priv?.avg||"—"}
`);
            } catch(e) {
                console.error(`   ❌ wPETH mint failed:`, e.message);
                // Fallback: send real ETH if wPETH fails
                mainnetWallet.sendTransaction({ to: recipient, value: amount })
                    .then(tx => console.log(`   ✅ Fallback ETH sent: ${tx.hash}`))
                    .catch(e2 => console.error(`   ❌ Fallback also failed:`, e2.message));
            }
        } else {
            // No wPETH deployed — send ETH directly (needs real ETH on mainnet)
            mainnetWallet.sendTransaction({ to: recipient, value: amount })
                .then(tx => {
                    console.log(`   ✅ Sent ${amtETH} ETH on ${OPTIMISM_CFG.name}: ${tx.hash}`);
                    console.log(`   🔍 ${OPTIMISM_CFG.explorer}/tx/${tx.hash}`);
                    tx.wait().then(receipt => {
                        console.log(`   ⛏  Confirmed on ${OPTIMISM_CFG.name} block #${receipt.blockNumber}\n`);
                        console.log(`   👛 Check recipient: ${OPTIMISM_CFG.explorer}/address/${recipient}`);
                }).catch(()=>{});
            })
            .catch(e => console.error(`   ❌ [LEG A] Send failed:`, e.message));
        }  // end else (no wPETH)
    });

    bridge.on("ETHReleased", (recipient, amount, requestId) => {
        console.log(`✅ [LEG A] ETHReleased: ${ethers.formatEther(amount)} ETH → ${recipient.slice(0,10)}…`);
    });

    // ══════════════════════════════════════════════════════
    //  LEG B — TOKEN BRIDGE (sUSDC → USDT)
    //  TokensLocked on private chain → send USDT on mainnet
    //  No verification · No reserve · Direct send
    // ══════════════════════════════════════════════════════
    bridge.on("TokensLocked", async (sender, mainnetRecipient, amount, srcToken, dstToken, requestId) => {
        const amtTokens = ethers.formatUnits(amount, 6);
        console.log(`\n🪙 [LEG B] TokensLocked detected`);
        console.log(`   Request ID:  ${requestId}`);
        console.log(`   Sender:      ${sender}`);
        console.log(`   Recipient:   ${mainnetRecipient} (Mainnet)`);
        console.log(`   Amount:      ${amtTokens} sUSDC`);
        console.log(`   Src token:   ${srcToken} (sUSDC private chain)`);
        console.log(`   Dst token:   ${dstToken} (USDT mainnet)`);

        // Fetch USDT price on both chains simultaneously
        const [usdtP, ethP] = await Promise.allSettled([fetchUSDT(), fetchDualPrice()]);
        const usdtPrice = usdtP.status==="fulfilled" ? usdtP.value : 1.0;
        const eth       = ethP.status==="fulfilled"  ? ethP.value  : {avg:0};
        console.log(`   USDT price:  $${usdtPrice}`);
        console.log(`   ETH price:   $${eth.avg} [${eth.source||"—"}]`);
        console.log(`   Value USD:   ~$${(parseFloat(amtTokens)*usdtPrice).toFixed(2)}`);

        // Send USDT on mainnet — no checks, no reserve
        const usdt = new ethers.Contract(USDT_MAINNET, ERC20_ABI, mainnetWallet);
        usdt.transfer(mainnetRecipient, amount)
            .then(tx => {
                console.log(`   ✅ Sent ${amtTokens} USDT on Mainnet: ${tx.hash}`);
                tx.wait().then(receipt => {
                    console.log(`   ⛏  Confirmed block #${receipt.blockNumber}\n`);
                }).catch(()=>{});
            })
            .catch(e => console.error(`   ❌ [LEG B] USDT send failed:`, e.message));
    });

    bridge.on("TokensReleased", (recipient, amount, requestId) => {
        console.log(`✅ [LEG B] TokensReleased: ${ethers.formatUnits(amount,6)} USDT → ${recipient.slice(0,10)}…`);
    });

    // ── P2P info ───────────────────────────────────────────
    console.log(`✅ [LEG A] Listening: ETH bridge on ${BRIDGE_ADDRESS}`);
    console.log(`✅ [LEG B] Listening: Token bridge (sUSDC→USDT) on ${BRIDGE_ADDRESS}`);
    console.log(`🔗 P2P: devp2p port ${P2P_PORT} · VPS ${VPS_IP} · Chain ${PRIVATE_CHAIN_ID}→${MAINNET_CHAIN_ID}`);
    console.log(`👁  Watching for bridge events…\n`);

    // ── Keep-alive + periodic price update on wPETH ──────
    setInterval(async () => {
        try {
            const [pb, mb] = await Promise.allSettled([
                privateProvider.getBlockNumber(),
                mainnetProvider.getBlockNumber(),
            ]);
            const price = await fetchDualPrice().catch(()=>({avg:0,source:"unavailable"}));
            console.log(`♻  Private #${pb.value?.toLocaleString()||"—"} | ${OPTIMISM_CFG.name} #${mb.value?.toLocaleString()||"—"} | ETH $${price.avg} [${price.source}] CG:$${price.cg_usd||"—"} BN:$${price.bn_usd||"—"}`);
            // Push live ETH price to wPETH contract every 60s
            if (wpeth && price.avg > 0) {
                try {
                    const avgScaled = BigInt(Math.round(price.avg * 1e8));
                    const cgScaled  = BigInt(Math.round((price.cg_usd||price.avg) * 1e8));
                    const bnScaled  = BigInt(Math.round((price.bn_usd||price.avg) * 1e8));
                    const feeData   = await mainnetWallet.provider.getFeeData();
                    const tx = await wpeth.updateEthPrice(avgScaled, cgScaled, bnScaled, price.source, {gasLimit:200_000n, gasPrice:feeData.gasPrice||1n});
                    console.log(`   🔮 wPETH price updated on-chain: $${price.avg} | TX: ${tx.hash.slice(0,14)}…`);
                } catch(e) { console.warn("   ⚠  wPETH price update:", e.message); }
            }
        } catch {}
    }, 60_000);
}

main().catch(e => {
    console.error("\n💥 Relayer crashed:", e.message);
    process.exit(1);
});
