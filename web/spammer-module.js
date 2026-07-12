const axios = require('axios');
// =============================================================================
// MONERO SPAMMER MODULE (inspired by Rucknium's xmrspammer)
// =============================================================================
// Re-implements the core xmrspammer flow in Node.js for the Umbrel web container.
// Communicates with a dedicated spammer-wallet-rpc via JSON-RPC.
//
// Workflow:
//   1. Create/open a spammer wallet
//   2. Fund it from the main wallet (or faucet)
//   3. Build output tree: create accounts, transfer to them (creates outputs)
//   4. Start spam loop: self-spend tx from each leaf account
//
// RPC: http://spammer-wallet-rpc:28084
// =============================================================================

const SPAMMER_WALLET_RPC = process.env.SPAMMER_WALLET_RPC || 'http://monero-fcmp-stressnet-spammer-wallet-rpc-1:28084';
const MAIN_WALLET_RPC = process.env.WALLET_RPC || 'http://10.88.88.4:28083';
// Fall back to the same daemon RPC the rest of the app uses. The old default
// (10.88.88.3:28089) was a stale address from a previous compose layout, which
// silently broke every recovery endpoint (flush_txpool, pending_txs, ...).
const MONEROD_RESTRICTED_RPC = process.env.MONEROD_RESTRICTED_RPC || process.env.MONEROD_RPC || 'http://10.99.10.11:28081';

const SPAMMER_WALLET_DIR = process.env.SPAMMER_WALLET_DIR || '/spammer-wallets';
const SPAMMER_WALLET_DEFAULT = 'spammer_main';

let spammerWalletState = {
    wallet_open: false,
    wallet_opening: false,
    wallet_file_exists: false,
    filename: null,
    address: null,
    balance: 0,
    unlocked_balance: 0,
    total_balance: 0,          // across all accounts (leaves hold the funds after a tree build)
    total_unlocked: 0,
    wallet_height: 0,
    daemon_height: 0,
    blocks_behind: null,       // null = unknown, 0 = synced
    num_accounts: 0,
    num_outputs: 0,
    tree_built: false,
    tree_building: false,
    tree_progress: null,       // { phase, done, total } while building
    tree_levels: 0,
    tree_leaves: 0,
    spamming: false,
    spam_count: 0,
    spam_success: 0,
    spam_fail: 0,
    last_error: null,
    intervalHandle: null,
    startedAt: null,
    log: []
};

function pushSpammerLog(level, msg) {
    spammerWalletState.log.unshift({ time: new Date().toISOString(), level, message: msg });
    if (spammerWalletState.log.length > 200) spammerWalletState.log.pop();
}

const fs = require('fs');

async function callSpammerWalletRpc(method, params = {}, timeout = 90000) {
    const response = await axios.post(`${SPAMMER_WALLET_RPC}/json_rpc`, {
        jsonrpc: '2.0',
        id: 'spammer-' + Date.now(),
        method,
        params: params || {}
    }, { timeout: timeout });
    if (response.data && response.data.error) {
        const err = new Error(response.data.error.message || 'wallet-rpc error');
        err.code = response.data.error.code;
        throw err;
    }
    return response.data;
}

// Helper for funding — calls the MAIN wallet RPC, not spammer RPC
async function callMainWalletRpc(method, params = {}, timeout = 120000) {
    const response = await axios.post(`${MAIN_WALLET_RPC}/json_rpc`, {
        jsonrpc: '2.0',
        id: 'main-wallet-' + Date.now(),
        method,
        params: params || {}
    }, { timeout: timeout });
    if (response.data && response.data.error) {
        const err = new Error(response.data.error.message || 'main wallet-rpc error');
        err.code = response.data.error.code;
        throw err;
    }
    return response.data;
}

async function callNodeRestricted(method, params = {}, timeout = 10000) {
    const response = await axios.post(`${MONEROD_RESTRICTED_RPC}/json_rpc`, {
        jsonrpc: '2.0',
        id: 'spammer-node-' + Date.now(),
        method,
        params: params || {}
    }, { timeout: timeout });
    if (response.data && response.data.error) {
        const err = new Error(response.data.error.message || 'monerod error');
        err.code = response.data.error.code;
        throw err;
    }
    return response.data;
}

// ── Wallet lifecycle ─────────────────────────────────────────────────────────

