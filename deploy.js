// ============================================================
//  deploy.js — PrivateBridge.sol
//  OpenClaw Chain (123456) → Ethereum Mainnet (1) DIRECT
//  ─────────────────────────────────────────────────────────
//  Leg A: Lock 10 ETH  → relayer sends ETH on mainnet
//  Leg B: Lock sUSDC   → relayer sends USDT on mainnet
//  Compiles with solc · Verifies on-chain · Saves ABI
//
//  Usage:
//    npm install ethers solc dotenv
//    node deploy.js                    → deploy PrivateBridge + lock 10 ETH
//    node deploy.js --deploy-wpeth     → deploy wPETH ERC-20 on Mainnet (~$0.10)
//    node deploy.js --update-price     → push live CG+BN price to wPETH oracle
//    node deploy.js --lock-eth         → lock ETH on private chain (relayer mints wPETH)
//    node deploy.js --amount 5         → lock 5 ETH
//    node deploy.js --lock-token 100   → lock 100 sUSDC
//    node deploy.js --verify-only      → verify existing PrivateBridge deployment
// ============================================================
require("dotenv").config();
const { ethers } = require("ethers");
const solc       = require("solc");
const fs         = require("fs");
const path       = require("path");

// ── CLI ────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const VERIFY_ONLY    = args.includes("--verify-only");
const LOCK_ETH       = args.includes("--lock-eth");
const LOCK_TOKEN     = args.includes("--lock-token");
const DEPLOY_WPETH   = args.includes("--deploy-wpeth");
const UPDATE_PRICE   = args.includes("--update-price");
const ETH_AMT        = args[args.indexOf("--amount")+1]     || "10";
const TOKEN_AMT      = args[args.indexOf("--lock-token")+1]  || "100";

// ── Config ─────────────────────────────────────────────────
const PRIVATE_RPC         = process.env.RPC_URL                  || "http://127.0.0.1:8545";
const DEPLOYER_KEY        = process.env.DEPLOYER_PRIVATE_KEY;
const MAINNET_SENDER_KEY  = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
const OWNER_ADDRESS       = process.env.OWNER_ADDRESS            || "0x43DB3aeAd04E7057De1a96dB79a300e94e79eB75";
const MAINNET_RECIPIENT   = process.env.MAINNET_RECIPIENT_ADDRESS || OWNER_ADDRESS;
const SUSDC_ADDRESS       = process.env.SUSDC_CONTRACT_ADDRESS   || "0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8";
const USDT_MAINNET        = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
// Set DESTINATION=optimism_mainnet or DESTINATION=optimism_sepolia in .env
const DESTINATION_TARGET  = process.env.DESTINATION_TARGET || "optimism_sepolia";
const OPTIMISM_CONFIGS = {
    optimism_mainnet: { chainId:10,        name:"Optimism Mainnet",  rpc:"https://mainnet.optimism.io",               explorer:"https://optimistic.etherscan.io" },
    optimism_sepolia: { chainId:11155420,  name:"Optimism Sepolia",  rpc:"https://sepolia.optimism.io",               explorer:"https://sepolia-optimism.etherscan.io" },
    mainnet:          { chainId:1,         name:"Ethereum Mainnet",  rpc:"https://ethereum.publicnode.com",           explorer:"https://etherscan.io" },
};
const OPTIMISM_CFG    = OPTIMISM_CONFIGS[DESTINATION_TARGET] || OPTIMISM_CONFIGS.optimism_sepolia;
const DESTINATION_CHAIN = OPTIMISM_CFG.chainId;
const DESTINATION_RPC   = process.env.DESTINATION_RPC_URL || OPTIMISM_CFG.rpc;
const OUTPUT_DIR          = path.join(__dirname, "artifacts");
const WPETH_ADDRESS       = process.env.WPETH_ADDRESS || null;

// wPETH ABI (WrappedPrivateETH ERC-20 on Mainnet)
const WPETH_ABI = [
    "function mint(address to, uint256 amount, bytes32 requestId) returns (bool)",
    "function updateEthPrice(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string calldata source) external",
    "function getStats() view returns (uint256 supply, uint256 minted, uint256 burned, uint256 price, uint256 cg, uint256 bn, uint256 updatedAt, string memory source)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function owner() view returns (address)",
    "function minter() view returns (address)",
    "function ethPriceUSD() view returns (uint256)",
    "function priceSource() view returns (string)",
    "event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD)",
    "event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp)",
];

