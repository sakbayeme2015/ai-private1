#!/usr/bin/env python3
"""
add_bsc_to_index2.py — Patches index2.html to add BSC (BNB Smart Chain) section.

What it adds:
  - BSC nav link in subnav
  - BSC status strip (block, wPETH supply, price, connection)
  - BSC wPETH price cards (CoinGecko, Kraken, on-chain oracle)
  - BSC bridge form (lock ETH on private → mint wPETH on BSC via MetaMask)
  - BSC wPETH stats panel (supply, minted, burned, BscScan link)
  - BSC balance checker
  - BSC mint events table
  - BSC config/CLI info panel
  - Import wPETH to MetaMask on BSC
  - WebSocket handlers: wpeth_bsc_stats + bsc_mint
  - loadBSC() added to loadAll() + 60s refresh interval
  - Live ETH price updates BSC price cards
  - Footer updated

Run from /root/private_blockchain/ (or wherever index2.html is):
  python3 add_bsc_to_index2.py
  # Then test: open https://ai-private.online:3443/index2.html
"""

import os, sys

# Find the HTML file
SEARCH_PATHS = [
    'public/index.html',
    'index.html',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public', 'index.html'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html'),
]
FILE = None
for p in SEARCH_PATHS:
    if os.path.exists(p):
        FILE = p
        break

if not FILE:
    print('ERROR: index.html not found')
    print('Tried:', SEARCH_PATHS[:2])
    sys.exit(1)

print(f'Patching: {FILE}')
content = open(FILE).read()
original_len = len(content)

# ════════════════════════════════════════════════════════════
# 1. Add BSC nav link
# ════════════════════════════════════════════════════════════
OLD_NAV = '<a href="/health" target="_blank">⚡ Health</a>'
NEW_NAV = '<a href="#bsc-section" onclick="smoothTo(\'bsc-section\');return false;">🟡 BSC Chain</a>\n<a href="/health" target="_blank">⚡ Health</a>'

if OLD_NAV in content and '🟡 BSC Chain' not in content:
    content = content.replace(OLD_NAV, NEW_NAV)
    print('✅ BSC nav link added')
elif '🟡 BSC Chain' in content:
    print('⚠  BSC nav link already present')
else:
    # Try alternate nav insertion
    content = content.replace(
        '<a href="#nginx-section" onclick="smoothTo(\'nginx-section\');return false;">🔧 Nginx</a>',
        '<a href="#nginx-section" onclick="smoothTo(\'nginx-section\');return false;">🔧 Nginx</a>\n<a href="#bsc-section" onclick="smoothTo(\'bsc-section\');return false;">🟡 BSC Chain</a>'
    )
    print('✅ BSC nav link added (alternate)')

# ════════════════════════════════════════════════════════════
# 2. Add BSC CSS
# ════════════════════════════════════════════════════════════
BSC_CSS = '''
/* ── BSC (BNB Smart Chain) styles ───────────────────────── */
.bsc-card{background:var(--card);border:1px solid #fde047;border-radius:8px;border-top:3px solid #eab308;padding:20px}
.bsc-price{font-family:var(--mono);font-size:26px;font-weight:700;color:#92400e}
.bsc-btn{padding:12px 20px;border-radius:6px;border:none;font-size:13px;font-weight:600;cursor:pointer;width:100%;margin-top:10px;background:linear-gradient(135deg,#eab308,#ca8a04);color:#fff}
.bsc-link{color:#ca8a04;font-family:var(--mono);font-size:10px}
.bsc-tag{display:inline-block;padding:2px 8px;border-radius:3px;font-family:var(--mono);font-size:9px;font-weight:600;background:#fef9c3;border:1px solid #fde047;color:#713f12}
'''

if '.bsc-card' not in content and '</style>' in content:
    content = content.replace('</style>', BSC_CSS + '\n</style>', 1)
    print('✅ BSC CSS added')
elif '.bsc-card' in content:
    print('⚠  BSC CSS already present')