async function createSpammerWallet(filename, password = '') {
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(filename) ? filename : SPAMMER_WALLET_DEFAULT;
    spammerWalletState.wallet_opening = true;
    try {
        // Check if wallet already exists on disk to avoid "file_exists" error
        const walletPath = `${SPAMMER_WALLET_DIR}/${safe}`;
        try {
            if (fs.existsSync(walletPath + '.keys')) {
                spammerWalletState.wallet_file_exists = true;
                throw new Error(`Wallet file already exists: ${safe}.keys`);
            }
        } catch (_) {}
        await callSpammerWalletRpc('create_wallet', {
            filename: safe,
            password,
            language: 'English'
        }, 120000);
        spammerWalletState.filename = safe;
        spammerWalletState.wallet_open = true;
        spammerWalletState.wallet_file_exists = true;
        pushSpammerLog('info', `Created spammer wallet: ${safe}`);
        // Get address
        const addr = await callSpammerWalletRpc('get_address', { account_index: 0 });
        spammerWalletState.address = addr.result?.address || null;
        return { filename: safe, address: spammerWalletState.address };
    } finally {
        spammerWalletState.wallet_opening = false;
    }
}

async function openSpammerWallet(filename, password = '') {
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(filename) ? filename : SPAMMER_WALLET_DEFAULT;
    spammerWalletState.wallet_opening = true;
    try {
        await callSpammerWalletRpc('open_wallet', {
            filename: safe,
            password
        }, 120000);
        spammerWalletState.filename = safe;
        spammerWalletState.wallet_open = true;
        spammerWalletState.wallet_file_exists = true;
        pushSpammerLog('info', `Opened spammer wallet: ${safe}`);
        const addr = await callSpammerWalletRpc('get_address', { account_index: 0 });
        spammerWalletState.address = addr.result?.address || null;
        return { filename: safe, address: spammerWalletState.address };
    } finally {
        spammerWalletState.wallet_opening = false;
    }
}

async function closeSpammerWallet() {
    await callSpammerWalletRpc('close_wallet', {}, 10000);
    spammerWalletState.wallet_open = false;
    spammerWalletState.wallet_file_exists = true;  // file still exists on disk
    pushSpammerLog('info', 'Closed spammer wallet');
}

// Detect whether a spammer wallet file exists on disk (without querying RPC)
function checkSpammerWalletFileExists(filename = SPAMMER_WALLET_DEFAULT) {
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(filename) ? filename : SPAMMER_WALLET_DEFAULT;
    const walletPath = `${SPAMMER_WALLET_DIR}/${safe}`;
    try {
        return fs.existsSync(walletPath + '.keys');
    } catch (_) {
        return false;
    }
}

async function getSpammerSeed() {
    const resp = await callSpammerWalletRpc('query_key', { key_type: 'mnemonic' }, 60000);
    return resp.result?.key || null;
}

async function getSpammerRestoreHeight() {
    try {
        const resp = await callSpammerWalletRpc('getheight', {}, 15000);
        return resp.result?.height || 0;
    } catch (e) {
        return 0;
    }
}

async function refreshSpammerWalletState() {
    if (!spammerWalletState.wallet_open) return;
    try {
        // get_accounts carries per-account and wallet-wide totals in one call.
        // (The old code derived num_accounts from total_balance, so a wallet
        // with zero balance reported zero accounts.)
        const accts = await callSpammerWalletRpc('get_accounts', {}, 15000);
        const accounts = accts.result?.subaddress_accounts || [];
        spammerWalletState.num_accounts = accounts.length;
        spammerWalletState.balance = accounts[0]?.balance || 0;
        spammerWalletState.unlocked_balance = accounts[0]?.unlocked_balance || 0;
        spammerWalletState.total_balance = accts.result?.total_balance || 0;
        spammerWalletState.total_unlocked = accts.result?.total_unlocked_balance || 0;
    } catch (e) {
        pushSpammerLog('warning', `balance check failed: ${e.message}`);
    }
    try {
        // Wallet vs daemon height: spam txs fail while the wallet is still
        // scanning, so the UI needs to know when the wallet is actually ready.
        const wh = await callSpammerWalletRpc('get_height', {}, 15000);
        spammerWalletState.wallet_height = wh.result?.height || 0;
        const dh = await callNodeRestricted('get_info', {}, 10000);
        spammerWalletState.daemon_height = dh.result?.height || 0;
        spammerWalletState.blocks_behind = spammerWalletState.daemon_height > 0
            ? Math.max(0, spammerWalletState.daemon_height - spammerWalletState.wallet_height)
            : null;
    } catch (e) {
        spammerWalletState.blocks_behind = null;
    }
}