// wPETH Solidity source (hardcoded — no external file needed)
const WPETH_SOLIDITY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  WrappedPrivateETH (wPETH) — ERC-20 on Ethereum Mainnet
//  Minted 1:1 when ETH is locked on OpenClaw private chain
//  1 wPETH = 1 ETH value (tracked via CoinGecko + Binance)
//  Price oracle updated by relayer at every mint event
//  Lock ETH on private chain → Relayer mints wPETH on Mainnet
//  Burn wPETH → Relayer releases ETH on private chain
// ============================================================
contract WrappedPrivateETH {
    string  public name     = "Wrapped Private ETH";
    string  public symbol   = "wPETH";
    uint8   public decimals = 18;

    address public owner;
    address public minter;        // relayer — can mint/burn/update price
    uint256 public totalSupply;
    uint256 public totalMinted;
    uint256 public totalBurned;

    // Price oracle — ETH price in USD scaled by 1e8
    // e.g. $1854.32 → 185432000000
    uint256 public ethPriceUSD;
    uint256 public cgPriceUSD;    // CoinGecko component
    uint256 public bnPriceUSD;    // Binance component
    uint256 public priceUpdatedAt;
    string  public priceSource;   // "coingecko+binance"

    // Private chain info (reference only)
    uint256 public privateChainId  = 123456;
    address public bridgeContract; // PrivateBridge on private chain
    string  public bridgeNote = "Lock ETH on private chain 123456 to mint wPETH on Mainnet";

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(bytes32 => bool)    public processedRequests;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Minted(address indexed to, uint256 amount, bytes32 indexed requestId, uint256 ethPriceUSD);
    event Burned(address indexed from, uint256 amount, string privateRecipient);
    event PriceUpdated(uint256 avgUSD, uint256 cgUSD, uint256 bnUSD, string source, uint256 timestamp);
    event MinterUpdated(address newMinter);
    event BridgeContractUpdated(address newBridge);

    modifier onlyOwner()  { require(msg.sender == owner,  "Not owner");  _; }
    modifier onlyMinter() { require(msg.sender == minter || msg.sender == owner, "Not minter"); _; }

    constructor(address _minter, address _bridge) {
        owner         = msg.sender;
        minter        = _minter;
        bridgeContract= _bridge;
    }

    // ── Mint wPETH (called by relayer on ETHLocked event) ──
    // requestId prevents double-minting the same bridge tx
    function mint(
        address to,
        uint256 amount,
        bytes32 requestId
    ) external onlyMinter returns (bool) {
        require(!processedRequests[requestId], "Request already processed");
        processedRequests[requestId] = true;
        totalSupply += amount;
        balanceOf[to] += amount;
        totalMinted += amount;
        emit Transfer(address(0), to, amount);
        emit Minted(to, amount, requestId, ethPriceUSD);
        return true;
    }

    // ── Burn wPETH to redeem ETH on private chain ──────────
    // privateRecipient: address on private chain to receive ETH
    function burn(uint256 amount, string calldata privateRecipient) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient wPETH balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burned(msg.sender, amount, privateRecipient);
        return true;
    }

    // ── Price oracle update (relayer calls this at every mint) ──
    // Prices are ETH USD * 1e8 (e.g. $1854.32 → 185432000000)
    function updateEthPrice(
        uint256 _avgUSD,
        uint256 _cgUSD,
        uint256 _bnUSD,
        string calldata _source
    ) external onlyMinter {
        ethPriceUSD    = _avgUSD;
        cgPriceUSD     = _cgUSD;
        bnPriceUSD     = _bnUSD;
        priceSource    = _source;
        priceUpdatedAt = block.timestamp;
        emit PriceUpdated(_avgUSD, _cgUSD, _bnUSD, _source, block.timestamp);
    }

    // ── View: get wPETH portfolio value in USD ──────────────
    function getValueUSD(address account) external view returns (uint256) {
        if (ethPriceUSD == 0) return 0;
        return (balanceOf[account] * ethPriceUSD) / 1e8 / 1e18;
    }

    // ── View: full stats ────────────────────────────────────
    function getStats() external view returns (
        uint256 supply, uint256 minted, uint256 burned,
        uint256 price, uint256 cg, uint256 bn,
        uint256 updatedAt, string memory source
    ) {
        return (totalSupply, totalMinted, totalBurned,
                ethPriceUSD, cgPriceUSD, bnPriceUSD,
                priceUpdatedAt, priceSource);
    }

    // ── Admin ───────────────────────────────────────────────
    function setMinter(address newMinter) external onlyOwner {
        minter = newMinter;
        emit MinterUpdated(newMinter);
    }
    function setBridgeContract(address newBridge) external onlyOwner {
        bridgeContract = newBridge;
        emit BridgeContractUpdated(newBridge);
    }
    function setPrivateChainId(uint256 newId) external onlyOwner {
        privateChainId = newId;
    }

    // ── ERC-20 standard ─────────────────────────────────────
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient");
        require(allowance[from][msg.sender] >= amount, "Not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

if (!DEPLOYER_KEY) { console.error("❌  DEPLOYER_PRIVATE_KEY not set in .env"); process.exit(1); }

// ── Solidity Source ────────────────────────────────────────
// ── Solidity source hardcoded — no external .sol file needed ──
const SOLIDITY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  PrivateBridge.sol
//  OpenClaw Chain (123456) → Ethereum Mainnet (1) DIRECT
//  ─────────────────────────────────────────────────────────
//  Leg A: ETH bridge    → lock ETH,   relayer sends ETH on mainnet
//  Leg B: Token bridge  → lock sUSDC, relayer sends USDT on mainnet
//         sUSDC: 0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8
//         USDT:  0xdAC17F958D2ee523a2206206994597C13D831ec7
//  No tracking · No reserve check · No L2 hop
//  Price oracle: CoinGecko + Binance fetched simultaneously
// ============================================================

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract PrivateBridge {

    // ── State ──────────────────────────────────────────────
    address public owner;
    address public relayer;
    uint256 public bridgeFeeETH   = 0.001 ether;
    uint256 public bridgeFeeToken = 1e6;          // 1 sUSDC (6 decimals)
    uint256 public destinationChainId;
    uint16  public constant P2P_PORT = 30303;
    string  public relayerEnode;

    // ── Token Config ───────────────────────────────────────
    // sUSDC on private chain (source token to lock)
    address public susdc = 0x22f1f5eE41Df61E4d66dDA698b2120C74C9C3bE8;
    // USDT on Ethereum Mainnet (destination token — info only, not used on-chain)
    address public constant USDT_MAINNET = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    // ── ETH bridge requests ────────────────────────────────
    struct ETHRequest {
        address sender;
        address recipient;
        uint256 amount;
        uint256 timestamp;
        bool    processed;
    }
    mapping(bytes32 => ETHRequest) public ethRequests;
    bytes32[] public allETHRequests;

    // ── Token bridge requests ──────────────────────────────
    struct TokenRequest {
        address sender;
        address mainnetRecipient;
        uint256 amountLocked;     // sUSDC locked (wei, 6 decimals)
        address srcToken;         // sUSDC address on private chain
        address dstToken;         // USDT address on mainnet
        uint256 timestamp;
        bool    processed;
    }
    mapping(bytes32 => TokenRequest) public tokenRequests;
    bytes32[] public allTokenRequests;

    // ── Events ─────────────────────────────────────────────
    // ETH bridge
    event ETHLocked(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 indexed requestId
    );
    event ETHReleased(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed requestId
    );

    // Token bridge (sUSDC → USDT)
    event TokensLocked(
        address indexed sender,
        address indexed mainnetRecipient,
        uint256 amount,
        address srcToken,
        address dstToken,
        bytes32 indexed requestId
    );
    event TokensReleased(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed requestId
    );

    // Config events
    event BridgeFeeUpdated(uint256 ethFee, uint256 tokenFee);
    event RelayerUpdated(address newRelayer);
    event SusdcAddressUpdated(address newSusdc);

    // ── Modifiers ──────────────────────────────────────────
    modifier onlyOwner()   { require(msg.sender == owner,   "Not owner");   _; }
    modifier onlyRelayer() { require(msg.sender == relayer || msg.sender == owner, "Not relayer"); _; }

    // ── Constructor ────────────────────────────────────────
    constructor(address _relayer, uint256 _destinationChainId) {
        owner              = msg.sender;
        relayer            = _relayer;
        destinationChainId = _destinationChainId; // 1 = Ethereum Mainnet
    }

    // ══════════════════════════════════════════════════════
    //  LEG A — ETH BRIDGE
    //  Lock ETH on private chain → relayer sends ETH on mainnet
    // ══════════════════════════════════════════════════════

    /// @notice Lock ETH on private chain. Relayer detects ETHLocked
    ///         and sends ETH to \`mainnetRecipient\` on Ethereum Mainnet.
    /// @param mainnetRecipient Address on Ethereum Mainnet to receive ETH
    function lockETH(address mainnetRecipient) external payable returns (bytes32 requestId) {
        require(msg.value > bridgeFeeETH, "Amount below fee");
        require(mainnetRecipient != address(0), "Zero address");

        uint256 bridgeAmount = msg.value - bridgeFeeETH;
        requestId = keccak256(abi.encodePacked(
            msg.sender, mainnetRecipient, bridgeAmount,
            block.timestamp, allETHRequests.length
        ));

        ethRequests[requestId] = ETHRequest({
            sender:    msg.sender,
            recipient: mainnetRecipient,
            amount:    bridgeAmount,
            timestamp: block.timestamp,
            processed: false
        });
        allETHRequests.push(requestId);

        emit ETHLocked(msg.sender, mainnetRecipient, bridgeAmount, requestId);
    }

    /// @notice Called by relayer to mark ETH release as done (accounting only)
    function releaseETH(
        address payable recipient,
        uint256 amount,
        bytes32 requestId
    ) external onlyRelayer {
        require(!ethRequests[requestId].processed, "Already processed");
        ethRequests[requestId].processed = true;
        emit ETHReleased(recipient, amount, requestId);
    }

    // ══════════════════════════════════════════════════════
    //  LEG B — TOKEN BRIDGE (sUSDC → USDT)
    //  Lock sUSDC on private chain → relayer sends USDT on mainnet
    //  No tracking · No reserve · Direct send
    //  Price: CoinGecko + Binance simultaneously (off-chain)
    // ══════════════════════════════════════════════════════

    /// @notice Approve + Lock sUSDC in one call.
    ///         1. Call sUSDC.approve(bridgeAddress, amount) first (MetaMask Step 1)
    ///         2. Then call this function (MetaMask Step 2)
    ///         Relayer detects TokensLocked → sends USDT to mainnetRecipient
    /// @param mainnetRecipient Address on Ethereum Mainnet to receive USDT
    /// @param amount           Amount of sUSDC to lock (6 decimals, e.g. 100e6 = 100 sUSDC)
    function lockTokens(
        address mainnetRecipient,
        uint256 amount
    ) external returns (bytes32 requestId) {
        require(amount > bridgeFeeToken, "Amount below token fee");
        require(mainnetRecipient != address(0), "Zero recipient");

        IERC20 token = IERC20(susdc);
        require(
            token.allowance(msg.sender, address(this)) >= amount,
            "Approve sUSDC first: call sUSDC.approve(bridgeAddr, amount)"
        );

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        require(ok, "sUSDC transferFrom failed");

        uint256 bridgeAmount = amount - bridgeFeeToken;
        requestId = keccak256(abi.encodePacked(
            msg.sender, mainnetRecipient, bridgeAmount,
            susdc, USDT_MAINNET,
            block.timestamp, allTokenRequests.length
        ));

        tokenRequests[requestId] = TokenRequest({
            sender:          msg.sender,
            mainnetRecipient:mainnetRecipient,
            amountLocked:    bridgeAmount,
            srcToken:        susdc,
            dstToken:        USDT_MAINNET,
            timestamp:       block.timestamp,
            processed:       false
        });
        allTokenRequests.push(requestId);

        emit TokensLocked(
            msg.sender,
            mainnetRecipient,
            bridgeAmount,
            susdc,
            USDT_MAINNET,
            requestId
        );
    }

    /// @notice Called by relayer to mark token release as done (accounting only)
    function releaseTokens(
        address recipient,
        uint256 amount,
        bytes32 requestId
    ) external onlyRelayer {
        require(!tokenRequests[requestId].processed, "Already processed");
        tokenRequests[requestId].processed = true;
        emit TokensReleased(recipient, amount, requestId);
    }

    // ══════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════

    function getETHRequest(bytes32 id) external view returns (ETHRequest memory) {
        return ethRequests[id];
    }
    function getAllETHRequests() external view returns (bytes32[] memory) {
        return allETHRequests;
    }
    function getTokenRequest(bytes32 id) external view returns (TokenRequest memory) {
        return tokenRequests[id];
    }
    function getAllTokenRequests() external view returns (bytes32[] memory) {
        return allTokenRequests;
    }

    function getStats() external view returns (
        uint256 ethBalance,
        uint256 ethFee,
        uint256 totalETHRequests,
        uint256 susdcBalance,
        uint256 tokenFee,
        uint256 totalTokenRequests
    ) {
        return (
            address(this).balance,
            bridgeFeeETH,
            allETHRequests.length,
            IERC20(susdc).balanceOf(address(this)),
            bridgeFeeToken,
            allTokenRequests.length
        );
    }

    function getBridgeInfo() external view returns (
        address _owner,
        address _relayer,
        uint256 _dstChain,
        address _susdc,
        address _usdtMainnet,
        uint16  _p2pPort,
        uint256 _ethFee,
        uint256 _tokenFee
    ) {
        return (
            owner, relayer, destinationChainId,
            susdc, USDT_MAINNET, P2P_PORT,
            bridgeFeeETH, bridgeFeeToken
        );
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════

    function setRelayer(address newRelayer) external onlyOwner {
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }
    function setFees(uint256 ethFee, uint256 tokenFee) external onlyOwner {
        bridgeFeeETH   = ethFee;
        bridgeFeeToken = tokenFee;
        emit BridgeFeeUpdated(ethFee, tokenFee);
    }
    function setSusdc(address newSusdc) external onlyOwner {
        susdc = newSusdc;
        emit SusdcAddressUpdated(newSusdc);
    }
    function setRelayerP2PInfo(string calldata enode) external onlyRelayer {
        relayerEnode = enode;
    }
    function setDestinationChainId(uint256 newId) external onlyOwner {
        destinationChainId = newId;
    }

    // ── Withdraw ───────────────────────────────────────────
    function withdrawETH(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient ETH");
        payable(owner).transfer(amount);
    }
    function withdrawAllETH() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }
    function withdrawTokens(uint256 amount) external onlyOwner {
        IERC20(susdc).transfer(owner, amount);
    }
    function withdrawAllTokens() external onlyOwner {
        uint256 bal = IERC20(susdc).balanceOf(address(this));
        require(bal > 0, "No sUSDC");
        IERC20(susdc).transfer(owner, bal);
    }

    receive() external payable {}
}
`;

// ══════════════════════════════════════════════════════════
//  COMPILE
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  wPETH — compile + deploy on Mainnet
// ══════════════════════════════════════════════════════════
function compileWPETH() {
    console.log("🔧 Compiling WrappedPrivateETH.sol…");
    const input = {
        language: "Solidity",
        sources:  { "WrappedPrivateETH.sol": { content: WPETH_SOLIDITY } },
        settings: { outputSelection:{"*":{"*":["abi","evm.bytecode"]}}, optimizer:{enabled:true,runs:200}, evmVersion:"paris" },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (output.errors||[]).filter(e=>e.severity==="error");
    if (errors.length) { errors.forEach(e=>console.error("❌  ",e.formattedMessage)); process.exit(1); }
    const c = output.contracts["WrappedPrivateETH.sol"]["WrappedPrivateETH"];
    console.log("✅ wPETH compiled OK");
    return { abi:c.abi, bytecode:"0x"+c.evm.bytecode.object };
}

async function deployWPETH(mainnetProvider, mainnetWallet, bridgeAddr) {
    const minterAddr = mainnetWallet.address;
    console.log(`\n🪙 Deploying WrappedPrivateETH (wPETH) on Mainnet…`);
    console.log(`   Minter / Relayer: ${minterAddr}`);
    console.log(`   PrivateBridge:    ${bridgeAddr}`);
    const { abi, bytecode } = compileWPETH();
    const factory  = new ethers.ContractFactory(abi, bytecode, mainnetWallet);
    const feeData  = await mainnetProvider.getFeeData();
    const deployed = await factory.deploy(minterAddr, bridgeAddr||ethers.ZeroAddress, { gasLimit:2_500_000n, gasPrice:feeData.gasPrice||1n });
    console.log(`   TX: ${deployed.deploymentTransaction().hash}`);
    console.log("   ⏳ Waiting for Mainnet confirmation…");
    await deployed.waitForDeployment();
    const wpethAddr = await deployed.getAddress();
    const receipt   = await mainnetProvider.getTransactionReceipt(deployed.deploymentTransaction().hash);
    console.log(`
✅ wPETH DEPLOYED ON MAINNET:`);
    console.log(`   Address:     ${wpethAddr}`);
    console.log(`   Block:       #${receipt.blockNumber.toLocaleString()}`);
    console.log(`   Gas used:    ${receipt.gasUsed.toLocaleString()}`);
    console.log(`   Explorer:    https://etherscan.io/token/${wpethAddr}`);
    // Save ABI
    fs.mkdirSync(OUTPUT_DIR, {recursive:true});
    fs.writeFileSync(path.join(OUTPUT_DIR,"WrappedPrivateETH.abi.json"), JSON.stringify(abi,null,2));
    fs.writeFileSync(path.join(OUTPUT_DIR,"wpeth.env.txt"),
        `
# ── wPETH deployment (${new Date().toISOString()}) ──
WPETH_ADDRESS=${wpethAddr}
`);
    console.log(`
   📁 ABI saved:  artifacts/WrappedPrivateETH.abi.json`);
    console.log(`   📁 Env saved:  artifacts/wpeth.env.txt`);
    console.log(`
╔══════════════════════════════════════════════════════╗`);
    console.log(`║  ADD THIS TO YOUR .env:                               ║`);
    console.log(`║  WPETH_ADDRESS=${wpethAddr.slice(0,38)}║`);
    console.log(`╚══════════════════════════════════════════════════════╝
`);
    return { wpethAddr, abi };
}