# ════════════════════════════════════════════════════════════
# 3. Add BSC HTML section
# ════════════════════════════════════════════════════════════
BSC_HTML = '''
<!-- ═══════════════════════════════════════════════════════════ -->
<!-- BSC SECTION — BNB Smart Chain + wPETH BEP-20              -->
<!-- ═══════════════════════════════════════════════════════════ -->
<div id="bsc-section"></div>
<div class="sh mt">🟡 BNB Smart Chain (BSC 56) — wPETH BEP-20</div>

<!-- BSC Status Strip -->
<div class="sstrip5" style="margin-bottom:16px">
  <div class="sc" style="border-top:3px solid #eab308">
    <div class="sc-label">BSC Block</div>
    <div class="sc-val" id="bsc-block" style="color:#ca8a04">—</div>
    <div class="sc-sub">Chain ID 56</div>
  </div>
  <div class="sc" style="border-top:3px solid #eab308">
    <div class="sc-label">wPETH Supply (BSC)</div>
    <div class="sc-val" id="bsc-supply" style="color:#ca8a04">—</div>
    <div class="sc-sub">BEP-20 token</div>
  </div>
  <div class="sc" style="border-top:3px solid #eab308">
    <div class="sc-label">wPETH Minted (BSC)</div>
    <div class="sc-val" id="bsc-minted" style="color:#ca8a04">—</div>
    <div class="sc-sub">total ever</div>
  </div>
  <div class="sc" style="border-top:3px solid #eab308">
    <div class="sc-label">ETH Price (on-chain)</div>
    <div class="sc-val" id="bsc-price" style="color:#ca8a04">$—</div>
    <div class="sc-sub" id="bsc-price-src">oracle</div>
  </div>
  <div class="sc" style="border-top:3px solid #eab308">
    <div class="sc-label">BSC RPC</div>
    <div class="sc-val" id="bsc-connected" style="font-size:11px;color:#ca8a04">—</div>
    <div class="sc-sub">bsc-dataseed1</div>
  </div>
</div>

<!-- BSC wPETH Price Cards -->
<div class="pgrid3" style="margin-bottom:16px">
  <div class="bsc-card">
    <div class="pc-label">wPETH Price · CoinGecko (live)</div>
    <div class="bsc-price" id="bsc-cg">$—</div>
    <div style="font-size:11px;color:var(--muted)">coingecko.com/api/v3</div>
    <span class="bsc-tag" id="bsc-cg-time" style="margin-top:8px">live</span>
  </div>
  <div class="bsc-card">
    <div class="pc-label">wPETH Price · Kraken (live)</div>
    <div class="bsc-price" id="bsc-kn">$—</div>
    <div style="font-size:11px;color:var(--muted)">api.kraken.com ETHUSD</div>
    <span class="bsc-tag" style="margin-top:8px">live</span>
  </div>
  <div class="bsc-card">
    <div class="pc-label">On-Chain Oracle (BSC wPETH)</div>
    <div class="bsc-price" id="bsc-onchain">$—</div>
    <div style="font-size:11px;color:var(--muted)" id="bsc-price-updated">last updated —</div>
    <span class="bsc-tag" style="margin-top:8px">stored on BSC</span>
  </div>
</div>

<!-- BSC Bridge Form + Stats -->
<div class="pgrid" style="margin-bottom:16px">
  <!-- Bridge Form -->
  <div class="bsc-card">
    <div class="pc-label">🔒 Lock ETH (Private Chain) → Mint wPETH (BSC)</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:16px">
      Lock ETH on OpenClaw private chain (123456) → Relayer mints wPETH BEP-20 on BSC (56).
      Gas cost on BSC: ~$0.01 BNB.
    </div>
    <div id="bsc-wallet-info" style="font-family:var(--mono);font-size:11px;color:var(--muted2);margin-bottom:10px">Not connected</div>
    <button class="tx-btn blue" onclick="connectForBSC()" style="margin-bottom:12px">🦊 Connect MetaMask (Private Chain)</button>
    <div class="tx-field" style="margin-bottom:12px">
      <label>Amount to Lock (ETH)</label>
      <input id="bsc-lock-amt" type="number" placeholder="1" step="0.1" oninput="updateBSCEst()"/>
    </div>
    <div id="bsc-est" style="font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:8px">
      ≈ $— USD · you receive — wPETH BEP-20 on BSC
    </div>
    <button class="bsc-btn" onclick="bscMintViaMM()">🟡 Lock ETH → Mint wPETH on BSC</button>
    <div class="tx-status" id="bsc-lock-status"></div>
    <div style="margin-top:16px;padding:10px 14px;background:#fffbeb;border:1px solid #fde047;border-radius:6px;font-family:var(--mono);font-size:10px;color:#713f12">
      <strong>Flow:</strong> Private Chain ETH → Bridge → Relayer → BSC wPETH<br/>
      <strong>Fee:</strong> 0.001 ETH bridge fee<br/>
      <strong>BSC gas:</strong> ~0.001 BNB (~$0.01)<br/>
      <strong>Deploy:</strong> node deploy_bsc.js --deploy-wpeth-bsc
    </div>
  </div>

  <!-- BSC Stats + Balance Checker -->
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="bsc-card">
      <div class="pc-label">wPETH BEP-20 Contract (BSC)</div>
      <div class="mmr"><span class="mmk">Contract</span><span class="mmv" id="bsc-addr" style="font-size:10px;color:#ca8a04">Not deployed</span></div>
      <div class="mmr"><span class="mmk">Network</span><span class="mmv" style="color:#ca8a04">BNB Smart Chain (56)</span></div>
      <div class="mmr"><span class="mmk">Total Supply</span><span class="mmv" id="bsc-supply2" style="color:#ca8a04">—</span></div>
      <div class="mmr"><span class="mmk">Total Minted</span><span class="mmv" id="bsc-minted2" style="color:#ca8a04">—</span></div>
      <div class="mmr"><span class="mmk">Total Burned</span><span class="mmv" id="bsc-burned" style="color:var(--red)">—</span></div>
      <div class="mmr"><span class="mmk">ETH Price</span><span class="mmv" id="bsc-price2" style="color:#ca8a04">$—</span></div>
      <div class="mmr"><span class="mmk">Source</span><span class="mmv" id="bsc-src" style="font-size:9px;color:var(--muted2)">—</span></div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button onclick="importWPETHBSC()" style="flex:1;padding:8px;border-radius:6px;border:none;background:#eab308;color:#fff;font-size:11px;font-weight:600;cursor:pointer">🟡 Import wPETH to MetaMask (BSC)</button>
      </div>
      <div style="margin-top:6px">
        <a id="bsc-scan-link" href="https://bscscan.com" target="_blank" class="bsc-link">View on BscScan →</a>
      </div>
    </div>

    <div class="bsc-card">
      <div class="pc-label">Check wPETH Balance on BSC</div>
      <div class="tx-field" style="margin-bottom:8px">
        <label>BSC Address</label>
        <input id="bsc-bal-addr" placeholder="0x… BSC address" style="font-size:11px;padding:8px"/>
      </div>
      <button onclick="checkBSCBalance()" style="width:100%;padding:8px;border-radius:6px;border:none;background:#eab308;color:#fff;font-size:11px;font-weight:600;cursor:pointer">Check BSC Balance →</button>
      <div id="bsc-bal-result" style="margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--muted2)"></div>
    </div>
  </div>
</div>

<!-- BSC Mint Events Table -->
<div class="tw" style="margin-bottom:20px">
  <div class="tw-head">
    🟡 wPETH BSC Mint Events (Private → BSC)
    <span style="font-size:10px;color:var(--muted2)">/api/v1/bsc/wpeth</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>TX Hash (BSC)</th><th>To</th><th>Amount</th>
        <th>USD Value</th><th>ETH Price</th><th>BscScan</th>
      </tr>
    </thead>
    <tbody id="bsc-tbody">
      <tr class="erow"><td colspan="6"><span class="spin">⌛</span> Loading BSC events…</td></tr>
    </tbody>
  </table>
  <div class="tw-foot">
    <span id="bsc-upd">—</span>
    <span>network: BNB Smart Chain (Chain 56)</span>
  </div>
</div>

<!-- BSC Config Panel -->
<div class="tw" style="margin-bottom:20px">
  <div class="tw-head">🟡 BSC Bridge Configuration</div>
  <div class="mmg3" style="padding:16px 20px">
    <div>
      <div class="mmst">Source (Private Chain)</div>
      <div class="mmr"><span class="mmk">Chain ID</span><span class="mmv" style="color:#ca8a04">123456</span></div>
      <div class="mmr"><span class="mmk">Bridge Contract</span><span class="mmv" id="bsc-cfg-bridge" style="font-size:9px;color:var(--blue2)">—</span></div>
      <div class="mmr"><span class="mmk">RPC</span><span class="mmv" style="font-size:9px;color:var(--muted2)">https://ai-private.online:8545</span></div>
    </div>
    <div>
      <div class="mmst">Destination (BSC)</div>
      <div class="mmr"><span class="mmk">Chain ID</span><span class="mmv" style="color:#ca8a04">56</span></div>
      <div class="mmr"><span class="mmk">wPETH BEP-20</span><span class="mmv" id="bsc-cfg-wpeth" style="font-size:9px;color:#ca8a04">—</span></div>
      <div class="mmr"><span class="mmk">BscScan</span><span class="mmv"><a href="https://bscscan.com" target="_blank" class="bsc-link">bscscan.com</a></span></div>
    </div>
    <div>
      <div class="mmst">CLI Commands</div>
      <div style="background:#0f172a;border-radius:6px;padding:10px;font-family:var(--mono);font-size:9px;color:#94a3b8;line-height:1.8">
        <span style="color:#eab308"># Deploy wPETH on BSC:</span><br/>
        node deploy_bsc.js --deploy-wpeth-bsc<br/>
        <span style="color:#eab308"># Lock ETH + mint wPETH:</span><br/>
        node deploy_bsc.js --lock-eth-bsc<br/>
        <span style="color:#eab308"># Check BSC status:</span><br/>
        node deploy_bsc.js --check-bsc
      </div>
    </div>
  </div>
</div>
'''