// ── Funding ────────────────────────────────────────────────────────────────────

async function fundSpammerWallet(amountAtomic) {
    if (!spammerWalletState.address) {
        throw new Error('Spammer wallet not open — create or open one first');
    }
    // Use MAIN wallet-rpc (not spammer) to send the transfer
    const result = await callMainWalletRpc('transfer', {
        destinations: [{
            address: spammerWalletState.address,
            amount: amountAtomic
        }],
        priority: 0,
        get_tx_key: true
    }, 60000);
    if (result.error) throw new Error(result.error.message);
    pushSpammerLog('info', `Funded spammer wallet with ${(amountAtomic / 1e12).toFixed(6)} tXMR — tx ${result.result?.tx_hash?.substring(0, 16)}...`);
    return result.result;
}

// ── Output tree building (prep.leaves equivalent) ─────────────────────────────
// Creates accounts and sends transfers to build spendable outputs.
// Each account gets funded, creating a new output. After confirmations,
// those outputs can be used for spam.

// Amount each leaf account gets. Big enough to sweep for a long time (each
// sweep only pays a fee), small enough that a default 1 tXMR funding covers a
// full tree.
const LEAF_FUND_ATOMIC = 20000000000; // 0.02 tXMR
const MAX_DESTS_PER_TX = 15;          // protocol allows 16 outputs; keep 1 for change
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function buildOutputTree(nOutputs = 15, nLevels = 3, feePriority = 1) {
    if (!spammerWalletState.wallet_open) {
        throw new Error('Open or create a spammer wallet first');
    }
    if (spammerWalletState.tree_building) {
        throw new Error('A tree build is already running');
    }
    if (nOutputs > 16) throw new Error('nOutputs must be <= 16 (protocol limit)');
    if (nLevels > 5) throw new Error('nLevels capped at 5 for safety');

    spammerWalletState.tree_building = true;
    try {
        const totalAccounts = Math.min(nOutputs * nLevels, 240);
        pushSpammerLog('info', `Building output tree: ${totalAccounts} leaf accounts`);

        // Phase 1: create missing accounts
        let accts = await callSpammerWalletRpc('get_accounts', {}, 15000);
        let accounts = accts.result?.subaddress_accounts || [];
        spammerWalletState.tree_progress = { phase: 'creating accounts', done: accounts.length, total: totalAccounts };
        for (let i = accounts.length; i < totalAccounts; i++) {
            await callSpammerWalletRpc('create_account', { label: `spam-${i}` }, 10000);
            spammerWalletState.tree_progress = { phase: 'creating accounts', done: i + 1, total: totalAccounts };
        }
        accts = await callSpammerWalletRpc('get_accounts', {}, 15000);
        accounts = accts.result?.subaddress_accounts || [];

        // Phase 2: fund leaves in batches of MAX_DESTS_PER_TX destinations per
        // tx (one tx funds 15 leaves at once). Funding one-by-one spends the
        // root's change output before it unlocks, so most sequential transfers
        // failed with "not enough unlocked money".
        const toFund = accounts.slice(1).filter(a => (a.balance || 0) < LEAF_FUND_ATOMIC);
        const totalNeeded = toFund.length * LEAF_FUND_ATOMIC;
        const rootUnlocked = accounts[0]?.unlocked_balance || 0;
        if (rootUnlocked < totalNeeded + 100000000000) { // + 0.1 tXMR fee buffer
            throw new Error(
                `Need ~${((totalNeeded + 100000000000) / 1e12).toFixed(3)} tXMR unlocked to fund ${toFund.length} leaves, ` +
                `root has ${(rootUnlocked / 1e12).toFixed(3)} unlocked. Fund the wallet (or wait ~20 min for confirmations).`
            );
        }

        let funded = accounts.length - 1 - toFund.length; // already-funded leaves
        spammerWalletState.tree_progress = { phase: 'funding leaves', done: funded, total: accounts.length - 1 };
        for (let start = 0; start < toFund.length; start += MAX_DESTS_PER_TX) {
            const batch = toFund.slice(start, start + MAX_DESTS_PER_TX);
            const destinations = batch.map(a => ({ address: a.base_address, amount: LEAF_FUND_ATOMIC }));
            // Change from the previous batch tx is locked for 10 blocks; retry
            // until it unlocks instead of failing the whole build.
            for (let attempt = 1; ; attempt++) {
                try {
                    await callSpammerWalletRpc('transfer', {
                        account_index: 0,
                        destinations,
                        priority: feePriority,
                        get_tx_key: true
                    }, 120000);
                    break;
                } catch (e) {
                    const retryable = /unlocked|not enough money|busy/i.test(e.message);
                    if (!retryable || attempt >= 12) throw e;
                    spammerWalletState.tree_progress = {
                        phase: `waiting for change to unlock (retry ${attempt}/12)`,
                        done: funded, total: accounts.length - 1
                    };
                    pushSpammerLog('info', `Batch ${1 + start / MAX_DESTS_PER_TX}: waiting ~2 min for change to unlock (attempt ${attempt}/12)`);
                    await sleep(130000);
                }
            }
            funded += batch.length;
            spammerWalletState.tree_progress = { phase: 'funding leaves', done: funded, total: accounts.length - 1 };
            pushSpammerLog('info', `Funded ${funded}/${accounts.length - 1} leaves`);
        }

        // Persist the wallet so a restart doesn't lose the new accounts/outputs
        try { await callSpammerWalletRpc('store', {}, 60000); } catch (_) {}

        spammerWalletState.tree_built = true;
        spammerWalletState.tree_levels = nLevels;
        spammerWalletState.tree_leaves = funded;
        spammerWalletState.num_outputs = funded;
        refreshLeafCache().catch(() => {});
        pushSpammerLog('info', `Output tree complete: ${funded} funded leaves. Leaf outputs unlock after 10 confirmations (~20 min).`);
        return { accounts: accounts.length, funded, totalAccounts };
    } finally {
        spammerWalletState.tree_building = false;
        spammerWalletState.tree_progress = null;
    }
}