function compile() {
    console.log("🔧 Compiling PrivateBridge.sol…");
    const input = {
        language: "Solidity",
        sources:  { "PrivateBridge.sol": { content: SOLIDITY_SOURCE } },
        settings: {
            outputSelection: { "*": { "*": ["abi","evm.bytecode","evm.deployedBytecode"] } },
            optimizer:       { enabled:true, runs:200 },
            evmVersion:      "paris",
        },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (output.errors||[]).filter(e=>e.severity==="error");
    if (errors.length) { errors.forEach(e=>console.error("❌  ",e.formattedMessage)); process.exit(1); }
    const contract = output.contracts["PrivateBridge.sol"]["PrivateBridge"];
    console.log("✅ Compiled OK");
    return {
        abi:              contract.abi,
        bytecode:         "0x"+contract.evm.bytecode.object,
        deployedBytecode: "0x"+contract.evm.deployedBytecode.object,
    };
}

// ══════════════════════════════════════════════════════════
//  PRICE ORACLE — CoinGecko + Binance simultaneously
// ══════════════════════════════════════════════════════════
async function fetchDualPrice() {
    const [cgR, bnR] = await Promise.allSettled([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null),
        fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null),
    ]);
    const cg = cgR.status==="fulfilled"&&cgR.value ? parseFloat(cgR.value.ethereum.usd) : null;
    const bn = bnR.status==="fulfilled"&&bnR.value ? parseFloat(bnR.value.price) : null;
    return { avg:cg&&bn?parseFloat(((cg+bn)/2).toFixed(2)):cg||bn||0, cg_usd:cg, bn_usd:bn, source:cg&&bn?"coingecko+binance":cg?"coingecko":"binance" };
}
async function fetchUSDTPrice() {
    const [cgR, bnR] = await Promise.allSettled([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null),
        fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDTBUSD",{signal:AbortSignal.timeout(9000)}).then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    const cg = cgR.status==="fulfilled"&&cgR.value ? parseFloat(cgR.value.tether?.usd||1) : null;
    const bn = bnR.status==="fulfilled"&&bnR.value ? parseFloat(bnR.value?.price||1) : null;
    return { avg:cg&&bn?parseFloat(((cg+bn)/2).toFixed(6)):cg||bn||1.0, cg_usd:cg, bn_usd:bn, source:cg&&bn?"coingecko+binance":cg?"coingecko":"binance" };
}

// ══════════════════════════════════════════════════════════
//  VERIFY — check on-chain state
// ══════════════════════════════════════════════════════════
async function verify(contract, deployerAddr, label="") {
    console.log(`\n${"─".repeat(58)}`);
    console.log(`🔍 Verifying PrivateBridge${label?" ["+label+"]":""}`);
    console.log(`${"─".repeat(58)}`);
    const addr = await contract.getAddress();
    const info = await contract.getBridgeInfo();
    const stats= await contract.getStats();
    const code = await contract.runner.provider.getCode(addr);
    const checks = [
        ["Contract",          addr,                          null],
        ["Owner",             info[0].toLowerCase(),         deployerAddr.toLowerCase()],
        ["Relayer",           info[1].toLowerCase(),         deployerAddr.toLowerCase()],
        ["Dest chain",        info[2].toString(),            String(DESTINATION_CHAIN)],
        ["sUSDC",             info[3].toLowerCase(),         SUSDC_ADDRESS.toLowerCase()],
        ["USDT mainnet",      info[4].toLowerCase(),         USDT_MAINNET.toLowerCase()],
        ["P2P port",          info[5].toString(),            "30303"],
        ["ETH fee",           ethers.formatEther(info[6])+" ETH", null],
        ["Token fee",         ethers.formatUnits(info[7],6)+" sUSDC", null],
        ["ETH balance",       ethers.formatEther(stats[0])+" ETH", null],
        ["sUSDC balance",     ethers.formatUnits(stats[3],6)+" sUSDC", null],
        ["ETH requests",      stats[2].toString(),           null],
        ["Token requests",    stats[5].toString(),           null],
        ["Bytecode size",     ((code.length-2)/2).toLocaleString()+" bytes", null],
    ];
    let ok = true;
    for (const [label, actual, expected] of checks) {
        if (!expected)           { console.log(`   ✅ ${label.padEnd(18)} ${actual}`); }
        else if (actual.toLowerCase()===expected.toLowerCase()) { console.log(`   ✅ ${label.padEnd(18)} ${actual}`); }
        else                     { console.log(`   ❌ ${label.padEnd(18)} ${actual} (expected ${expected})`); ok=false; }
    }
    console.log(`${"─".repeat(58)}`);
    console.log(ok?"✅ All checks passed":"❌ Some checks failed");
    return ok;
}

// ══════════════════════════════════════════════════════════
//  SAVE ARTIFACTS
// ══════════════════════════════════════════════════════════
function saveArtifacts({abi, bytecode, deployedBytecode, address, txHash, blockNumber, chainId, deployer}) {
    fs.mkdirSync(OUTPUT_DIR, {recursive:true});
    fs.writeFileSync(path.join(OUTPUT_DIR,"PrivateBridge.abi.json"),    JSON.stringify(abi,null,2));
    fs.writeFileSync(path.join(OUTPUT_DIR,"PrivateBridge.json"),        JSON.stringify({contractName:"PrivateBridge",abi,bytecode,deployedBytecode},null,2));
    fs.writeFileSync(path.join(OUTPUT_DIR,"deployment.json"),           JSON.stringify({contract:"PrivateBridge",address,tx_hash:txHash,block_number:blockNumber,chain_id:chainId,destination_chain_id:DESTINATION_CHAIN,deployer,susdc:SUSDC_ADDRESS,usdt_mainnet:USDT_MAINNET,deployed_at:new Date().toISOString(),direction:"private_to_mainnet_ETH_and_sUSDC_to_USDT",note:"No L2 hop"},null,2));
    fs.writeFileSync(path.join(OUTPUT_DIR,"bridge.env.txt"),
`\n# ── PrivateBridge deployment (${new Date().toISOString()}) ──\nPRIVATE_BRIDGE_ADDRESS=${address}\nPRIVATE_MAINNET_BRIDGE_ADDRESS=${address}\nTOKEN_BRIDGE_ADDRESS=${address}\n`);
    console.log(`\n📁 Artifacts saved to: ${OUTPUT_DIR}/`);
    console.log(`   PrivateBridge.abi.json`);
    console.log(`   PrivateBridge.json`);
    console.log(`   deployment.json`);
    console.log(`   bridge.env.txt  ← copy these lines into your .env`);
}

// ══════════════════════════════════════════════════════════
//  LOCK ETH — Leg A
// ══════════════════════════════════════════════════════════
async function lockETH(contract, wallet, amtETH) {
    const provider      = wallet.provider;
    const contractAddr  = await contract.getAddress();
    const fee           = await contract.bridgeFeeETH();
    const totalSend     = ethers.parseEther(amtETH) + fee;
    const bal           = await provider.getBalance(wallet.address);

    console.log(`\n💎 Locking ${amtETH} ETH on private chain → Mainnet`);
    console.log(`   Bridge fee:    ${ethers.formatEther(fee)} ETH`);
    console.log(`   Total sending: ${ethers.formatEther(totalSend)} ETH`);
    console.log(`   Recipient:     ${MAINNET_RECIPIENT} (Mainnet)`);

    // Fetch prices simultaneously
    const [ethP, usdtP] = await Promise.allSettled([fetchDualPrice(), fetchUSDTPrice()]);
    const eth  = ethP.status==="fulfilled"  ? ethP.value  : {avg:0,cg_usd:null,bn_usd:null,source:"unavailable"};
    const usdt = usdtP.status==="fulfilled" ? usdtP.value : {avg:1.0,cg_usd:null,bn_usd:null};
    console.log(`   ETH price:     $${eth.avg} [${eth.source}] CG:$${eth.cg_usd||"—"} BN:$${eth.bn_usd||"—"}`);
    console.log(`   USDT price:    $${usdt.avg} [${usdt.source}] CG:$${usdt.cg_usd||"—"} BN:$${usdt.bn_usd||"—"}`);
    console.log(`   Value USD:     ~$${(parseFloat(amtETH)*eth.avg).toFixed(2)}`);

    if (bal < totalSend + ethers.parseEther("0.005")) {
        console.error(`❌ Insufficient balance: ${ethers.formatEther(bal)} ETH`); process.exit(1);
    }
    const feeData = await provider.getFeeData();
    const tx      = await contract.lockETH(MAINNET_RECIPIENT, { value:totalSend, gasLimit:150_000n, gasPrice:feeData.gasPrice||1n });
    console.log(`   TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Block #${receipt.blockNumber} | ETH locked — relayer will send on Mainnet`);

    const iface = contract.interface;
    const log   = receipt.logs.map(l=>{try{return iface.parseLog(l);}catch{return null;}}).find(e=>e?.name==="ETHLocked");
    if (log) {
        const rid = log.args.requestId;
        console.log(`   Request ID: ${rid}`);
        fs.mkdirSync(OUTPUT_DIR,{recursive:true});
        fs.writeFileSync(path.join(OUTPUT_DIR,"last_eth_lock.json"), JSON.stringify({
            request_id:rid, amount_eth:amtETH, mainnet_recipient:MAINNET_RECIPIENT,
            tx_hash:tx.hash, block:receipt.blockNumber,
            eth_price_cg:eth.cg_usd, eth_price_bn:eth.bn_usd, eth_price_avg:eth.avg,
            usdt_price_cg:usdt.cg_usd, usdt_price_bn:usdt.bn_usd, usdt_price_avg:usdt.avg,
            locked_at:new Date().toISOString(), status:"pending"
        },null,2));
    }
}

// ══════════════════════════════════════════════════════════
//  LOCK TOKENS — Leg B (sUSDC → USDT)
// ══════════════════════════════════════════════════════════
async function lockTokens(contract, wallet, amtSUSDC) {
    const provider     = wallet.provider;
    const contractAddr = await contract.getAddress();
    const amtWei       = ethers.parseUnits(amtSUSDC, 6);
    const tokenFee     = await contract.bridgeFeeToken();
    const susdc        = new ethers.Contract(SUSDC_ADDRESS, [
        "function approve(address spender, uint256 amount) returns (bool)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
        "function transfer(address to, uint256 amount) returns (bool)",
    ], wallet);

    console.log(`\n🪙 Locking ${amtSUSDC} sUSDC on private chain → USDT on Mainnet`);
    console.log(`   sUSDC:         ${SUSDC_ADDRESS}`);
    console.log(`   USDT mainnet:  ${USDT_MAINNET}`);
    console.log(`   Recipient:     ${MAINNET_RECIPIENT} (Mainnet)`);
    console.log(`   Token fee:     ${ethers.formatUnits(tokenFee,6)} sUSDC`);

    // Fetch USDT price on both chains simultaneously
    const [ethP, usdtP] = await Promise.allSettled([fetchDualPrice(), fetchUSDTPrice()]);
    const eth  = ethP.status==="fulfilled"  ? ethP.value  : {avg:0,source:"unavailable"};
    const usdt = usdtP.status==="fulfilled" ? usdtP.value : {avg:1.0,cg_usd:null,bn_usd:null,source:"cached"};
    console.log(`   USDT price:    $${usdt.avg} [${usdt.source}] CG:$${usdt.cg_usd||"—"} BN:$${usdt.bn_usd||"—"}`);
    console.log(`   ETH price:     $${eth.avg} [${eth.source}]`);
    console.log(`   Value USD:     ~$${(parseFloat(amtSUSDC)*usdt.avg).toFixed(2)}`);

    // Check balance
    const bal = await susdc.balanceOf(wallet.address);
    console.log(`   sUSDC balance: ${ethers.formatUnits(bal,6)} sUSDC`);
    if (bal < amtWei) { console.error(`❌ Insufficient sUSDC`); process.exit(1); }

    // Step 1: Approve
    const allowance = await susdc.allowance(wallet.address, contractAddr);
    if (allowance < amtWei) {
        console.log(`   ⏳ Step 1: Approving sUSDC…`);
        const feeData = await provider.getFeeData();
        const approveTx = await susdc.approve(contractAddr, amtWei, { gasLimit:80_000n, gasPrice:feeData.gasPrice||1n });
        await approveTx.wait();
        console.log(`   ✅ Approved: ${approveTx.hash}`);
    } else {
        console.log(`   ✅ Already approved`);
    }

    // Step 2: Lock
    console.log(`   ⏳ Step 2: Locking sUSDC in bridge…`);
    const feeData = await contract.runner.provider.getFeeData();
    const tx = await contract.lockTokens(MAINNET_RECIPIENT, amtWei, { gasLimit:200_000n, gasPrice:feeData.gasPrice||1n });
    console.log(`   TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Block #${receipt.blockNumber} | sUSDC locked — relayer sends USDT on Mainnet`);

    const iface = contract.interface;
    const log   = receipt.logs.map(l=>{try{return iface.parseLog(l);}catch{return null;}}).find(e=>e?.name==="TokensLocked");
    if (log) {
        const rid = log.args.requestId;
        console.log(`   Request ID:  ${rid}`);
        console.log(`   Amount:      ${ethers.formatUnits(log.args.amount,6)} sUSDC locked`);
        console.log(`   Recipient gets USDT at ${USDT_MAINNET} on Mainnet`);
        fs.mkdirSync(OUTPUT_DIR,{recursive:true});
        fs.writeFileSync(path.join(OUTPUT_DIR,"last_token_lock.json"), JSON.stringify({
            request_id:rid, amount_susdc:amtSUSDC,
            src_token:SUSDC_ADDRESS, dst_token:USDT_MAINNET,
            mainnet_recipient:MAINNET_RECIPIENT,
            tx_hash:tx.hash, block:receipt.blockNumber,
            usdt_price_cg:usdt.cg_usd, usdt_price_bn:usdt.bn_usd, usdt_price_avg:usdt.avg,
            eth_price_cg:eth.cg_usd, eth_price_bn:eth.bn_usd, eth_price_avg:eth.avg,
            locked_at:new Date().toISOString(), status:"pending"
        },null,2));
    }
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
async function main() {
    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  PrivateBridge Deploy — OpenClaw Chain → Mainnet + wPETH  ║");
    console.log("║  --deploy-wpeth · --update-price · --lock-eth · --amount  ║");
    console.log(`║  RPC:    ${PRIVATE_RPC.padEnd(51)}║`);
    console.log(`║  Target: ${OPTIMISM_CFG.name.padEnd(51)}║`);
    console.log(`║  Dst RPC:${DESTINATION_RPC.padEnd(51)}║`);
    console.log(`║  Owner:  ${OWNER_ADDRESS.padEnd(51)}║`);
    console.log("╚═══════════════════════════════════════════════════════════╝\n");

    const provider = new ethers.JsonRpcProvider(PRIVATE_RPC);
    const wallet   = new ethers.Wallet(DEPLOYER_KEY, provider);
    const network  = await provider.getNetwork();
    const chainId  = Number(network.chainId);
    const balance  = await provider.getBalance(wallet.address);

    console.log(`📡 Chain ID:    ${chainId}`);
    console.log(`👛 Deployer:   ${wallet.address}`);
    console.log(`💰 Balance:    ${parseFloat(ethers.formatEther(balance)).toFixed(4)} ETH\n`);

    // Fetch live prices on both chains simultaneously before deploy
    console.log("🔮 Fetching prices (CoinGecko + Binance simultaneously)…");
    const [ethP, usdtP] = await Promise.allSettled([fetchDualPrice(), fetchUSDTPrice()]);
    const ethPrice  = ethP.status==="fulfilled"  ? ethP.value  : null;
    const usdtPrice = usdtP.status==="fulfilled" ? usdtP.value : null;
    if (ethPrice)  console.log(`💰 ETH:  $${ethPrice.avg}  [${ethPrice.source}] CG:$${ethPrice.cg_usd} BN:$${ethPrice.bn_usd}`);
    if (usdtPrice) console.log(`💵 USDT: $${usdtPrice.avg} [${usdtPrice.source}] CG:$${usdtPrice.cg_usd} BN:$${usdtPrice.bn_usd}`);

    const { abi, bytecode, deployedBytecode } = compile();

    // ── --deploy-wpeth ────────────────────────────────────
    //  Deploys wPETH ERC-20 on Mainnet. Costs ~$0.10 gas.
    //  Does NOT need the private chain tunnel.
    //  After deploy: copy WPETH_ADDRESS=0x... into .env
    if (DEPLOY_WPETH) {
        if (!MAINNET_SENDER_KEY) { console.error("❌  RELAYER_PRIVATE_KEY not set in .env"); process.exit(1); }
        const mainnetRPC      = process.env.ETH_MAINNET_RPC_URL || "https://ethereum.publicnode.com";
        const mainnetProvider = new ethers.JsonRpcProvider(mainnetRPC);
        const mainnetWallet   = new ethers.Wallet(MAINNET_SENDER_KEY, mainnetProvider);
        const mainBal         = await mainnetProvider.getBalance(mainnetWallet.address);
        console.log(`💰 Mainnet wallet: ${mainnetWallet.address}`);
        console.log(`💰 Mainnet balance: ${ethers.formatEther(mainBal)} ETH`);
        if (mainBal < ethers.parseEther("0.001")) {
            console.error("❌  Need at least 0.001 ETH on Mainnet for gas"); process.exit(1);
        }
        // Fetch live ETH price before deploy
        const priceData = await fetchDualPrice().catch(()=>null);
        if (priceData) console.log(`💰 ETH: $${priceData.avg} [${priceData.source}] CG:$${priceData.cg_usd} BN:$${priceData.bn_usd}`);
        const bridgeAddr = process.env.PRIVATE_BRIDGE_ADDRESS || "0xDD7917A79515FeaA5Ce15Fa84E8c74b931Dec990";
        const { wpethAddr, abi } = await deployWPETH(mainnetProvider, mainnetWallet, bridgeAddr);
        // Set initial ETH price on the wPETH contract
        if (priceData && priceData.avg > 0) {
            console.log(`
🔮 Setting initial ETH price oracle on wPETH…`);
            const wpeth     = new ethers.Contract(wpethAddr, WPETH_ABI, mainnetWallet);
            const avgScaled = BigInt(Math.round(priceData.avg     * 1e8));
            const cgScaled  = BigInt(Math.round((priceData.cg_usd||priceData.avg) * 1e8));
            const bnScaled  = BigInt(Math.round((priceData.bn_usd||priceData.avg) * 1e8));
            const feeData   = await mainnetProvider.getFeeData();
            const priceTx   = await wpeth.updateEthPrice(avgScaled, cgScaled, bnScaled, priceData.source, {gasLimit:120_000n, gasPrice:feeData.gasPrice||1n});
            await priceTx.wait();
            console.log(`✅ Initial price set: $${priceData.avg} [${priceData.source}]`);
            console.log(`   CG: $${priceData.cg_usd}  BN: $${priceData.bn_usd}`);
        }
        return;
    }

    // ── --update-price ─────────────────────────────────────
    //  Push live CG+BN ETH price to wPETH contract on Mainnet
    if (UPDATE_PRICE) {
        if (!WPETH_ADDRESS)       { console.error("❌  WPETH_ADDRESS not set in .env"); process.exit(1); }
        if (!MAINNET_SENDER_KEY)  { console.error("❌  RELAYER_PRIVATE_KEY not set in .env"); process.exit(1); }
        const mainnetRPC      = process.env.ETH_MAINNET_RPC_URL || "https://ethereum.publicnode.com";
        const mainnetProvider = new ethers.JsonRpcProvider(mainnetRPC);
        const mainnetWallet   = new ethers.Wallet(MAINNET_SENDER_KEY, mainnetProvider);
        const wpeth           = new ethers.Contract(WPETH_ADDRESS, WPETH_ABI, mainnetWallet);
        const priceData       = await fetchDualPrice();
        console.log(`💰 ETH: $${priceData.avg} [${priceData.source}] CG:$${priceData.cg_usd} BN:$${priceData.bn_usd}`);
        const avgScaled = BigInt(Math.round(priceData.avg     * 1e8));
        const cgScaled  = BigInt(Math.round((priceData.cg_usd||priceData.avg) * 1e8));
        const bnScaled  = BigInt(Math.round((priceData.bn_usd||priceData.avg) * 1e8));
        const feeData   = await mainnetProvider.getFeeData();
        const tx        = await wpeth.updateEthPrice(avgScaled, cgScaled, bnScaled, priceData.source, {gasLimit:120_000n, gasPrice:feeData.gasPrice||1n});
        const receipt   = await tx.wait();
        console.log(`✅ wPETH price updated on Mainnet: $${priceData.avg}`);
        console.log(`   TX:    ${tx.hash}`);
        console.log(`   Block: #${receipt.blockNumber}`);
        console.log(`   wPETH: ${WPETH_ADDRESS}`);
        return;
    }

    // ── --verify-only ──────────────────────────────────────
    if (VERIFY_ONLY) {
        const addr = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS;
        if (!addr) { console.error("❌  PRIVATE_BRIDGE_ADDRESS not set"); process.exit(1); }
        const contract = new ethers.Contract(addr, abi, wallet);
        await verify(contract, wallet.address, "existing");
        return;
    }

    // ── --lock-eth only ────────────────────────────────────
    if (LOCK_ETH) {
        const addr = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS;
        if (!addr) { console.error("❌  PRIVATE_BRIDGE_ADDRESS not set"); process.exit(1); }
        await lockETH(new ethers.Contract(addr, abi, wallet), wallet, ETH_AMT);
        return;
    }

    // ── --lock-token only ──────────────────────────────────
    if (LOCK_TOKEN) {
        const addr = process.env.PRIVATE_BRIDGE_ADDRESS || process.env.PRIVATE_MAINNET_BRIDGE_ADDRESS;
        if (!addr) { console.error("❌  PRIVATE_BRIDGE_ADDRESS not set"); process.exit(1); }
        await lockTokens(new ethers.Contract(addr, abi, wallet), wallet, TOKEN_AMT);
        return;
    }

    // ═══════════════════════════════════════════════════════
    //  STEP 1 — DEPLOY
    // ═══════════════════════════════════════════════════════
    console.log("\n📦 Step 1 — Deploying PrivateBridge.sol…");
    const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
    const feeData  = await provider.getFeeData();
    const deployed = await factory.deploy(wallet.address, DESTINATION_CHAIN, { gasLimit:2_000_000n, gasPrice:feeData.gasPrice||1n });
    console.log(`   TX: ${deployed.deploymentTransaction().hash}`);
    console.log("   ⏳ Waiting for confirmation…");
    await deployed.waitForDeployment();
    const contractAddress = await deployed.getAddress();
    const deployReceipt   = await provider.getTransactionReceipt(deployed.deploymentTransaction().hash);
    console.log(`\n✅ DEPLOYED:`);
    console.log(`   Address:  ${contractAddress}`);
    console.log(`   Block:    #${deployReceipt.blockNumber.toLocaleString()}`);
    console.log(`   Gas used: ${deployReceipt.gasUsed.toLocaleString()}`);

    const contract = new ethers.Contract(contractAddress, abi, wallet);

    // ═══════════════════════════════════════════════════════
    //  STEP 2 — VERIFY
    // ═══════════════════════════════════════════════════════
    console.log("\n📦 Step 2 — Verifying…");
    await verify(contract, wallet.address, "fresh deploy");

    // ═══════════════════════════════════════════════════════
    //  STEP 3 — SAVE ARTIFACTS + ABI
    // ═══════════════════════════════════════════════════════
    console.log("\n📦 Step 3 — Saving ABI + artifacts…");
    saveArtifacts({ abi, bytecode, deployedBytecode, address:contractAddress, txHash:deployReceipt.hash, blockNumber:deployReceipt.blockNumber, chainId, deployer:wallet.address });

    // ═══════════════════════════════════════════════════════
    //  STEP 4 — LOCK 10 ETH (Leg A)
    // ═══════════════════════════════════════════════════════
    console.log(`\n📦 Step 4 — Locking ${ETH_AMT} ETH (Leg A: private → mainnet direct)…`);
    await lockETH(contract, wallet, ETH_AMT);

    // ═══════════════════════════════════════════════════════
    //  STEP 5 — FINAL VERIFY
    // ═══════════════════════════════════════════════════════
    console.log("\n📦 Step 5 — Final verification…");
    await verify(contract, wallet.address, "post-lock");

    // ── Summary ────────────────────────────────────────────
    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  ✅ COMPLETE                                               ║");
    console.log(`║  Contract: ${contractAddress.padEnd(49)}║`);
    console.log(`║  Locked:   ${ETH_AMT} ETH → Mainnet recipient (chain 1)            ║`.slice(0,63)+"║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║  ADD TO YOUR .env:                                         ║");
    console.log(`║  PRIVATE_BRIDGE_ADDRESS=${contractAddress.slice(0,38)}║`);
    console.log(`║  TOKEN_BRIDGE_ADDRESS=${contractAddress.slice(0,40)}║`);
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║  LOCK sUSDC (Leg B):                                       ║");
    console.log("║  node deploy.js --lock-token 100                           ║");
    console.log("╚═══════════════════════════════════════════════════════════╝\n");
}

main().catch(e => {
    console.error("\n💥 Failed:", e.message);
    if (e.data) console.error("   Revert:", e.data);
    process.exit(1);
});