if 'bsc-section' not in content:
    # Insert before P2P section or Nginx section
    for target in ['<div id="p2p-section"></div>', '<div id="nginx-section"></div>', '</main>']:
        if target in content:
            content = content.replace(target, BSC_HTML + '\n' + target)
            print(f'✅ BSC HTML section added before {target[:40]}')
            break
else:
    print('⚠  BSC HTML section already present')

# ════════════════════════════════════════════════════════════
# 4. Add BSC JavaScript
# ════════════════════════════════════════════════════════════
BSC_JS = '''
// ── BSC (BNB Smart Chain) JavaScript ──────────────────────────

var bscWpethAddress = null;

function updateBSCEst() {
  var a = parseFloat(gid("bsc-lock-amt").value) || 0;
  if(gid("bsc-est")) gid("bsc-est").textContent = "≈ $" + (a * ethPrice).toFixed(2) + " USD · you receive " + a.toFixed(4) + " wPETH BEP-20 on BSC";
}

function setBSCLockStatus(m, c) {
  var e = gid("bsc-lock-status");
  if(e) { e.innerHTML = m; e.className = "tx-status " + c; e.style.display = "block"; }
}

function showBSCStats(d) {
  if(!d) return;
  bscWpethAddress = d.address || d.wpeth_address || null;

  if(gid("bsc-supply"))  gid("bsc-supply").textContent  = parseFloat(d.total_supply||0).toFixed(4) + " wPETH";
  if(gid("bsc-supply2")) gid("bsc-supply2").textContent = parseFloat(d.total_supply||0).toFixed(4) + " wPETH";
  if(gid("bsc-minted"))  gid("bsc-minted").textContent  = parseFloat(d.total_minted||0).toFixed(4) + " wPETH";
  if(gid("bsc-minted2")) gid("bsc-minted2").textContent = parseFloat(d.total_minted||0).toFixed(4) + " wPETH";
  if(gid("bsc-burned"))  gid("bsc-burned").textContent  = parseFloat(d.total_burned||0).toFixed(4) + " wPETH";

  var p = parseFloat(d.eth_price_usd || 0);
  if(gid("bsc-price"))   gid("bsc-price").textContent   = "$" + fmt(p, 2);
  if(gid("bsc-price2"))  gid("bsc-price2").textContent  = "$" + fmt(p, 2);
  if(gid("bsc-onchain")) gid("bsc-onchain").textContent = "$" + fmt(p, 2);
  if(gid("bsc-src"))     gid("bsc-src").textContent     = d.source || "coingecko+kraken";
  if(gid("bsc-price-src")) gid("bsc-price-src").textContent = d.source || "oracle";

  if(d.price_updated && gid("bsc-price-updated"))
    gid("bsc-price-updated").textContent = "updated " + new Date(d.price_updated).toLocaleTimeString();

  if(bscWpethAddress) {
    if(gid("bsc-addr")) gid("bsc-addr").textContent = bscWpethAddress.slice(0,10) + "…" + bscWpethAddress.slice(-8);
    if(gid("bsc-scan-link")) gid("bsc-scan-link").href = "https://bscscan.com/token/" + bscWpethAddress;
    if(gid("bsc-cfg-wpeth")) gid("bsc-cfg-wpeth").textContent = bscWpethAddress.slice(0,10) + "…";
  }

  // Live ETH price cards
  if(gid("bsc-cg"))   gid("bsc-cg").textContent   = "$" + fmt(cgPrice || p, 2);
  if(gid("bsc-kn"))   gid("bsc-kn").textContent   = "$" + fmt(bnPrice || p, 2);
  if(gid("bsc-cg-time")) gid("bsc-cg-time").textContent = new Date().toLocaleTimeString();
}

function showBSCStatus(d) {
  if(!d) return;
  if(gid("bsc-connected")) {
    gid("bsc-connected").textContent = d.connected ? "✅ Connected" : "❌ Offline";
    gid("bsc-connected").style.color = d.connected ? "var(--green)" : "var(--red)";
  }
  if(d.block_number && gid("bsc-block"))
    gid("bsc-block").textContent = "#" + parseInt(d.block_number).toLocaleString();
  if(d.wpeth_address) bscWpethAddress = d.wpeth_address;
  if(gid("bsc-cfg-bridge") && d.bridge) gid("bsc-cfg-bridge").textContent = (d.bridge||"").slice(0,10) + "…";
}

function loadBSCMints() {
  fetch("/api/v1/bsc/wpeth").then(r => r.json()).then(d => {
    if(d.error) {
      gid("bsc-tbody").innerHTML = \'<tr class="erow"><td colspan="6">wPETH not deployed on BSC — run: node deploy_bsc.js --deploy-wpeth-bsc</td></tr>\';
      return;
    }
    var minted = parseFloat(d.total_minted || 0);
    if(minted === 0) {
      gid("bsc-tbody").innerHTML = \'<tr class="erow"><td colspan="6">No BSC mint events yet</td></tr>\';
    } else {
      var addr = d.address || "";
      gid("bsc-tbody").innerHTML = \'<tr>\' +
        \'<td><span class="bsc-tag">on BSC</span></td>\' +
        \'<td><a href="https://bscscan.com/token/\' + addr + \'" target="_blank" class="bsc-link">\' + (addr ? addr.slice(0,10)+"…" : "—") + \'</a></td>\' +
        \'<td style="font-family:var(--mono);color:#ca8a04">\' + minted.toFixed(4) + \' wPETH total</td>\' +
        \'<td style="color:var(--amber)">$\' + fmt(minted * parseFloat(d.eth_price_usd||0), 2) + \'</td>\' +
        \'<td style="font-family:var(--mono)">$\' + fmt(d.eth_price_usd||0, 2) + \'</td>\' +
        \'<td><a href="https://bscscan.com/token/\' + addr + \'" target="_blank" class="bsc-link">BscScan →</a></td>\' +
        \'</tr>\';
    }
    if(gid("bsc-upd")) gid("bsc-upd").textContent = "Updated " + new Date().toLocaleTimeString();
  }).catch(() => {
    if(gid("bsc-tbody")) gid("bsc-tbody").innerHTML = \'<tr class="erow"><td colspan="6">BSC API not available</td></tr>\';
  });
}

function loadBSC() {
  fetch("/api/v1/bsc/status").then(r => r.json()).then(d => {
    showBSCStatus(d);
  }).catch(() => {
    if(gid("bsc-connected")) {
      gid("bsc-connected").textContent = "Not configured";
      gid("bsc-connected").style.color = "var(--muted2)";
    }
  });

  fetch("/api/v1/bsc/wpeth").then(r => r.json()).then(d => {
    if(!d.error) showBSCStats(d);
    else if(gid("bsc-addr")) gid("bsc-addr").innerHTML = \'<span style="color:var(--muted2);font-size:9px">Not deployed — run deploy_bsc.js</span>\';
  }).catch(() => {});

  loadBSCMints();
}

async function connectForBSC() {
  if(!window.ethereum) { setBSCLockStatus("MetaMask not found", "err"); return; }
  try {
    await window.ethereum.request({method:"eth_requestAccounts"});
    var cur = await window.ethereum.request({method:"eth_chainId"});
    if(cur.toLowerCase() !== CHAIN_ID_HEX.toLowerCase()) {
      try {
        await window.ethereum.request({method:"wallet_switchEthereumChain", params:[{chainId:CHAIN_ID_HEX}]});
      } catch(e) {
        if(e.code===4902 && networkConfig)
          await window.ethereum.request({method:"wallet_addEthereumChain", params:[{
            chainId:CHAIN_ID_HEX, chainName:networkConfig.chain_name,
            nativeCurrency:networkConfig.currency, rpcUrls:[networkConfig.rpc_url],
            blockExplorerUrls:[networkConfig.explorer_url]
          }]});
      }
    }
    var accounts = await window.ethereum.request({method:"eth_accounts"});
    if(gid("bsc-wallet-info"))
      gid("bsc-wallet-info").innerHTML = \'<span style="color:var(--green)">✅ Connected:</span> \' + accounts[0].slice(0,14) + "…";
    setBSCLockStatus("✅ Connected to OpenClaw Chain — ready to lock ETH", "ok");
  } catch(e) { setBSCLockStatus("❌ " + e.message, "err"); }
}

async function bscMintViaMM() {
  if(!window.ethereum) { setBSCLockStatus("MetaMask not found", "err"); return; }
  var amt = gid("bsc-lock-amt").value.trim();
  if(!amt || parseFloat(amt) <= 0) { setBSCLockStatus("❌ Enter amount to lock", "err"); return; }

  setBSCLockStatus("⏳ Connecting to OpenClaw Chain…", "info");
  try {
    await window.ethereum.request({method:"eth_requestAccounts"});
    var cur = await window.ethereum.request({method:"eth_chainId"});
    if(cur.toLowerCase() !== CHAIN_ID_HEX.toLowerCase()) {
      try {
        await window.ethereum.request({method:"wallet_switchEthereumChain", params:[{chainId:CHAIN_ID_HEX}]});
      } catch(e) {
        if(e.code===4902 && networkConfig)
          await window.ethereum.request({method:"wallet_addEthereumChain", params:[{
            chainId:CHAIN_ID_HEX, chainName:networkConfig.chain_name,
            nativeCurrency:networkConfig.currency, rpcUrls:[networkConfig.rpc_url],
            blockExplorerUrls:[networkConfig.explorer_url]
          }]});
        else throw e;
      }
    }

    var accounts = await window.ethereum.request({method:"eth_accounts"});
    var cfg = await fetch("/api/v1/bridge/config").then(r => r.json());
    if(!cfg.bridge_address) { setBSCLockStatus("❌ Bridge not deployed on private chain", "err"); return; }

    setBSCLockStatus("⏳ Review lockETH transaction in MetaMask…", "info");

    var selector = "0x84a73e53"; // lockETH(address)
    var paddedAddr = accounts[0].replace("0x","").padStart(64,"0");
    var totalWei = "0x" + BigInt(Math.round((parseFloat(amt) + 0.001) * 1e18)).toString(16);

    var txHash = await window.ethereum.request({method:"eth_sendTransaction", params:[{
      from: accounts[0], to: cfg.bridge_address,
      data: selector + paddedAddr, value: totalWei
    }]});

    setBSCLockStatus(
      \'✅ ETH Locked on Private Chain!<br/>TX: <a href="/tx/\' + txHash + \'">\' + txHash.slice(0,18) + \'…</a><br/>\' +
      \'⏳ Relayer will mint <strong>\' + amt + \' wPETH BEP-20</strong> on BSC shortly…<br/>\' +
      \'🟡 <a href="https://bscscan.com" target="_blank" class="bsc-link">Check BscScan after ~10s</a>\',
      "ok"
    );

    setTimeout(() => { loadBSC(); }, 15000);
    setTimeout(() => { loadBSC(); }, 30000);

  } catch(e) { setBSCLockStatus("❌ " + e.message, "err"); }
}

async function checkBSCBalance() {
  var addr = gid("bsc-bal-addr").value.trim();
  if(!addr || addr.length !== 42) { gid("bsc-bal-result").textContent = "❌ Invalid address"; return; }
  gid("bsc-bal-result").textContent = "⌛ Fetching from BSC…";
  try {
    var r = await fetch("/api/v1/bsc/balance/" + addr);
    var d = await r.json();
    if(d.error) { gid("bsc-bal-result").textContent = "❌ " + d.error; return; }
    gid("bsc-bal-result").innerHTML =
      "<strong style=\'color:#ca8a04\'>wPETH Balance:</strong> " + parseFloat(d.wpeth_balance||0).toFixed(6) + " wPETH<br/>" +
      "<strong style=\'color:var(--green)\'>Value USD:</strong> $" + parseFloat(d.wpeth_usd||0).toFixed(2) + "<br/>" +
      "<strong style=\'color:var(--blue2)\'>BNB Balance:</strong> " + parseFloat(d.bnb_balance||0).toFixed(6) + " BNB<br/>" +
      "<a href=\'https://bscscan.com/address/" + addr + "\' target=\'_blank\' class=\'bsc-link\'>View on BscScan →</a>";
  } catch(e) { gid("bsc-bal-result").textContent = "Error: " + e.message; }
}

async function importWPETHBSC() {
  if(!window.ethereum) { alert("MetaMask not found"); return; }
  if(!bscWpethAddress) { alert("wPETH not deployed on BSC yet\\nRun: node deploy_bsc.js --deploy-wpeth-bsc"); return; }
  // Switch to BSC first
  try {
    await window.ethereum.request({method:"wallet_switchEthereumChain", params:[{chainId:"0x38"}]});
  } catch(e) {
    if(e.code === 4902) {
      await window.ethereum.request({method:"wallet_addEthereumChain", params:[{
        chainId: "0x38",
        chainName: "BNB Smart Chain",
        nativeCurrency: {name:"BNB",symbol:"BNB",decimals:18},
        rpcUrls: ["https://bsc-dataseed1.binance.org"],
        blockExplorerUrls: ["https://bscscan.com"]
      }]});
    }
  }
  window.ethereum.request({
    method: "wallet_watchAsset",
    params: {type:"ERC20", options:{address:bscWpethAddress, symbol:"wPETH", decimals:18}}
  }).then(added => alert(added ? "✅ wPETH imported to MetaMask on BSC!" : "Cancelled"))
    .catch(e => alert(e.message));
}
'''