// ── Spam loop ──────────────────────────────────────────────────────────────────
// Round-robin sweep_all over the leaf accounts, matching Rucknium's
// spam.1in.2out: each sweep spends whatever the leaf holds back to its own
// address (a self-churn), so there is no fixed amount that can mismatch the
// leaf balance. (The old loop self-sent a hardcoded 0.1 tXMR from leaves
// funded with 0.005, so every single spam tx failed with "not enough money".)

let spamInFlight = false;
let leafCache = [];        // [{ account_index, base_address, label }]
let leafCursor = 0;
let sinceStore = 0;
const STORE_EVERY_TXS = 50; // upstream saves every 2000 at full speed; we tick slower

async function refreshLeafCache() {
    const accts = await callSpammerWalletRpc('get_accounts', {}, 15000);
    const accounts = accts.result?.subaddress_accounts || [];
    leafCache = accounts.slice(1).map(a => ({
        account_index: a.account_index,
        base_address: a.base_address,
        label: a.label
    }));
    if (leafCursor >= leafCache.length) leafCursor = 0;
    return leafCache.length;
}

async function spamTick() {
    if (!spammerWalletState.spamming || spamInFlight) return;
    spamInFlight = true;
    try {
        if (leafCache.length === 0) {
            await refreshLeafCache();
            if (leafCache.length === 0) {
                pushSpammerLog('warning', 'No leaf accounts to spam from — build the output tree first');
                return;
            }
        }
        const leaf = leafCache[leafCursor];
        leafCursor = (leafCursor + 1) % leafCache.length;

        spammerWalletState.spam_count++;
        const txStart = Date.now();
        const result = await callSpammerWalletRpc('sweep_all', {
            address: leaf.base_address,
            account_index: leaf.account_index,
            priority: 1
        }, 90000);

        const hashes = result.result?.tx_hash_list || [];
        const amounts = result.result?.amount_list || [];
        const sweptAtomic = amounts.reduce((a, b) => a + b, 0);
        spammerWalletState.spam_success++;
        spammerWalletState.last_error = null;
        pushSpammerLog('info', `Sweep ${spammerWalletState.spam_count} OK: acct ${leaf.account_index} ` +
            `${(sweptAtomic / 1e12).toFixed(5)} tXMR in ${hashes.length} tx (${Date.now() - txStart}ms)`);

        // Periodically flush the wallet cache to disk so a restart doesn't
        // rescan from scratch (upstream does this in its spam loop too).
        if (++sinceStore >= STORE_EVERY_TXS) {
            sinceStore = 0;
            try { await callSpammerWalletRpc('store', {}, 60000); pushSpammerLog('info', 'Wallet state saved'); } catch (_) {}
        }
    } catch (e) {
        spammerWalletState.spam_fail++;
        spammerWalletState.last_error = e.message;
        // "No unlocked balance" just means this leaf's churn output hasn't
        // confirmed yet; it becomes sweepable again after ~10 blocks. Not fatal.
        if (/unlocked|not enough money/i.test(e.message)) {
            pushSpammerLog('info', `Acct waiting for confirmations, skipping (${e.message})`);
        } else {
            pushSpammerLog('warning', `Spam error: ${e.message}`);
        }
    } finally {
        spamInFlight = false;
    }
}