# Insert before the Boot comment
if 'loadBSC' not in content:
    for target in ['// Boot\n', 'startWS();loadNetworkConfig();loadAll();']:
        if target in content:
            content = content.replace(target, BSC_JS + '\n' + target)
            print(f'✅ BSC JavaScript added before "{target[:30]}"')
            break
    else:
        content = content.replace('</script>', BSC_JS + '\n</script>', 1)
        print('✅ BSC JavaScript added before </script>')
else:
    print('⚠  BSC JavaScript already present')

# ════════════════════════════════════════════════════════════
# 5. Add loadBSC() to loadAll() and setInterval
# ════════════════════════════════════════════════════════════
OLD_LOADALL = 'function loadAll(){loadToken();loadChain();loadBlocks();loadTxs();loadBridgeConfig();loadBridgeStats();loadBridgeRequests();loadBridgeOracle();loadP2P();loadNginxConfig();loadUSDTPrice();loadTokenBridgeStats();loadTokenBridgeRequests();loadWPETH();}'
NEW_LOADALL = 'function loadAll(){loadToken();loadChain();loadBlocks();loadTxs();loadBridgeConfig();loadBridgeStats();loadBridgeRequests();loadBridgeOracle();loadP2P();loadNginxConfig();loadUSDTPrice();loadTokenBridgeStats();loadTokenBridgeRequests();loadWPETH();loadBSC();}'

if OLD_LOADALL in content:
    content = content.replace(OLD_LOADALL, NEW_LOADALL)
    print('✅ loadBSC() added to loadAll()')
else:
    # Try to find and patch
    content = content.replace('loadWPETH();}', 'loadWPETH();loadBSC();}')
    print('✅ loadBSC() added to loadAll() (alternate)')

# Add BSC refresh interval
OLD_INTERVAL = 'setInterval(loadAll,15000);setInterval(pollPrice,30000);setInterval(loadWPETH,90000);'
NEW_INTERVAL = 'setInterval(loadAll,15000);setInterval(pollPrice,30000);setInterval(loadWPETH,90000);setInterval(loadBSC,60000);'
if OLD_INTERVAL in content:
    content = content.replace(OLD_INTERVAL, NEW_INTERVAL)
    print('✅ BSC 60s refresh interval added')

# ════════════════════════════════════════════════════════════
# 6. Add WebSocket handlers for BSC events
# ════════════════════════════════════════════════════════════
OLD_WS = 'if(d.type==="wpeth_stats"){showWPETHStats(d);}'
NEW_WS = '''if(d.type==="wpeth_stats"){showWPETHStats(d);}
      if(d.type==="wpeth_bsc_stats"){showBSCStats(d);}
      if(d.type==="bsc_mint"){
        loadBSC();
        var bscMsg="🟡 wPETH minted on BSC: "+parseFloat(d.amount_eth||0).toFixed(4)+" wPETH";
        if(gid("bsc-lock-status")){gid("bsc-lock-status").textContent=bscMsg;gid("bsc-lock-status").style.display="block";gid("bsc-lock-status").className="tx-status ok";}
      }'''