function startSpamLoop(intervalMs = 5000) {
    if (spammerWalletState.spamming) return { status: 'already_running' };
    if (!spammerWalletState.wallet_open) {
        throw new Error('No spammer wallet open');
    }
    spammerWalletState.spamming = true;
    spammerWalletState.startedAt = new Date().toISOString();
    spammerWalletState.spam_count = 0;
    spammerWalletState.spam_success = 0;
    spammerWalletState.spam_fail = 0;
    sinceStore = 0;
    pushSpammerLog('info', `Spam loop started — interval ${intervalMs}ms`);

    // Fresh leaf list, then fire immediately
    refreshLeafCache().catch(() => {}).then(() => spamTick());
    spammerWalletState.intervalHandle = setInterval(spamTick, intervalMs);
    return { status: 'started', intervalMs };
}

function stopSpamLoop() {
    if (spammerWalletState.intervalHandle) {
        clearInterval(spammerWalletState.intervalHandle);
        spammerWalletState.intervalHandle = null;
    }
    spammerWalletState.spamming = false;
    pushSpammerLog('info', `Spam loop stopped — ${spammerWalletState.spam_success}/${spammerWalletState.spam_count} succeeded`);
    // Persist the wallet so everything the run created survives a restart
    callSpammerWalletRpc('store', {}, 60000).catch(() => {});
    return { status: 'stopped', ...spammerWalletState };
}

// ── Boot-time state recovery ───────────────────────────────────────────────────
// The web container's in-memory state resets on restart, but the wallet-rpc
// container usually still has the wallet open (or the wallet file exists on
// disk). Without this probe, every restart greeted the user with "No spammer
// wallet found — create one", and Create then failed with "file already
// exists". Probe the RPC, resume the open wallet, or auto-open the default.
async function initSpammerState() {
    try {
        const addr = await callSpammerWalletRpc('get_address', { account_index: 0 }, 10000);
        if (addr.result?.address) {
            spammerWalletState.wallet_open = true;
            spammerWalletState.wallet_file_exists = true;
            spammerWalletState.filename = spammerWalletState.filename || SPAMMER_WALLET_DEFAULT;
            spammerWalletState.address = addr.result.address;
            pushSpammerLog('info', 'Resumed already-open spammer wallet');
            const accounts = await refreshLeafCache().catch(() => 0);
            if (accounts > 0) {
                spammerWalletState.tree_built = true;
                spammerWalletState.tree_leaves = accounts;
                spammerWalletState.num_outputs = accounts;
            }
            return;
        }
    } catch (_) { /* nothing open, try disk */ }
    if (checkSpammerWalletFileExists()) {
        spammerWalletState.wallet_file_exists = true;
        try {
            await openSpammerWallet(SPAMMER_WALLET_DEFAULT, '');
            pushSpammerLog('info', 'Auto-opened spammer wallet from disk');
            const accounts = await refreshLeafCache().catch(() => 0);
            if (accounts > 0) {
                spammerWalletState.tree_built = true;
                spammerWalletState.tree_leaves = accounts;
                spammerWalletState.num_outputs = accounts;
            }
        } catch (e) {
            pushSpammerLog('warning', `Wallet file found but auto-open failed: ${e.message}`);
        }
    }
}

// ── Export for server.js integration ───────────────────────────────────────────

module.exports = {
    spammerWalletState,
    pushSpammerLog,
    callSpammerWalletRpc,
    callNodeRestricted,
    checkSpammerWalletFileExists,
    createSpammerWallet,
    openSpammerWallet,
    closeSpammerWallet,
    getSpammerSeed,
    getSpammerRestoreHeight,
    refreshSpammerWalletState,
    refreshLeafCache,
    initSpammerState,
    fundSpammerWallet,
    buildOutputTree,
    startSpamLoop,
    stopSpamLoop,
    spamTick
};