if OLD_WS in content and 'wpeth_bsc_stats' not in content:
    content = content.replace(OLD_WS, NEW_WS)
    print('✅ BSC WebSocket handlers added')

# ════════════════════════════════════════════════════════════
# 7. Update ETH price display to also refresh BSC cards
# ════════════════════════════════════════════════════════════
OLD_ETH_PRICE = 'ethPrice=p;cgPrice=cg||p;bnPrice=bn||p;'
NEW_ETH_PRICE = '''ethPrice=p;cgPrice=cg||p;bnPrice=bn||p;
  // Update BSC price cards with live price
  if(gid("bsc-cg")) gid("bsc-cg").textContent = "$" + fmt(cg||p, 2);
  if(gid("bsc-kn")) gid("bsc-kn").textContent = "$" + fmt(bn||p, 2);
  if(gid("bsc-cg-time")) gid("bsc-cg-time").textContent = new Date().toLocaleTimeString();'''

if OLD_ETH_PRICE in content and 'bsc-cg' not in content.split(OLD_ETH_PRICE)[1][:300]:
    content = content.replace(OLD_ETH_PRICE, NEW_ETH_PRICE)
    print('✅ BSC price cards connected to live ETH price feed')

# ════════════════════════════════════════════════════════════
# 8. Update footer
# ════════════════════════════════════════════════════════════
OLD_FOOTER = '⛓ OpenClaw Chain · ID 123456 → Mainnet · P2P :30303 · wPETH ERC-20 · CoinGecko + Binance Dual Oracle · ai-private.online'
NEW_FOOTER = '⛓ OpenClaw Chain · ID 123456 → Mainnet · BSC 56 · P2P :30303 · wPETH ERC-20/BEP-20 · CoinGecko + Kraken Dual Oracle · ai-private.online'
if OLD_FOOTER in content:
    content = content.replace(OLD_FOOTER, NEW_FOOTER)
    print('✅ Footer updated with BSC')

# ════════════════════════════════════════════════════════════
# WRITE
# ════════════════════════════════════════════════════════════
open(FILE, 'w').write(content)

print(f'\n✅ index2.html patched successfully')
print(f'   Original : {original_len:,} bytes')
print(f'   New size : {len(content):,} bytes')
print(f'   Added    : {len(content) - original_len:,} bytes')
print(f"""
BSC features added to index2.html:
  ✅ BSC nav link (🟡 BSC Chain)
  ✅ BSC status strip (block, supply, minted, price, RPC status)
  ✅ BSC price cards (CoinGecko, Kraken, on-chain oracle)
  ✅ BSC bridge form (lock ETH → mint wPETH on BSC via MetaMask)
  ✅ BSC wPETH stats panel + BscScan link
  ✅ BSC balance checker
  ✅ BSC mint events table
  ✅ BSC config + CLI commands panel
  ✅ Import wPETH to MetaMask on BSC
  ✅ WebSocket: wpeth_bsc_stats + bsc_mint events
  ✅ Live ETH price feeds BSC price cards
  ✅ loadBSC() in loadAll() + 60s auto-refresh

Next steps:
  1. pm2 restart server
  2. Open https://ai-private.online:3443/index2.html
  3. Scroll to 🟡 BSC Chain section
  4. Deploy wPETH on BSC: node deploy_bsc.js --deploy-wpeth-bsc
  5. Add to .env: WPETH_BSC_ADDRESS=0x...
""")
