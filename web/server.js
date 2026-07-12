const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const spammer = require('./spammer-module');
const Database = require('better-sqlite3');
const app = express();
const port = process.env.PORT || 8080;
const NODE_RPC = process.env.MONEROD_RPC || 'http://monero-fcmp-stressnet-monerod-1:28081';
const WALLET_RPC = process.env.WALLET_RPC || 'http://monero-fcmp-stressnet-wallet-rpc-1:28083';
const RELAY_RPC = process.env.RELAY_RPC || 'http://10.21.0.6:3001';
const MONITOR_DB_PATH = process.env.MONITOR_DB_PATH || './monitor.db';
const WALLETS_META_PATH = '/data/wallets.json';
const WALLET_FILES_DIR = process.env.WALLET_FILES_DIR || '/wallet-files';
const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS) || 8000;
const MIN_STRESS_INTERVAL_MS = Number(process.env.MIN_STRESS_INTERVAL_MS) || 5000;
const MAX_STRESS_AMOUNT_XMR = Number(process.env.MAX_STRESS_AMOUNT_XMR) || 100;
const WALLET_STATE_TTL_MS = Number(process.env.WALLET_STATE_TTL_MS) || 60000;
const MONEROD_CONTAINER_NAME = process.env.MONEROD_CONTAINER_NAME || 'brainchainz_monero_superstress_monerod';
const WALLET_REFRESH_MS = Number(process.env.WALLET_REFRESH_MS) || 60000;
const WALLET_RPC_FAST_TIMEOUT_MS = Number(process.env.WALLET_RPC_FAST_TIMEOUT_MS) || 90000;
const WALLET_RPC_SLOW_TIMEOUT_MS = Number(process.env.WALLET_RPC_SLOW_TIMEOUT_MS) || 300000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
app.use(cors());
app.use(bodyParser.json());
// ═══════════════════════════════════════════════════════════════════════════════
// EXPLORER RELAY PROXY — forwards /api/xmr/* to the relay container
// ═══════════════════════════════════════════════════════════════════════════════
app.use('/api/xmr', async (req, res) => {
    try {
        // Block parade lightweight tip poll: /api/xmr?_p=tip → just {height}
        if (req.query._p === 'tip') {
            const r = await axios.get(`${RELAY_RPC}/api/network`, { timeout: RELAY_TIMEOUT_MS });
            res.json({ height: r.data?.height || 0 });
            return;
        }
        // Block parade mempool poll: /api/xmr?_p=mempool
        if (req.query._p === 'mempool') {
            const r = await axios.get(`${RELAY_RPC}/api/mempool`, { timeout: RELAY_TIMEOUT_MS });
            res.json(r.data);
            return;
        }
        // Standard proxy: /api/xmr/blocks → relay:3001/api/blocks
        const target = `${RELAY_RPC}/api${req.path}`;
        const method = req.method.toLowerCase();
        const opts = { method, headers: { 'Content-Type': 'application/json' }, timeout: RELAY_TIMEOUT_MS };
        if (req.body && Object.keys(req.body).length > 0) opts.data = req.body;
        const response = await axios({ url: target, ...opts, validateStatus: () => true });
        // If tx detail lookup times out, fall back to a lightweight direct monerod
        // lookup so clicking block txs doesn't show a hard 502 just because the relay
        // is busy polling a huge mempool.
        if (response.status >= 500 && req.method === 'GET' && /^\/tx\/[0-9a-fA-F]{64}$/.test(req.path)) {
            const txid = req.path.split('/').pop();
            try {
                const direct = await callNodeEndpoint('get_transactions', { txs_hashes: [txid], decode_as_json: true }, 20000);
                const first = direct?.txs?.[0];
                if (first) {
                    let parsed = {};
                    try { parsed = JSON.parse(first.as_json || first.tx_entry_json || '{}'); } catch (_) {}
                    return res.json({
                        txid,
                        in_mempool: Boolean(first.in_pool),
                        confirmed: !first.in_pool,
                        block_height: first.block_height ?? null,
                        block_hash: null,
                        block_timestamp: first.block_timestamp ?? null,
                        confirmations: first.confirmations ?? null,
                        blob_size: first.as_hex ? Math.floor(first.as_hex.length / 2) : 0,
                        fee: 0,
                        fee_rate: 0,
                        fee_tier: 'unknown',
                        rct_type: Number(parsed?.rct_signatures?.type ?? 0),
                        unlock_time: Number(parsed?.unlock_time ?? 0),
                        output_count: Array.isArray(parsed?.vout) ? parsed.vout.length : 0,
                        input_count: Array.isArray(parsed?.vin) ? parsed.vin.length : 0,
                        relayed: first.relayed ?? true,
                        double_spend_seen: first.double_spend_seen ?? false
                    });
                }
            } catch (fallbackErr) {
                console.error('[relay-proxy] direct tx fallback failed:', fallbackErr.message);
            }
        }
        res.status(response.status).json(response.data);
    } catch (err) {
        console.error('[relay-proxy] Error:', err.message);
        if (req.method === 'GET' && /^\/tx\/[0-9a-fA-F]{64}$/.test(req.path)) {
            const txid = req.path.split('/').pop();
            try {
                const direct = await callNodeEndpoint('get_transactions', { txs_hashes: [txid], decode_as_json: true }, 20000);
                const first = direct?.txs?.[0];
                if (first) {
                    let parsed = {};
                    try { parsed = JSON.parse(first.as_json || first.tx_entry_json || '{}'); } catch (_) {}
                    return res.json({
                        txid,
                        in_mempool: Boolean(first.in_pool),
                        confirmed: !first.in_pool,
                        block_height: first.block_height ?? null,
                        block_hash: null,
                        block_timestamp: first.block_timestamp ?? null,
                        confirmations: first.confirmations ?? null,
                        blob_size: first.as_hex ? Math.floor(first.as_hex.length / 2) : 0,
                        fee: 0,
                        fee_rate: 0,
                        fee_tier: 'unknown',
                        rct_type: Number(parsed?.rct_signatures?.type ?? 0),
                        unlock_time: Number(parsed?.unlock_time ?? 0),
                        output_count: Array.isArray(parsed?.vout) ? parsed.vout.length : 0,
                        input_count: Array.isArray(parsed?.vin) ? parsed.vin.length : 0,
                        relayed: first.relayed ?? true,
                        double_spend_seen: first.double_spend_seen ?? false,
                        degraded: true,
                        degraded_reason: 'relay unavailable; served by direct monerod fallback'
                    });
                }
            } catch (fallbackErr) {
                console.error('[relay-proxy] direct tx fallback failed:', fallbackErr.message);
            }
        }
        res.status(502).json({ error: 'relay unavailable', detail: err.message });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE MONITOR DATABASE (matches Rucknium's monerod-monitor schema)
// ═══════════════════════════════════════════════════════════════════════════════
let db;
function initMonitorDb() {
    db = new Database(MONITOR_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_stats (
            time TEXT NOT NULL,
            bytes_total INTEGER,
            bytes_min INTEGER,
            bytes_max INTEGER,
            bytes_med INTEGER,
            bytes_mean REAL,
            fee_total INTEGER,
            histo_98pc INTEGER,
            num_double_spends INTEGER,
            num_failing INTEGER,
            num_not_relayed INTEGER,
            num_10m INTEGER,
            oldest INTEGER,
            txs_total INTEGER
        );
        CREATE TABLE IF NOT EXISTS info (
            time TEXT NOT NULL,
            adjusted_time INTEGER,
            alt_blocks_count INTEGER,
            block_size_limit INTEGER,
            block_size_median INTEGER,
            block_weight_limit INTEGER,
            block_weight_median INTEGER,
            cumulative_difficulty INTEGER,
            database_size INTEGER,
            difficulty INTEGER,
            free_space INTEGER,
            height INTEGER,
            height_without_bootstrap INTEGER,
            incoming_connections_count INTEGER,
            outgoing_connections_count INTEGER,
            rpc_connections_count INTEGER,
            target INTEGER,
            target_height INTEGER,
            tx_count INTEGER,
            tx_pool_size INTEGER,
            white_peerlist_size INTEGER,
            grey_peerlist_size INTEGER,
            synchronized INTEGER,
            version TEXT,
            was_bootstrap_ever_used INTEGER,
            rpc_response_ms REAL
        );
        CREATE TABLE IF NOT EXISTS last_block_header (
            time TEXT NOT NULL,
            block_size INTEGER,
            block_weight INTEGER,
            cumulative_difficulty INTEGER,
            depth INTEGER,
            difficulty INTEGER,
            hash TEXT,
            height INTEGER,
            major_version INTEGER,
            minor_version INTEGER,
            nonce INTEGER,
            num_txes INTEGER,
            orphan_status INTEGER,
            prev_hash TEXT,
            reward INTEGER,
            timestamp INTEGER,
            wide_cumulative_difficulty TEXT,
            wide_difficulty TEXT
        );
        CREATE TABLE IF NOT EXISTS fee_estimate (
            time TEXT NOT NULL,
            fee INTEGER,
            quantization_mask INTEGER
        );
        CREATE TABLE IF NOT EXISTS connections (
            time TEXT NOT NULL,
            address TEXT,
            avg_download INTEGER,
            avg_upload INTEGER,
            connection_id TEXT,
            current_download INTEGER,
            current_upload INTEGER,
            height INTEGER,
            host TEXT,
            incoming INTEGER,
            ip TEXT,
            live_time INTEGER,
            local_ip INTEGER,
            localhost INTEGER,
            peer_id TEXT,
            port TEXT,
            recv_count INTEGER,
            recv_idle_time INTEGER,
            send_count INTEGER,
            send_idle_time INTEGER,
            state TEXT,
            support_flags INTEGER
        );
        CREATE TABLE IF NOT EXISTS bans (
            time TEXT NOT NULL,
            host TEXT,
            ip INTEGER,
            seconds INTEGER
        );
        CREATE TABLE IF NOT EXISTS process_info (
            time TEXT NOT NULL,
            cpu_user REAL,
            cpu_system REAL,
            mem_rss INTEGER,
            mem_vms INTEGER
        );
        CREATE TABLE IF NOT EXISTS mined_blocks (
            height INTEGER PRIMARY KEY,
            hash TEXT NOT NULL,
            timestamp INTEGER,
            difficulty INTEGER,
            reward INTEGER,
            block_size INTEGER,
            num_txes INTEGER,
            orphan_status INTEGER,
            prev_hash TEXT,
            found_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pool_stats_time ON pool_stats(time);
        CREATE INDEX IF NOT EXISTS idx_info_time ON info(time);
        CREATE INDEX IF NOT EXISTS idx_last_block_time ON last_block_header(time);
        CREATE INDEX IF NOT EXISTS idx_fee_time ON fee_estimate(time);
        CREATE INDEX IF NOT EXISTS idx_conn_time ON connections(time);
        CREATE INDEX IF NOT EXISTS idx_bans_time ON bans(time);
        CREATE INDEX IF NOT EXISTS idx_process_time ON process_info(time);
        CREATE INDEX IF NOT EXISTS idx_mined_blocks_height ON mined_blocks(height);
    `);
    // Load previously mined blocks from DB into memory
    try {
        const rows = db.prepare('SELECT * FROM mined_blocks ORDER BY found_at DESC LIMIT 100').all();
        for (const row of rows) {
            minedBlocks.push({
                height: row.height,
                hash: row.hash,
                timestamp: row.timestamp,
                difficulty: row.difficulty,
                reward: row.reward,
                block_size: row.block_size,
                num_txes: row.num_txes,
                orphan_status: !!row.orphan_status,
                prev_hash: row.prev_hash || '',
                found_at: row.found_at
            });
        }
        console.log('[monitor] Loaded', minedBlocks.length, 'mined blocks from DB');
    } catch (e) {
        console.log('[monitor] No mined_blocks table yet or load error:', e.message);
    }
    console.log('[monitor] SQLite database initialized at', MONITOR_DB_PATH);
}
// ═══════════════════════════════════════════════════════════════════════════════
// RPC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function throwOnRpcError(payload, context) {
    if (payload?.error) {
        const msg = payload.error.message || JSON.stringify(payload.error);
        const err = new Error(`${context}: ${msg}`);
        err.rpcError = payload.error;
        throw err;
    }
    return payload;
}
async function callNodeRpc(method, params = {}, timeout = 10000) {
    const response = await axios.post(`${NODE_RPC}/json_rpc`, {
        jsonrpc: '2.0', id: '0', method, params
    }, { timeout });
    return throwOnRpcError(response.data, `node RPC ${method}`);
}
async function callNodeEndpoint(endpoint, data = {}, timeout = 10000) {
    const response = await axios.post(`${NODE_RPC}/${endpoint}`, data, { timeout });
    return throwOnRpcError(response.data, `node endpoint ${endpoint}`);
}
async function callWalletRpc(method, params = {}, timeout = 30000) {
    const response = await axios.post(`${WALLET_RPC}/json_rpc`, {
        jsonrpc: '2.0', id: '0', method, params
    }, { timeout });
    return throwOnRpcError(response.data, `wallet RPC ${method}`);
}
// ═══════════════════════════════════════════════════════════════════════════════
// SYNC FALLBACK — parse monerod log when RPC is blocked during sync
// ═══════════════════════════════════════════════════════════════════════════════
const MONEROD_LOG_PATH = process.env.MONEROD_LOG_PATH || '/data/db/testnet/bitmonero.log';
function parseSyncFromLog() {
    try {
        if (!fs.existsSync(MONEROD_LOG_PATH)) return null;
        const buf = fs.readFileSync(MONEROD_LOG_PATH, "utf8");
        const lines = buf.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            const m = lines[i].match(/Synced (\d+)\/(\d+)\s*\((\d+)%(?:,\s*(\d+) left)?/);
            if (m) {
                return {
                    height: parseInt(m[1]),
                    target_height: parseInt(m[2]),
                    percent: parseInt(m[3]),
                    blocks_left: m[4] ? parseInt(m[4]) : null
                };
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}
// WALLET METADATA — persistent registry of named wallets
// ═══════════════════════════════════════════════════════════════════════════════
function readWalletsMeta() {
    try {
        if (fs.existsSync(WALLETS_META_PATH)) {
            return JSON.parse(fs.readFileSync(WALLETS_META_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('[wallet-meta] Failed to read wallets.json:', e.message);
    }
    return {};
}
function writeWalletsMeta(meta) {
    try {
        const dir = require('path').dirname(WALLETS_META_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WALLETS_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
        console.error('[wallet-meta] Failed to write wallets.json:', e.message);
    }
}
// Launch-grade wallet service: single-flight cache + serialized state-changing jobs.
// The React UI reads this cached state instead of making several live wallet-rpc calls
// on every render. That keeps the UI usable while wallet-rpc is scanning or monerod is busy.
let activeWalletFilename = null;
let walletQueue = Promise.resolve();
let walletRefreshInFlight = null;
const walletJobs = new Map();
let walletJobSeq = 0;
let walletState = {
    wallet_open: false,
    active_wallet: null,
    address: null,
    balance: null,
    unlocked_balance: null,
    num_unspent_outputs: null,
    blocks_to_unlock: null,
    daemon_height: null,
    wallet_height: null,
    target_height: null,
    blocks_behind: null,
    synced: false,
    syncing: false,
    healthy: false,
    busy: false,
    last_error: null,
    message: 'Wallet state not loaded yet',
    updated_at: null,
    checked_at: null,
    history: { in: [], out: [], pending: [], pool: [] },
    history_updated_at: null,
    history_error: null,
    restore_height: null
};
function getActiveWalletFilename() { return activeWalletFilename; }
function setActiveWalletFilename(name) {
    activeWalletFilename = name || null;
    walletState.active_wallet = activeWalletFilename;
    const meta = readWalletsMeta();
    for (const key of Object.keys(meta)) meta[key].active = key === activeWalletFilename;
    if (activeWalletFilename && !meta[activeWalletFilename]) meta[activeWalletFilename] = { displayName: activeWalletFilename, active: true };
    writeWalletsMeta(meta);
}
function hydrateActiveWalletFromMeta() {
    const meta = readWalletsMeta();
    activeWalletFilename = Object.entries(meta).find(([, info]) => info?.active)?.[0]
        || Object.keys(meta)[0]
        || null;
    walletState.active_wallet = activeWalletFilename;
    return activeWalletFilename;
}
function publicWalletState(extra = {}) {
    return { ...walletState, active_wallet: getActiveWalletFilename(), busy: walletState.busy, ...extra };
}
function mergeWalletState(partial) {
    walletState = { ...walletState, ...partial, active_wallet: getActiveWalletFilename(), updated_at: new Date().toISOString() };
    return walletState;
}
function walletFilePaths(filename) {
    const safe = validateWalletFilename(filename);
    return [
        path.join(WALLET_FILES_DIR, safe),
        path.join(WALLET_FILES_DIR, `${safe}.keys`),
        path.join(WALLET_FILES_DIR, `${safe}.address.txt`)
    ];
}
async function deleteWalletFiles(filename) {
    const deleted = [];
    const missing = [];
    for (const filePath of walletFilePaths(filename)) {
        try {
            await fs.promises.unlink(filePath);
            deleted.push(path.basename(filePath));
        } catch (e) {
            if (e.code === 'ENOENT') missing.push(path.basename(filePath));
            else throw e;
        }
    }
    return { deleted, missing };
}
async function ensureWalletRingDb() {
    try {
        await fs.promises.mkdir(path.join(WALLET_FILES_DIR, '.shared-ringdb'), { recursive: true });
    } catch (_) {}
    try {
        await fs.promises.mkdir('/home/monero/wallet/.shared-ringdb', { recursive: true });
    } catch (_) {}
}
function createWalletJob(type, label, runner) {
    const id = `${Date.now()}-${++walletJobSeq}`;
    const job = {
        id,
        type,
        label,
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        result: null,
        error: null
    };
    walletJobs.set(id, job);
    walletQueue = walletQueue.catch(() => {}).then(async () => {
        job.status = 'running';
        job.started_at = new Date().toISOString();
        mergeWalletState({ busy: true, message: label });
        try {
            job.result = await runner(job);
            job.status = 'done';
            return job.result;
        } catch (e) {
            job.error = e.message;
            job.status = 'error';
            mergeWalletState({ healthy: false, last_error: e.message, message: e.message });
            throw e;
        } finally {
            job.finished_at = new Date().toISOString();
            mergeWalletState({ busy: false });
            for (const [oldId, oldJob] of walletJobs) {
                if (walletJobs.size <= 30) break;
                if (oldJob.status !== 'running') walletJobs.delete(oldId);
            }
        }
    });
    // Avoid unhandled rejection noise; callers use returned job id/status endpoint.
    walletQueue.catch(() => {});
    return job;
}
function walletJobResponse(job) {
    return { job: { ...job }, wallet: publicWalletState() };
}
async function runWalletJobNow(type, label, runner) {
    const job = createWalletJob(type, label, runner);
    await walletQueue;
    return walletJobResponse(job);
}
function validateWalletFilename(filename, fallback = 'stressnet_wallet') {
    const value = filename || fallback;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        const err = new Error('wallet filename must be 1-64 chars: letters, numbers, underscore, dash only');
        err.statusCode = 400;
        throw err;
    }
    return value;
}
function validateDisplayName(name, fallback) {
    const value = typeof name === 'string' && name.trim() ? name.trim() : fallback;
    if (value.length > 80) {
        const err = new Error('display name must be 80 characters or fewer');
        err.statusCode = 400;
        throw err;
    }
    return value;
}
function emptyHistory() { return { in: [], out: [], pending: [], pool: [] }; }
async function refreshWalletHistory({ timeout = WALLET_RPC_SLOW_TIMEOUT_MS } = {}) {
    const result = await callWalletRpc('get_transfers', {
        in: true, out: true, pending: true, pool: true,
        account_index: 0
    }, timeout);
    walletState.history = result.result || emptyHistory();
    walletState.history_updated_at = new Date().toISOString();
    walletState.history_error = null;
    return walletState.history;
}
async function refreshWalletState({ force = false, includeHistory = false } = {}) {
    if (walletRefreshInFlight) return walletRefreshInFlight;
    const age = walletState.updated_at ? Date.now() - new Date(walletState.updated_at).getTime() : Infinity;
    if (!force && age < WALLET_STATE_TTL_MS) return walletState;
    walletRefreshInFlight = (async () => {
        const next = { ...walletState, checked_at: new Date().toISOString(), active_wallet: getActiveWalletFilename() };
        try {
            const [nodeInfoRes, addrRes, balRes, heightRes] = await Promise.all([
                callNodeRpc('get_info', {}, WALLET_RPC_FAST_TIMEOUT_MS).catch(e => ({ error: e.message })),
                callWalletRpc('get_address', { account_index: 0 }, WALLET_RPC_FAST_TIMEOUT_MS).catch(e => ({ error: e.message })),
                callWalletRpc('get_balance', { account_index: 0 }, WALLET_RPC_FAST_TIMEOUT_MS).catch(e => ({ error: e.message })),
                callWalletRpc('get_height', {}, WALLET_RPC_FAST_TIMEOUT_MS).catch(e => ({ error: e.message }))
            ]);
            let nodeInfo = nodeInfoRes.result;
            if (!nodeInfo && nodeInfoRes.error) {
                // get_info timed out during sync -- fall back to log parsing
                const sync = parseSyncFromLog();
                if (sync) nodeInfo = sync;
            }
            if (nodeInfo) {
                next.daemon_height = nodeInfo.height || null;
                next.target_height = nodeInfo.target_height || nodeInfo.height || null;
            }
            if (addrRes.result?.address) {
                next.wallet_open = true;
                next.address = addrRes.result.address;
            } else if (addrRes.error) {
                // Timeout or network error — keep existing wallet_open state, don't flip to false
                const isTimeout = /timeout|ECONNREFUSED|ETIMEDOUT|socket hang up|network error/i.test(addrRes.error);
                if (!isTimeout) {
                    // Definitive wallet error (e.g. "wallet not open") — clear state
                    next.wallet_open = false;
                    next.address = null;
                }
                // If timeout, leave next.wallet_open / next.address as-is from cache
            } else if (!next.address) {
                next.wallet_open = false;
                next.address = null;
            }
            if (balRes.result) {
                next.balance = balRes.result.balance || 0;
                next.unlocked_balance = balRes.result.unlocked_balance || 0;
                next.blocks_to_unlock = balRes.result.blocks_to_unlock || 0;
                const perSub = Array.isArray(balRes.result.per_subaddress) ? balRes.result.per_subaddress : [];
                next.num_unspent_outputs = perSub.reduce((sum, row) => sum + (row.num_unspent_outputs || 0), 0);
            }
            next.wallet_height = heightRes.result?.height || next.daemon_height;
            next.blocks_behind = next.daemon_height && next.wallet_height ? Math.max(0, next.daemon_height - next.wallet_height) : null;
            next.synced = Boolean(next.wallet_open && next.daemon_height && (next.blocks_behind === null || next.blocks_behind <= 1));
            next.syncing = Boolean(next.wallet_open && !next.synced);
            next.healthy = Boolean(next.wallet_open && (!addrRes.error || next.address) && (!balRes.error || next.balance !== null || next.unlocked_balance !== null));
            if (!next.wallet_open) next.message = addrRes.error || 'No wallet loaded';
            else if (!next.healthy) next.message = balRes.error || addrRes.error || 'Wallet RPC degraded';
            else if (addrRes.error || balRes.error) next.message = `Wallet loaded; using cached state (${balRes.error || addrRes.error})`;
            else if (next.synced) next.message = 'Wallet loaded and daemon synced';
            else next.message = `Wallet loaded, ${next.blocks_behind ?? '?'} blocks behind`;
            next.last_error = next.healthy ? null : next.message;
            next.updated_at = new Date().toISOString();
            walletState = next;
            // Auto-refresh history when wallet is synced and open
            if (walletState.wallet_open && walletState.synced) {
                await refreshWalletHistory({ timeout: WALLET_RPC_SLOW_TIMEOUT_MS }).catch(e => { walletState.history_error = e.message; });
            }
            return walletState;
        } finally {
            walletRefreshInFlight = null;
        }
    })();
    return walletRefreshInFlight;
}
// ═══════════════════════════════════════════════════════════════════════════════
// NODE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/node/info', async (req, res) => {
    try {
        const info = await callNodeRpc('get_info');
        res.json(info);
    } catch (error) {
        // During sync monerod doesn't respond to RPC — fall back to log parsing
        const sync = parseSyncFromLog();
        if (sync) {
            res.json({
                result: {
                    height: sync.height,
                    target_height: sync.target_height,
                    offline: false,
                    status: 'syncing',
                    blocks_left: sync.blocks_left,
                    version: 'v0.19.0.0-beta.2.0-release (log fallback)',
                    nettype: 'testnet',
                    start_time: Math.floor(Date.now() / 1000)
                },
                jsonrpc: '2.0',
                id: '0'
            });
        } else {
            res.status(500).json({ error: 'Failed to fetch node info', details: error.message });
        }
    }
});
app.get('/api/node/sync', async (req, res) => {
    try {
        const sync = await callNodeRpc('sync_info');
        res.json(sync);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch sync info' });
    }
});
app.get('/api/node/peers', async (req, res) => {
    try {
        const peers = await callNodeEndpoint('get_peer_list');
        res.json(peers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch peer list' });
    }
});
app.get('/api/node/connections', async (req, res) => {
    try {
        const conns = await callNodeRpc('get_connections');
        res.json(conns);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch connections' });
    }
});
app.get('/api/node/hard_fork', async (req, res) => {
    try {
        const hf = await callNodeRpc('hard_fork_info');
        res.json(hf);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch hard fork info' });
    }
});
app.get('/api/node/fee', async (req, res) => {
    try {
        const fee = await callNodeEndpoint('get_fee_estimate');
        res.json(fee);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch fee estimate' });
    }
});
app.get('/api/node/tx_pool', async (req, res) => {
    try {
        const pool = await callNodeEndpoint('get_transaction_pool_stats');
        res.json(pool);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tx pool stats' });
    }
});
app.post('/api/node/set_log', async (req, res) => {
    try {
        const { level } = req.body;
        const resp = await axios.post(NODE_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'set_log', params: { categories: level }
        }, { timeout: 5000 });
        monerodLogLevel = level;
        res.json({ status: 'ok', level });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/node/flush_txpool', async (req, res) => {
    try {
        const resp = await axios.post(NODE_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'flush_txpool'
        }, { timeout: 10000 });
        res.json({ status: 'flushed', tx_count: resp.data.result?.tx_count || 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/node/blocks', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const infoRes = await callNodeRpc('get_info', {}, 10000);
        const currentHeight = (infoRes?.result?.height || 0) - 1;
        if (currentHeight < 0) {
            return res.json({ blocks: [], current_height: 0 });
        }
        const endHeight = Math.max(0, currentHeight);
        const startHeight = Math.max(0, endHeight - limit + 1);
        const headersRes = await callNodeRpc('get_block_headers_range', {
            start_height: startHeight,
            end_height: endHeight
        }, 15000);
        const headers = headersRes?.result?.headers || [];
        // Reverse so newest first
        const blocks = headers.reverse().map(h => ({
            height: h.height,
            hash: h.hash,
            timestamp: h.timestamp,
            difficulty: h.difficulty,
            reward: h.reward,
            block_size: h.block_size,
            num_txes: h.num_txes,
            orphan_status: h.orphan_status,
            prev_hash: h.prev_hash
        }));
        res.json({ blocks, current_height: endHeight });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch blocks', details: error.message, blocks: [] });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// LOG STREAMING (SSE)
// ═══════════════════════════════════════════════════════════════════════════════
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
let logClients = [];
function pushLog(level, source, message) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        source,
        message
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    const data = JSON.stringify(entry);
    logClients = logClients.filter(client => {
        try {
            client.write(`data: ${data}\n\n`);
            return true;
        } catch {
            return false;
        }
    });
}
// ═══════════════════════════════════════════════════════════════════════════════
// REAL DAEMON LOG TAILER — reads monerod bitmonero.log and pushes to SSE
// ═══════════════════════════════════════════════════════════════════════════════
const MONEROD_LOG_FILE = process.env.MONEROD_LOG_FILE || '/data/db/testnet/bitmonero.log';
let monerodLogLevel = process.env.DEFAULT_LOG_LEVEL || '0';
let monerodLogPos = 0;
let monerodLogInode = null;

function parseMonerodLogLine(line) {
    // Format: 2026-05-14 00:04:20.727	[P2P2]	INFO	stacktrace	src/common/...	...
    const parts = line.split('\t');
    if (parts.length < 3) return null;
    let level = parts[2]?.toLowerCase() || 'info';
    if (level === 'trace') level = 'debug';
    if (level === 'fatal' || level === 'critical') level = 'error';
    const source = (parts[1]?.replace(/[\[\]]/g, '') || 'monerod').toLowerCase();
    const message = parts.slice(3).join(' ').trim() || parts[0];
    return { level, source, message };
}

async function tailMonerodLog() {
    try {
        if (!fs.existsSync(MONEROD_LOG_FILE)) return;
        const stat = fs.statSync(MONEROD_LOG_FILE);
        // Reset if log rotated (inode changed)
        if (monerodLogInode !== null && stat.ino !== monerodLogInode) {
            monerodLogPos = 0;
        }
        monerodLogInode = stat.ino;
        const size = stat.size;
        if (size < monerodLogPos) monerodLogPos = 0; // truncated
        if (size === monerodLogPos) return;
        const fd = fs.openSync(MONEROD_LOG_FILE, 'r');
        const buf = Buffer.alloc(size - monerodLogPos);
        fs.readSync(fd, buf, 0, buf.length, monerodLogPos);
        fs.closeSync(fd);
        monerodLogPos = size;
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = parseMonerodLogLine(line);
            if (parsed) {
                pushLog(parsed.level, 'monerod', `[${parsed.source}] ${parsed.message}`);
            }
        }
    } catch (e) {
        // Silently ignore — log file may be temporarily unavailable
    }
}
setInterval(tailMonerodLog, 2000);

app.get('/api/node/log_level', (req, res) => {
    res.json({ level: monerodLogLevel });
});
// Poll monerod for status and generate log entries
let lastHeight = 0;
let lastLoggedHashrate = 0;
let lastLoggedJobHeight = -1;
let lastTxCount = 0;
async function pollDaemonLogs() {
    try {
        let info = (await callNodeRpc('get_info')).result;
        if (!info) {
            // RPC blocked during sync -- try log fallback
            info = parseSyncFromLog();
            if (info) {
                pushLog('info', 'monerod', `Syncing... ${info.height}/${info.target_height} (${info.blocks_left != null ? info.blocks_left : '?'} blocks left)`);
            } else {
                pushLog('debug', 'monerod', 'RPC unreachable during sync (expected)');
            }
            return;
        }
        if (info.height !== lastHeight) {
            if (lastHeight > 0) {
                pushLog('info', 'monerod', `New block ${info.height} (${info.height - lastHeight} blocks since last poll)`);
            }
            lastHeight = info.height;
        }
        if (info.tx_count !== lastTxCount && lastTxCount > 0) {
            const diff = info.tx_count - lastTxCount;
            pushLog('info', 'monerod', `${diff} new transaction${diff > 1 ? 's' : ''} in pool`);
            lastTxCount = info.tx_count;
        } else {
            lastTxCount = info.tx_count || 0;
        }
        const totalPeers = (info.incoming_connections_count || 0) + (info.outgoing_connections_count || 0);
        pushLog('debug', 'monerod', `Peers: ${totalPeers} (in: ${info.incoming_connections_count}, out: ${info.outgoing_connections_count}) | Height: ${info.height} | Difficulty: ${info.difficulty}`);
    } catch (err) {
        // RPC blocked during sync -- try log fallback instead of spamming error
        const sync = parseSyncFromLog();
        if (sync) {
            pushLog('info', 'monerod', `Syncing... ${sync.height}/${sync.target_height} (${sync.blocks_left != null ? sync.blocks_left : '?'} blocks left)`);
        } else {
            pushLog('debug', 'monerod', 'RPC unreachable during sync (expected)');
        }
    }
}
setInterval(pollDaemonLogs, 10000);
setTimeout(pollDaemonLogs, 3000);

// Mined blocks store (blocks found by this miner)
const minedBlocks = [];
const MAX_MINED_BLOCKS = 100;

function saveMinedBlock(block) {
    try {
        db.prepare(`
            INSERT OR REPLACE INTO mined_blocks (height, hash, timestamp, difficulty, reward, block_size, num_txes, orphan_status, prev_hash, found_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            block.height,
            block.hash,
            block.timestamp || null,
            block.difficulty || null,
            block.reward || null,
            block.block_size || null,
            block.num_txes || null,
            block.orphan_status ? 1 : 0,
            block.prev_hash || '',
            block.found_at || new Date().toISOString()
        );
    } catch (e) {
        console.log('[miner] DB save error:', e.message);
    }
}
const pendingMinedHeights = new Set();

// Background retry for mined block metadata — daemon may be too busy at detection time
setInterval(async () => {
    if (pendingMinedHeights.size === 0) return;
    const heights = Array.from(pendingMinedHeights);
    for (const tryHeight of heights) {
        try {
            const res = await callNodeRpc('get_block_header_by_height', { height: tryHeight }, 15000);
            const h = res?.result?.block_header;
            if (h) {
                const block = {
                    height: h.height,
                    hash: h.hash,
                    timestamp: h.timestamp || Math.floor(Date.now() / 1000),
                    difficulty: h.difficulty,
                    reward: h.reward,
                    block_size: h.block_size,
                    num_txes: h.num_txes,
                    orphan_status: h.orphan_status,
                    prev_hash: h.prev_hash,
                    found_at: Math.floor(Date.now() / 1000)
                };
                minedBlocks.unshift(block);
                if (minedBlocks.length > MAX_MINED_BLOCKS) minedBlocks.pop();
                saveMinedBlock(block);
                pendingMinedHeights.delete(tryHeight);
                pushLog('info', 'miner', `BLOCK FOUND (resolved)! Height ${h.height} — Reward ${(h.reward / 1e12).toFixed(4)} tXMR`);
            }
        } catch (e) {
            // Daemon still overloaded; keep in pending for next retry cycle
        }
    }
}, 30000);

// Auto-open default spammer wallet — retry on timeout, don't create if file exists
(async function autoOpenSpammerWallet() {
    const MAX_RETRIES = 10;
    let retries = 0;
    while (retries < MAX_RETRIES) {
        try {
            await spammer.openSpammerWallet('spammer_main', '');
            spammer.spammerWalletState.log.unshift({ time: new Date().toISOString(), level: 'info', message: 'Auto-opened spammer wallet: spammer_main' });
            return;
        } catch (e) {
            retries++;
            const msg = e.message || '';
            const notFound = /No such file|does not exist|not found/i.test(msg);
            if (notFound) {
                // Wallet file genuinely doesn't exist — try creating once
                spammer.spammerWalletState.wallet_file_exists = false;
                try {
                    const result = await spammer.createSpammerWallet('spammer_main', '');
                    spammer.spammerWalletState.log.unshift({ time: new Date().toISOString(), level: 'info', message: `Auto-created spammer wallet: ${result.filename} — address ${result.address}` });
                    return;
                } catch (createErr) {
                    spammer.pushSpammerLog('error', `Create failed: ${createErr.message}`);
                }
                // Even if create failed, don't keep looping forever — let user handle it
                break;
            }
            // RPC not ready or other error — keep retrying open
            spammer.spammerWalletState.wallet_file_exists = true; // assume file exists since error wasn't "not found"
            spammer.pushSpammerLog('warning', `Spammer wallet open retry ${retries}/${MAX_RETRIES}: ${msg}`);
            await new Promise(r => setTimeout(r, 10000));
        }
    }
    spammer.pushSpammerLog('error', 'Failed to auto-open spammer wallet after all retries');
})();

// Periodic re-try: if wallet isn't open yet, keep trying
setInterval(async () => {
    if (!spammer.spammerWalletState.wallet_open && !spammer.spammerWalletState.wallet_opening) {
        try {
            await spammer.openSpammerWallet('spammer_main', '');
            spammer.spammerWalletState.log.unshift({ time: new Date().toISOString(), level: 'info', message: 'Auto-opened spammer wallet (periodic retry)' });
        } catch (e) {
            // Silent — will retry on next interval
        }
    }
}, 15000);

// Poll miner container logs
async function pollMinerLogs() {
    try {
        const containers = await callDockerAPI('GET', '/containers/json?all=true');
        const miner = Array.isArray(containers) && containers.find(c =>
            c.Names.includes('/' + MINER_CONTAINER_NAME));
        if (!miner || miner.State !== 'running') {
            return;
        }
        // Get logs from last 30 seconds of miner output
        const logs = await callDockerAPI('GET', `/containers/${MINER_CONTAINER_NAME}/logs?stdout=true&stderr=false&tail=100`);
        let text = '';
        if (Buffer.isBuffer(logs)) {
            // Docker log stream has 8-byte binary framing per chunk: [type(1), pad(3), len(4)] + payload
            let offset = 0;
            while (offset < logs.length) {
                if (offset + 8 > logs.length) break;
                const payloadLen = logs.readUInt32BE(offset + 4);
                if (offset + 8 + payloadLen > logs.length) break;
                text += logs.slice(offset + 8, offset + 8 + payloadLen).toString('utf8');
                offset += 8 + payloadLen;
            }
        } else if (typeof logs === 'string') {
            text = logs;
        }
        if (!text) return;
        // Strip ANSI escape codes before parsing — xmrig output is colorized
        const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
        const lines = text.split('\n').filter(l => l.trim());
        lines.forEach(rawLine => {
            const line = stripAnsi(rawLine);
            // Parse xmrig output lines
            // Examples:
            // [2026-05-11 03:44:03.131]  miner    speed 10s/60s/15m n/a n/a n/a H/s max n/a H/s
            // [2026-05-11 03:43:55.099]  net      new job from monero-fcmp-stressnet-monerod-1:28081 diff 519872 algo rx/0 height 2999991 (441 tx)
            const speedMatch = line.match(/speed\s+10s\/60s\/15m\s+(\S+)\s+(\S+)\s+(\S+)\s+H\/s/i);
            const jobMatch = line.match(/new job from\s+\S+\s+diff\s+(\d+)\s+algo\s+\S+\s+height\s+(\d+)\s+\((\d+)\s+tx\)/i);
            const readyMatch = line.match(/READY threads (\d+)\/(\d+)/i);
            const netMatch = line.match(/net\s+(\S+)\s+(\S.*)/i);
            // Solo daemon mining: xmrig shows "accepted (total/rejected) diff" when a block is found.
            // In solo mode, "accepted" means the daemon accepted a block. We track the accepted counter
            // to detect new block finds and avoid duplicates.
            const acceptedMatch = line.match(/accepted\s+\((\d+)\/(\d+)\)\s+diff\s+(\d+[^\s\)]*)/i);
            const rejectedMatch = line.match(/rejected\s+\(\d+\/(\d+)\)\s+diff\s+\d+[^\s]*\s+["']?Block not accepted["']?/i);
            const blockFoundMatch = line.match(/(block found|found block|submit block|submitblock)/i);
            const resultMatch = line.match(/result\s+(\S+)(?:\s+diff\s+(\d+))?/i);
            if (speedMatch) {
                const s10 = speedMatch[1];
                // Only log hashrate when it changes meaningfully (not every 5s line)
                if (s10 !== 'n/a') {
                    const hr = parseFloat(s10);
                    if (!isNaN(hr)) {
                        // Deduplicate: only push if hashrate changed by >10% or first time
                        const lastHr = lastLoggedHashrate || 0;
                        if (lastHr === 0 || Math.abs(hr - lastHr) / lastHr > 0.1) {
                            pushLog('info', 'miner', `Hashrate: ${s10} H/s`);
                            lastLoggedHashrate = hr;
                        }
                    }
                }
            }
            if (jobMatch) {
                const height = parseInt(jobMatch[2], 10);
                lastHeight = height; // Update lastHeight for accepted-block detection
                // Only log new job when height changes (not every duplicate job broadcast)
                if (height !== lastLoggedJobHeight) {
                    const diff = parseInt(jobMatch[1], 10);
                    pushLog('debug', 'miner', `New job: height ${height}, diff ${diff}, ${jobMatch[3]} txs`);
                    lastLoggedJobHeight = height;
                }
            }
            if (readyMatch) {
                pushLog('info', 'miner', `CPU ready: ${readyMatch[1]}/${readyMatch[2]} threads`);
            }
            // Track accepted counter for deduplication
            if (acceptedMatch) {
                const acceptedCount = parseInt(acceptedMatch[1], 10);
                const diff = acceptedMatch[3];
                if (!globalThis.lastAcceptedCounter || acceptedCount > globalThis.lastAcceptedCounter) {
                    globalThis.lastAcceptedCounter = acceptedCount;
                    const now = Math.floor(Date.now() / 1000);
                    // In solo mining, xmrig reports 'accepted' when a block is found.
                    // lastHeight is the CURRENT template height (the one the miner was working on).
                    // The found block height = lastHeight + 1 because the new job arrives AFTER the accepted.
                    const foundHeight = (lastHeight || 0) + 1;
                    // Try to fetch the actual block data from daemon with retry logic
                    (async () => {
                        let h = null;
                        // Try foundHeight first, then foundHeight-1 as fallback (race condition safety)
                        for (const tryHeight of [foundHeight, foundHeight - 1]) {
                            try {
                                const res = await callNodeRpc('get_block_header_by_height', { height: tryHeight }, 15000);
                                h = res?.result?.block_header;
                                if (h) break;
                            } catch (e) {
                                console.warn(`[miner] get_block_header_by_height(${tryHeight}) failed: ${e.message}`);
                            }
                        }
                        if (h) {
                            const block = {
                                height: h.height,
                                hash: h.hash,
                                timestamp: h.timestamp || now,
                                difficulty: h.difficulty,
                                reward: h.reward,
                                block_size: h.block_size,
                                num_txes: h.num_txes,
                                orphan_status: h.orphan_status,
                                prev_hash: h.prev_hash,
                                found_at: now
                            };
                            minedBlocks.unshift(block);
                            if (minedBlocks.length > MAX_MINED_BLOCKS) minedBlocks.pop();
                            saveMinedBlock(block);
                            pushLog('info', 'miner', `BLOCK FOUND! Height ${h.height} -- Reward ${(h.reward / 1e12).toFixed(4)} tXMR`);
                        } else {
                            // Daemon too busy to serve header yet — queue for background retry
                            pendingMinedHeights.add(foundHeight);
                            pendingMinedHeights.add(foundHeight - 1);
                            pushLog('info', 'miner', `BLOCK FOUND! Height ${foundHeight} (metadata pending — will retry)`);
                        }
                    })();
                }
            }
            if (rejectedMatch) {
                const rejectedCount = parseInt(rejectedMatch[1], 10);
                if (!globalThis.lastRejectedCounter || rejectedCount > globalThis.lastRejectedCounter) {
                    globalThis.lastRejectedCounter = rejectedCount;
                    pushLog('warning', 'miner', `BLOCK REJECTED (orphan): diff ${rejectedMatch.input.match(/diff\s+(\d+)/)?.[1] || 'unknown'}`);
                }
            }
            if (blockFoundMatch) {
                // Legacy: explicit "block found" text (not used by xmrig but keep for other miners)
                const heightMatch = line.match(/height\s+(\d+)/i);
                const height = heightMatch ? parseInt(heightMatch[1]) : (lastHeight || 0);
                const now = Math.floor(Date.now() / 1000);
                callNodeRpc('get_block_header_by_height', { height }, 10000).then(res => {
                    const h = res?.result?.block_header;
                    if (h) {
                        const block = {
                            height: h.height,
                            hash: h.hash,
                            timestamp: h.timestamp || now,
                            difficulty: h.difficulty,
                            reward: h.reward,
                            block_size: h.block_size,
                            num_txes: h.num_txes,
                            orphan_status: h.orphan_status,
                            prev_hash: h.prev_hash,
                            found_at: now
                        };
                        minedBlocks.unshift(block);
                        if (minedBlocks.length > MAX_MINED_BLOCKS) minedBlocks.pop();
                        saveMinedBlock(block);
                        pushLog('info', 'miner', `BLOCK FOUND! Height ${h.height} -- Reward ${(h.reward / 1e12).toFixed(4)} tXMR`);
                    } else {
                        pendingMinedHeights.add(height);
                        pendingMinedHeights.add(height - 1);
                        pushLog('info', 'miner', `BLOCK FOUND! Height ${height} (metadata pending -- will retry)`);
                    }
                }).catch(() => {
                    pendingMinedHeights.add(height);
                    pendingMinedHeights.add(height - 1);
                    pushLog('info', 'miner', `BLOCK FOUND! Height ${height} (metadata pending -- will retry)`);
                });
            }
            if (resultMatch && !blockFoundMatch && !acceptedMatch) {
                pushLog('info', 'miner', `Result: ${resultMatch[1]}${resultMatch[2] ? ', diff ' + resultMatch[2] : ''}`);
            }
            if (netMatch && !speedMatch && !jobMatch && !readyMatch && !blockFoundMatch && !resultMatch && !acceptedMatch && !rejectedMatch) {
                // Other net messages: connection errors, results, etc.
                const msg = netMatch[2];
                if (msg.includes('error') || msg.includes('failed')) {
                    pushLog('warning', 'miner', `Net: ${msg}`);
                }
            }
        });
    } catch (e) {
        // Miner may not exist yet, silently ignore
    }
}
setInterval(pollMinerLogs, 15000);

// SSE endpoint
app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    for (const entry of logBuffer) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    logClients.push(res);
    req.on('close', () => {
        logClients = logClients.filter(c => c !== res);
    });
});
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(logBuffer.slice(-limit));
});
// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/config', async (req, res) => {
    // Detect if monerod is running with --prune-blockchain by inspecting its container
    let pruned = false;
    try {
        const containers = await callDockerAPI('GET', '/containers/json?all=true');
        const monerod = Array.isArray(containers) && containers.find(c =>
            c.Names.includes('/' + MONEROD_CONTAINER_NAME));
        if (monerod && monerod.Command) {
            const cmd = typeof monerod.Command === 'string' ? monerod.Command : JSON.stringify(monerod.Command);
            pruned = /--prune-blockchain/.test(cmd);
        }
    } catch (_) { /* ignore — Docker may not be available */ }
    res.json({
        monerod_rpc: NODE_RPC,
        wallet_rpc: WALLET_RPC,
        port: port,
        version: '1.6.0',
        stressnet_tag: 'v0.19.0.0-beta.2.0',
        network: 'FCMP++ Stressnet',
        tor_proxy: process.env.TOR_PROXY || 'tor:9050',
        pruned,
        features: {
            fcmp: true,
            carrot: true,
            tx_relay_v2: true
        }
    });
});
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/wallet/create', async (req, res) => {
    const { filename, password, language, name } = req.body;
    try {
        await ensureWalletRingDb();
        const fname = validateWalletFilename(filename);
        const displayName = validateDisplayName(name, fname);
        const { job, result } = await runWalletJobNow('create', `Creating wallet ${fname}`, async () => {
            const created = await callWalletRpc('create_wallet', {
                filename: fname,
                password: password || '',
                language: language || 'English'
            }, WALLET_RPC_SLOW_TIMEOUT_MS);
            const meta = readWalletsMeta();
            meta[fname] = { displayName, createdAt: new Date().toISOString(), restoreHeight: 0 };
            writeWalletsMeta(meta);
            setActiveWalletFilename(fname);
            await refreshWalletState({ force: true });
            return created;
        });
        pushLog('info', 'wallet', `Created wallet: ${fname}` + (displayName !== fname ? ` ("${displayName}")` : ''));
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (error) {
        pushLog('error', 'wallet', `Failed to create wallet: ${error.message}`);
        res.status(error.statusCode || 500).json({ error: 'Failed to create wallet', details: error.message });
    }
});
app.post('/api/wallet/open', async (req, res) => {
    const { filename, password } = req.body;
    try {
        await ensureWalletRingDb();
        const fname = validateWalletFilename(filename);
        const { job, result } = await runWalletJobNow('open', `Opening wallet ${fname}`, async () => {
            const opened = await callWalletRpc('open_wallet', { filename: fname, password: password || '' }, WALLET_RPC_SLOW_TIMEOUT_MS);
            setActiveWalletFilename(fname);
            await refreshWalletState({ force: true });
            return opened;
        });
        const state = publicWalletState();
        if (state.address) mergeWalletState({ wallet_open: true, address: state.address, healthy: true, message: 'Wallet opened' });
        pushLog('info', 'wallet', `Opened wallet: ${fname}`);
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (error) {
        pushLog('error', 'wallet', `Failed to open wallet: ${error.message}`);
        res.status(error.statusCode || 500).json({ error: 'Failed to open wallet', details: error.message });
    }
});
app.get('/api/wallet/address', async (req, res) => {
    const state = await refreshWalletState();
    if (!state.wallet_open || !state.address) return res.status(404).json({ error: 'No wallet loaded', details: state.message });
    res.json({ id: '0', jsonrpc: '2.0', result: { address: state.address } });
});
app.get('/api/wallet/addresses', async (req, res) => {
    try {
        const result = await callWalletRpc('get_address', { account_index: 0 }, WALLET_RPC_FAST_TIMEOUT_MS);
        res.json({ id: '0', jsonrpc: '2.0', result: result.result || null });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get addresses', details: error.message });
    }
});
app.get('/api/wallet/balance', async (req, res) => {
    const state = await refreshWalletState();
    if (!state.wallet_open) return res.status(404).json({ error: 'No wallet loaded', details: state.message });
    res.json({ id: '0', jsonrpc: '2.0', result: {
        balance: state.balance || 0,
        unlocked_balance: state.unlocked_balance || 0,
        blocks_to_unlock: state.blocks_to_unlock || 0,
        num_unspent_outputs: state.num_unspent_outputs || 0
    }});
});
app.get('/api/wallet/transfers', async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force && walletState.history_updated_at) {
        return res.json({ id: '0', jsonrpc: '2.0', result: walletState.history, cached: true, updated_at: walletState.history_updated_at, error: walletState.history_error });
    }
    try {
        const history = await refreshWalletHistory({ timeout: WALLET_RPC_SLOW_TIMEOUT_MS });
        res.json({ id: '0', jsonrpc: '2.0', result: history, cached: false, updated_at: walletState.history_updated_at });
    } catch (error) {
        res.status(504).json({ error: 'Transfers are still scanning or wallet-rpc is busy', details: error.message, result: walletState.history || emptyHistory(), cached: true, updated_at: walletState.history_updated_at });
    }
});
app.get('/api/wallet/status', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const state = await refreshWalletState({ force });
        res.json(publicWalletState(state));
    } catch (error) {
        res.status(500).json(publicWalletState({ healthy: false, last_error: error.message, message: error.message }));
    }
});
app.get('/api/wallet/jobs/:id', (req, res) => {
    const job = walletJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(walletJobResponse(job));
});
app.get('/api/wallet/history', (req, res) => {
    res.json({ result: walletState.history || emptyHistory(), updated_at: walletState.history_updated_at, error: walletState.history_error });
});
app.post('/api/wallet/transfer', async (req, res) => {
    const { destinations, priority } = req.body;
    try {
        // FCMP++ eliminates ring signatures — no ring_size parameter needed.
        // The wallet2 RPC will construct FCMP++ proofs automatically.
        const result = await callWalletRpc('transfer', {
            destinations,
            priority: priority || 0,
            get_tx_key: true
        });
        pushLog('info', 'wallet', `TX sent: ${result.result?.tx_hash?.substring(0, 16)}...`);
        res.json(result);
    } catch (error) {
        pushLog('error', 'wallet', `Transfer failed: ${error.message}`);
        res.status(500).json({ error: 'Transfer failed', details: error.message });
    }
});
app.post('/api/wallet/refresh', async (req, res) => {
    try {
        const { job, result } = await runWalletJobNow('refresh', 'Refreshing wallet', async () => {
            const refreshed = await callWalletRpc('refresh', {}, WALLET_RPC_SLOW_TIMEOUT_MS);
            await refreshWalletState({ force: true }).catch(() => null);
            return refreshed;
        });
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (error) {
        res.status(504).json({ error: 'Wallet refresh is still running or wallet-rpc is busy', details: error.message, wallet: publicWalletState() });
    }
});
app.post('/api/wallet/close', async (req, res) => {
    try {
        const { job, result } = await runWalletJobNow('close', 'Closing wallet', async () => {
            const closed = await callWalletRpc('close_wallet', {}, WALLET_RPC_FAST_TIMEOUT_MS);
            setActiveWalletFilename(null);
            walletState = { ...walletState, wallet_open: false, address: null, healthy: false, message: 'Wallet closed', updated_at: new Date().toISOString() };
            return closed;
        });
        pushLog('info', 'wallet', 'Wallet closed');
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (error) {
        res.status(500).json({ error: 'Failed to close wallet', details: error.message });
    }
});
app.post('/api/wallet/rescan', async (req, res) => {
    try {
        pushLog('info', 'wallet', 'Starting blockchain rescan...');
        const result = await callWalletRpc('rescan_blockchain');
        pushLog('info', 'wallet', 'Blockchain rescan complete');
        res.json(result);
    } catch (error) {
        pushLog('error', 'wallet', `Rescan failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to rescan blockchain', details: error.message });
    }
});
app.get('/api/wallet/seed', async (req, res) => {
    try {
        await ensureWalletRingDb();
        let seedResult = null;
        const active = getActiveWalletFilename();
        const meta = readWalletsMeta();
        const activeMeta = active && meta[active] ? meta[active] : {};
        const { job } = await runWalletJobNow('seed', 'Revealing seed phrase', async () => {
            // query_key can stall while the wallet is scanning. Give it one retry after a
            // short forced state refresh rather than letting the frontend crash on timeout.
            try {
                const r = await callWalletRpc('query_key', { key_type: 'mnemonic' }, WALLET_RPC_SLOW_TIMEOUT_MS);
                seedResult = r;
                return r;
            } catch (firstErr) {
                await refreshWalletState({ force: true }).catch(() => null);
                await sleep(500);
                try {
                    const r = await callWalletRpc('query_key', { key_type: 'mnemonic' }, WALLET_RPC_SLOW_TIMEOUT_MS);
                    seedResult = r;
                    return r;
                } catch (secondErr) {
                    secondErr.message = `${secondErr.message}; first attempt: ${firstErr.message}`;
                    throw secondErr;
                }
            }
        });
        const payload = { ...seedResult, job, wallet: publicWalletState() };
        if (activeMeta.restoreHeight != null) {
            payload.restore_height = activeMeta.restoreHeight;
        }
        res.json(payload);
    } catch (error) {
        res.status(504).json({ error: 'Seed phrase is temporarily unavailable', details: error.message, wallet: publicWalletState() });
    }
});
app.post('/api/wallet/restore', async (req, res) => {
    const { seed, filename, password, restore_height, name } = req.body;
    try {
        if (!seed) return res.status(400).json({ error: 'seed phrase required' });
        await ensureWalletRingDb();
        const safeFilename = validateWalletFilename(filename);
        const displayName = validateDisplayName(name, safeFilename);
        const { job, result } = await runWalletJobNow('restore', `Restoring wallet ${safeFilename}`, async () => {
            const restored = await callWalletRpc('restore_deterministic_wallet', {
                filename: safeFilename,
                password: password || '',
                seed: seed,
                restore_height: restore_height || 0,
                language: 'English'
            }, WALLET_RPC_SLOW_TIMEOUT_MS);
            const meta = readWalletsMeta();
            meta[safeFilename] = { displayName, restoreHeight: restore_height || 0 };
            writeWalletsMeta(meta);
            setActiveWalletFilename(safeFilename);
            await refreshWalletState({ force: true }).catch(() => null);
            return restored;
        });
        pushLog('info', 'wallet', `Restored wallet "${displayName}" (${safeFilename}) from seed`);
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (error) {
        pushLog('error', 'wallet', `Failed to restore wallet: ${error.message}`);
        res.status(error.statusCode || 500).json({ error: 'Failed to restore from seed', details: error.message });
    }
});
app.post('/api/wallet/new_address', async (req, res) => {
    try {
        let createdAddress = null;
        let createdIndex = null;
        const { job } = await runWalletJobNow('new_address', 'Creating new subaddress', async () => {
            const created = await callWalletRpc('create_address', { account_index: 0 }, WALLET_RPC_FAST_TIMEOUT_MS);
            createdAddress = created?.result?.address || null;
            createdIndex = created?.result?.address_index ?? null;
            await refreshWalletState({ force: true }).catch(() => null);
            return created;
        });
        pushLog('info', 'wallet', `Created new subaddress: ${createdAddress?.substring(0, 16) || 'unknown'}...`);
        res.json({ createdAddress, createdIndex, job, wallet: publicWalletState() });
    } catch (error) {
        pushLog('error', 'wallet', `Failed to create subaddress: ${error.message}`);
        res.status(500).json({ error: 'Failed to create new address', details: error.message });
    }
});
// ── Wallet management: list, switch, rename ──
app.get('/api/wallet/list', (req, res) => {
    try {
        const meta = readWalletsMeta();
        const wallets = Object.entries(meta).map(([filename, info]) => ({
            filename,
            displayName: info.displayName || filename,
            isActive: filename === activeWalletFilename
        }));
        // Sort: active first, then alphabetically by display name
        wallets.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return a.displayName.localeCompare(b.displayName);
        });
        res.json({ wallets });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/wallet/switch', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    try {
        await ensureWalletRingDb();
        const safeFilename = validateWalletFilename(filename);
        const { job } = await runWalletJobNow('switch', `Switching to wallet ${safeFilename}`, async () => {
            if (activeWalletFilename) {
                try { await callWalletRpc('close_wallet', {}, WALLET_RPC_FAST_TIMEOUT_MS); setActiveWalletFilename(null); } catch (_) {}
            }
            await callWalletRpc('open_wallet', { filename: safeFilename, password: '' }, WALLET_RPC_SLOW_TIMEOUT_MS);
            setActiveWalletFilename(safeFilename);
            await refreshWalletState({ force: true }).catch(() => null);
        });
        pushLog('info', 'wallet', `Switched to wallet: ${safeFilename}`);
        res.json({ success: true, filename: safeFilename, job, wallet: publicWalletState() });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: 'Failed to switch wallet', details: e.message, wallet: publicWalletState() });
    }
});
app.post('/api/wallet/rename', async (req, res) => {
    const { filename, displayName } = req.body;
    if (!filename || !displayName) return res.status(400).json({ error: 'filename and displayName required' });
    try {
        const safeFilename = validateWalletFilename(filename);
        const safeDisplayName = validateDisplayName(displayName, safeFilename);
        const meta = readWalletsMeta();
        if (!meta[safeFilename]) return res.status(404).json({ error: 'Wallet not found' });
        meta[safeFilename].displayName = safeDisplayName;
        writeWalletsMeta(meta);
        res.json({ success: true, filename: safeFilename, displayName: safeDisplayName });
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});
app.post('/api/wallet/delete', async (req, res) => {
    const { filename, confirm } = req.body || {};
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'confirm must be DELETE' });
    try {
        const safeFilename = validateWalletFilename(filename);
        const meta = readWalletsMeta();
        if (!meta[safeFilename]) return res.status(404).json({ error: 'Wallet not found' });
        if (Object.keys(meta).length <= 1) return res.status(400).json({ error: 'Cannot delete the last wallet' });
        const wasActive = safeFilename === getActiveWalletFilename();
        const { job, result } = await runWalletJobNow('delete', `Deleting wallet ${safeFilename}`, async () => {
            if (wasActive) {
                try { await callWalletRpc('close_wallet', {}, WALLET_RPC_FAST_TIMEOUT_MS); } catch (_) {}
                setActiveWalletFilename(null);
                walletState = { ...walletState, wallet_open: false, address: null, healthy: false, message: 'Wallet deleted', updated_at: new Date().toISOString() };
            }
            const files = await deleteWalletFiles(safeFilename);
            delete meta[safeFilename];
            writeWalletsMeta(meta);
            const nextWallet = Object.keys(meta)[0] || null;
            if (wasActive && nextWallet) {
                await callWalletRpc('open_wallet', { filename: nextWallet, password: '' }, WALLET_RPC_SLOW_TIMEOUT_MS);
                setActiveWalletFilename(nextWallet);
                await refreshWalletState({ force: true }).catch(() => null);
            }
            return { success: true, filename: safeFilename, deleted_files: files.deleted, missing_files: files.missing, active_wallet: getActiveWalletFilename() };
        });
        pushLog('info', 'wallet', `Deleted wallet: ${safeFilename}`);
        res.json({ ...result, job, wallet: publicWalletState() });
    } catch (e) {
        pushLog('error', 'wallet', `Failed to delete wallet: ${e.message}`);
        res.status(e.statusCode || 500).json({ error: 'Failed to delete wallet', details: e.message, wallet: publicWalletState() });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR DATA COLLECTOR (Rucknium monerod-monitor reimplemented in Node.js)
// Polls monerod RPC every 30s, stores time-series data in SQLite.
// ═══════════════════════════════════════════════════════════════════════════════
const insertPoolStats = () => db.prepare(`
    INSERT INTO pool_stats (time, bytes_total, bytes_min, bytes_max, bytes_med, bytes_mean,
        fee_total, histo_98pc, num_double_spends, num_failing, num_not_relayed,
        num_10m, oldest, txs_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertInfo = () => db.prepare(`
    INSERT INTO info (time, adjusted_time, alt_blocks_count, block_size_limit, block_size_median,
        block_weight_limit, block_weight_median, cumulative_difficulty, database_size, difficulty,
        free_space, height, height_without_bootstrap, incoming_connections_count,
        outgoing_connections_count, rpc_connections_count, target, target_height, tx_count,
        tx_pool_size, white_peerlist_size, grey_peerlist_size, synchronized, version,
        was_bootstrap_ever_used, rpc_response_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBlockHeader = () => db.prepare(`
    INSERT INTO last_block_header (time, block_size, block_weight, cumulative_difficulty, depth,
        difficulty, hash, height, major_version, minor_version, nonce, num_txes,
        orphan_status, prev_hash, reward, timestamp, wide_cumulative_difficulty, wide_difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertFee = () => db.prepare(`
    INSERT INTO fee_estimate (time, fee, quantization_mask)
    VALUES (?, ?, ?)
`);
const insertConnection = () => db.prepare(`
    INSERT INTO connections (time, address, avg_download, avg_upload, connection_id,
        current_download, current_upload, height, host, incoming, ip, live_time,
        local_ip, localhost, peer_id, port, recv_count, recv_idle_time,
        send_count, send_idle_time, state, support_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBan = () => db.prepare(`
    INSERT INTO bans (time, host, ip, seconds)
    VALUES (?, ?, ?, ?)
`);
async function collectMonitorData() {
    const now = new Date().toISOString();
    try {
        // 1. get_info with RPC response time measurement
        const rpcStart = Date.now();
        const infoRes = await callNodeRpc('get_info');
        const rpcMs = Date.now() - rpcStart;
        const info = infoRes.result;
        if (info) {
            insertInfo().run(
                now, info.adjusted_time, info.alt_blocks_count, info.block_size_limit,
                info.block_size_median, info.block_weight_limit, info.block_weight_median,
                info.cumulative_difficulty, info.database_size, info.difficulty,
                info.free_space, info.height, info.height_without_bootstrap,
                info.incoming_connections_count, info.outgoing_connections_count,
                info.rpc_connections_count, info.target, info.target_height,
                info.tx_count, info.tx_pool_size, info.white_peerlist_size,
                info.grey_peerlist_size, info.synchronized ? 1 : 0, info.version,
                info.was_bootstrap_ever_used ? 1 : 0, rpcMs
            );
        }
        // 2. get_transaction_pool_stats
        try {
            const poolRes = await callNodeEndpoint('get_transaction_pool_stats');
            const ps = poolRes.pool_stats;
            if (ps) {
                insertPoolStats().run(
                    now, ps.bytes_total, ps.bytes_min, ps.bytes_max, ps.bytes_med,
                    ps.bytes_mean, ps.fee_total, ps.histo_98pc, ps.num_double_spends,
                    ps.num_failing, ps.num_not_relayed, ps.num_10m, ps.oldest, ps.txs_total
                );
            }
        } catch {}
        // 3. Top block header. get_last_block_header returns all-zero fields on
        // this FCMP++ build, so ask for the top block by height instead
        // (verified working: real weight/reward/num_txes).
        try {
            const blockRes = info?.height > 0
                ? await callNodeRpc('get_block_header_by_height', { height: info.height - 1 })
                : await callNodeRpc('get_last_block_header');
            const bh = blockRes.result?.block_header;
            if (bh && bh.height > 0) {
                insertBlockHeader().run(
                    now, bh.block_size, bh.block_weight, bh.cumulative_difficulty,
                    bh.depth, bh.difficulty, bh.hash, bh.height, bh.major_version,
                    bh.minor_version, bh.nonce, bh.num_txes, bh.orphan_status ? 1 : 0,
                    bh.prev_hash, bh.reward, bh.timestamp,
                    bh.wide_cumulative_difficulty, bh.wide_difficulty
                );
            }
        } catch {}
        // 4. get_fee_estimate
        try {
            const feeRes = await callNodeEndpoint('get_fee_estimate');
            if (feeRes) {
                insertFee().run(now, feeRes.fee, feeRes.quantization_mask);
            }
        } catch {}
        // 5. get_connections (unrestricted RPC only)
        try {
            const connRes = await callNodeRpc('get_connections');
            const conns = connRes.result?.connections || [];
            const stmt = insertConnection();
            for (const c of conns) {
                stmt.run(
                    now, c.address, c.avg_download, c.avg_upload, c.connection_id,
                    c.current_download, c.current_upload, c.height, c.host,
                    c.incoming ? 1 : 0, c.ip, c.live_time, c.local_ip ? 1 : 0,
                    c.localhost ? 1 : 0, c.peer_id, c.port, c.recv_count,
                    c.recv_idle_time, c.send_count, c.send_idle_time, c.state,
                    c.support_flags
                );
            }
        } catch {}
        // 6. get_bans (unrestricted RPC only)
        try {
            const banRes = await callNodeRpc('get_bans');
            const bans = banRes.result?.bans || [];
            const stmt = insertBan();
            for (const b of bans) {
                stmt.run(now, b.host, b.ip, b.seconds);
            }
        } catch {}
        pushLog('debug', 'monitor', `Data collected — height: ${info?.height || '?'}, RPC: ${rpcMs}ms`);
    } catch (err) {
        pushLog('error', 'monitor', `Collection failed: ${err.message}`);
    }
}
// Retention: the collector writes ~2,900 info rows and up to ~8,600 connection
// rows per day, forever. Keep 30 days; older points only ever feed the "all"
// window, which is downsampled anyway.
const MONITOR_RETENTION_DAYS = 30;
function pruneMonitorData() {
    try {
        const cutoff = new Date(Date.now() - MONITOR_RETENTION_DAYS * 86400000).toISOString();
        let pruned = 0;
        for (const table of ['info', 'pool_stats', 'last_block_header', 'fee_estimate', 'connections', 'bans']) {
            pruned += db.prepare(`DELETE FROM ${table} WHERE time < ?`).run(cutoff).changes;
        }
        if (pruned > 0) pushLog('info', 'monitor', `Pruned ${pruned} data points older than ${MONITOR_RETENTION_DAYS} days`);
    } catch (e) {
        pushLog('error', 'monitor', `Prune failed: ${e.message}`);
    }
}
// Collect every 30 seconds (matching Rucknium's interval)
let monitorInterval;
function startMonitorCollector() {
    pruneMonitorData();
    setInterval(pruneMonitorData, 6 * 3600000);
    collectMonitorData();
    monitorInterval = setInterval(collectMonitorData, 30000);
    pushLog('info', 'monitor', 'Data collector started (30s interval)');
}
// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR API ENDPOINTS — serve time-series data for charts
// ═══════════════════════════════════════════════════════════════════════════════
function getTimeFilter(window) {
    const now = new Date();
    switch (window) {
        case 'hour': return new Date(now - 3600000).toISOString();
        case 'day':  return new Date(now - 86400000).toISOString();
        case 'week': return new Date(now - 604800000).toISOString();
        default:     return '1970-01-01T00:00:00.000Z'; // all
    }
}
// Bucket size for downsampling. The collector writes a row every 30s, so the
// week window is ~20k raw rows and "all" is unbounded; the charts only render
// a few hundred points usefully. hour/day stay raw.
function getBucketSeconds(window) {
    switch (window) {
        case 'week': return 600;   // ~1000 points
        case 'all':  return 1800;
        default:     return 0;     // raw
    }
}
// Build a SELECT for a time-series table: raw rows for small windows, averaged
// buckets (grouped on unix-time / bucket) for wide ones. Column order is
// preserved so the response shape is identical either way.
function timeSeriesQuery(table, columns, window) {
    const since = getTimeFilter(window);
    const bucket = getBucketSeconds(window);
    if (!bucket) {
        return db.prepare(`
            SELECT time, ${columns.join(', ')}
            FROM ${table} WHERE time > ? ORDER BY time ASC
        `).all(since);
    }
    const aggregated = columns.map(c => `AVG(${c}) as ${c}`).join(', ');
    return db.prepare(`
        SELECT MAX(time) as time, ${aggregated}
        FROM ${table} WHERE time > ?
        GROUP BY CAST(strftime('%s', time) AS INTEGER) / ${bucket}
        ORDER BY time ASC
    `).all(since);
}
// Generic time-series query
app.get('/api/monitor/info', (req, res) => {
    try {
        res.json(timeSeriesQuery('info', [
            'height', 'difficulty', 'database_size', 'tx_count', 'tx_pool_size',
            'incoming_connections_count', 'outgoing_connections_count',
            'block_weight_median', 'rpc_response_ms', 'free_space',
            'white_peerlist_size', 'grey_peerlist_size', 'synchronized'
        ], req.query.window));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/monitor/pool', (req, res) => {
    try {
        res.json(timeSeriesQuery('pool_stats', [
            'bytes_total', 'txs_total', 'fee_total', 'bytes_mean', 'oldest',
            'num_double_spends', 'num_failing', 'num_not_relayed'
        ], req.query.window));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/monitor/blocks', (req, res) => {
    try {
        res.json(timeSeriesQuery('last_block_header', [
            'block_weight', 'difficulty', 'height', 'num_txes', 'reward', 'timestamp'
        ], req.query.window));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/monitor/fees', (req, res) => {
    try {
        res.json(timeSeriesQuery('fee_estimate', ['fee', 'quantization_mask'], req.query.window));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/monitor/connections', (req, res) => {
    try {
        const since = getTimeFilter(req.query.window);
        // Return aggregate connection counts per collection time
        const rows = db.prepare(`
            SELECT time,
                   SUM(CASE WHEN incoming = 1 THEN 1 ELSE 0 END) as incoming_count,
                   SUM(CASE WHEN incoming = 0 THEN 1 ELSE 0 END) as outgoing_count,
                   COUNT(*) as total,
                   AVG(live_time) as avg_live_time,
                   SUM(recv_count) as total_recv,
                   SUM(send_count) as total_send
            FROM connections WHERE time > ?
            GROUP BY time ORDER BY time ASC
        `).all(since);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/monitor/bans', (req, res) => {
    try {
        const since = getTimeFilter(req.query.window);
        const rows = db.prepare(`
            SELECT time, COUNT(*) as ban_count
            FROM bans WHERE time > ?
            GROUP BY time ORDER BY time ASC
        `).all(since);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Sync health over Tor. monerod reports target_height=0 (and synchronized=1)
// whenever it has no peers, so "blocks behind" must be judged against the
// highest tip ever observed, and peer-uptime is the % of samples that held at
// least one outgoing connection. These are THE health signals for a Tor-only
// node: sync speed comes down to how often it holds a peer.
app.get('/api/monitor/sync', (req, res) => {
    try {
        const since = getTimeFilter(req.query.window);
        const rows = db.prepare(`
            SELECT time, height, target_height, outgoing_connections_count
            FROM info WHERE time > ? AND height > 0 ORDER BY time ASC
        `).all(since);
        // Seed the running tip with the highest target seen BEFORE the window,
        // so a short window during a peer gap doesn't report a false tip.
        const seed = db.prepare(`
            SELECT MAX(MAX(target_height), MAX(height)) as tip FROM info WHERE time <= ?
        `).get(since);
        let tip = seed?.tip || 0;
        const series = rows.map(r => {
            tip = Math.max(tip, r.target_height || 0, r.height);
            return {
                time: r.time,
                height: r.height,
                blocks_behind: Math.max(0, tip - r.height),
                out_peers: r.outgoing_connections_count || 0
            };
        });
        let summary = null;
        if (series.length >= 2) {
            const first = series[0], last = series[series.length - 1];
            const mins = (new Date(last.time) - new Date(first.time)) / 60000;
            const rate = mins > 0 ? (last.height - first.height) / mins : 0;
            const tipRate = mins > 0 ? Math.max(0, (last.blocks_behind + last.height)
                - (first.blocks_behind + first.height)) / mins : 0;
            const net = rate - tipRate;
            summary = {
                blocks_behind: last.blocks_behind,
                network_tip: tip,
                sync_rate_blk_min: Math.round(rate * 100) / 100,
                tip_rate_blk_min: Math.round(tipRate * 100) / 100,
                peer_uptime_pct: Math.round(100 * series.filter(s => s.out_peers > 0).length / series.length),
                // days until caught up at the current net rate; null = not converging
                eta_days: last.blocks_behind <= 2 ? 0
                    : (net > 0.01 ? Math.round(last.blocks_behind / net / 144) / 10 : null)
            };
        }
        res.json({ series, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Summary stats for monitor dashboard
app.get('/api/monitor/summary', (req, res) => {
    try {
        const latestInfo = db.prepare('SELECT * FROM info ORDER BY time DESC LIMIT 1').get();
        const latestPool = db.prepare('SELECT * FROM pool_stats ORDER BY time DESC LIMIT 1').get();
        const latestBlock = db.prepare('SELECT * FROM last_block_header ORDER BY time DESC LIMIT 1').get();
        const latestFee = db.prepare('SELECT * FROM fee_estimate ORDER BY time DESC LIMIT 1').get();
        const totalRows = db.prepare('SELECT COUNT(*) as cnt FROM info').get();
        res.json({
            info: latestInfo,
            pool: latestPool,
            block: latestBlock,
            fee: latestFee,
            total_data_points: totalRows?.cnt || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// STRESS TEST ENGINE — automated TX sending for FCMP++ network stress testing
// ═══════════════════════════════════════════════════════════════════════════════
let stressTestState = {
    running: false,
    intervalMs: 10000,
    amountAtomicMin: 1000000000,   // 0.001 XMR
    amountAtomicMax: 10000000000,  // 0.01 XMR
    targetAddress: '',
    txCount: 0,
    successCount: 0,
    failCount: 0,
    lastTxHash: null,
    lastError: null,
    timings: [],    // FCMP++ proof construction times
    startedAt: null,
    intervalHandle: null,
    txInFlight: false
};
function validateStressConfig({ targetAddress, intervalMs, amountMin, amountMax }) {
    if (typeof targetAddress !== 'string' || !/^[A-Za-z0-9]{90,120}$/.test(targetAddress.trim())) {
        const err = new Error('valid stressnet targetAddress required');
        err.statusCode = 400;
        throw err;
    }
    const safeInterval = intervalMs === undefined ? 10000 : Number(intervalMs);
    if (!Number.isFinite(safeInterval) || safeInterval < MIN_STRESS_INTERVAL_MS) {
        const err = new Error(`intervalMs must be at least ${MIN_STRESS_INTERVAL_MS}`);
        err.statusCode = 400;
        throw err;
    }
    const min = amountMin === undefined ? 0.001 : Number(amountMin);
    const max = amountMax === undefined ? 0.01 : Number(amountMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max < min || max > MAX_STRESS_AMOUNT_XMR) {
        const err = new Error(`amountMin/amountMax must be positive, max >= min, and max <= ${MAX_STRESS_AMOUNT_XMR}`);
        err.statusCode = 400;
        throw err;
    }
    return {
        targetAddress: targetAddress.trim(),
        intervalMs: Math.floor(safeInterval),
        amountAtomicMin: Math.round(min * 1e12),
        amountAtomicMax: Math.round(max * 1e12)
    };
}
async function sendStressTransaction() {
    if (!stressTestState.running || !stressTestState.targetAddress) return;
    if (stressTestState.txInFlight) {
        stressTestState.lastError = 'previous transfer still in flight; skipping tick';
        pushLog('warning', 'stress', stressTestState.lastError);
        return;
    }
    stressTestState.txInFlight = true;
    const amount = Math.floor(
        Math.random() * (stressTestState.amountAtomicMax - stressTestState.amountAtomicMin)
        + stressTestState.amountAtomicMin
    );
    stressTestState.txCount++;
    const txStart = Date.now();
    // ── Pre-check: verify wallet has unlocked outputs before attempting transfer ──
    try {
        const bal = await callWalletRpc('get_balance', { account_index: 0 });
        if (bal.result) {
            const unlocked = bal.result.unlocked_balance || 0;
            const numOutputs = bal.result.num_unspent_outputs || 0;
            // Estimate: amount + fee (~20000 piconeros) + 10% buffer
            const needed = amount + 20000 + Math.floor(amount * 0.1);
            if (unlocked < needed || numOutputs === 0) {
                stressTestState.failCount++;
                stressTestState.lastError = `not_enough_unlocked_money: have ${(unlocked/1e12).toFixed(6)} tXMR unlocked across ${numOutputs} outputs`;
                pushLog('warning', 'stress', `TX #${stressTestState.txCount} skipped — ${stressTestState.lastError}`);
                stressTestState.txInFlight = false;
                return;
            }
        }
    } catch (balErr) {
        // Balance check failed — proceed blindly and let transfer error propagate
        pushLog('warning', 'stress', `TX #${stressTestState.txCount} — pre-check failed (${balErr.message}), proceeding anyway`);
    }
    try {
        const result = await callWalletRpc('transfer', {
            destinations: [{
                address: stressTestState.targetAddress,
                amount: amount
            }],
            priority: 0,
            get_tx_key: true
        });
        // ── Check for JSON-RPC error (e.g., not_enough_unlocked_money) ──
        if (result.error) {
            stressTestState.failCount++;
            stressTestState.lastError = result.error.message;
            stressTestState.lastTxHash = null;
            pushLog('error', 'stress', `TX #${stressTestState.txCount} rejected by wallet (${Date.now() - txStart}ms): ${result.error.message}`);
            return;
        }
        const elapsed = Date.now() - txStart;
        stressTestState.successCount++;
        stressTestState.lastTxHash = result.result?.tx_hash;
        stressTestState.timings.push({
            time: new Date().toISOString(),
            ms: elapsed,
            amount,
            hash: result.result?.tx_hash?.substring(0, 16)
        });
        // Keep last 100 timings
        if (stressTestState.timings.length > 100) stressTestState.timings.shift();
        pushLog('info', 'stress', `TX #${stressTestState.txCount} sent in ${elapsed}ms — ${(amount / 1e12).toFixed(4)} tXMR → ${result.result?.tx_hash?.substring(0, 16)}...`);
    } catch (err) {
        stressTestState.failCount++;
        stressTestState.lastError = err.response?.data?.error?.message || err.message;
        pushLog('error', 'stress', `TX #${stressTestState.txCount} failed (${Date.now() - txStart}ms): ${stressTestState.lastError}`);
    } finally {
        stressTestState.txInFlight = false;
    }
}
app.post('/api/stress/start', async (req, res) => {
    const { targetAddress, intervalMs, amountMin, amountMax } = req.body;
    let cfg;
    try {
        cfg = validateStressConfig({ targetAddress, intervalMs, amountMin, amountMax });
    } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
    }
    if (stressTestState.running) {
        return res.status(409).json({ error: 'Stress test already running' });
    }
    stressTestState.running = true;
    stressTestState.targetAddress = cfg.targetAddress;
    stressTestState.intervalMs = cfg.intervalMs;
    stressTestState.amountAtomicMin = cfg.amountAtomicMin;
    stressTestState.amountAtomicMax = cfg.amountAtomicMax;
    stressTestState.txCount = 0;
    stressTestState.successCount = 0;
    stressTestState.failCount = 0;
    stressTestState.lastTxHash = null;
    stressTestState.lastError = null;
    stressTestState.timings = [];
    stressTestState.txInFlight = false;
    stressTestState.startedAt = new Date().toISOString();
    // ── Funding check: warn if wallet doesn't have enough outputs for sustained stress ──
    let fundingWarning = null;
    try {
        const bal = await callWalletRpc('get_balance', { account_index: 0 });
        if (bal.result) {
            const unlocked = bal.result.unlocked_balance || 0;
            const numOutputs = bal.result.num_unspent_outputs || 0;
            const avgAmount = (stressTestState.amountAtomicMin + stressTestState.amountAtomicMax) / 2;
            const maxTxsPerOutput = 1; // each output can only be spent once before change locks
            const estimatedMaxTxs = numOutputs * maxTxsPerOutput;
            if (numOutputs === 0 || unlocked === 0) {
                fundingWarning = `NO UNLOCKED FUNDS — wallet has 0 spendable outputs. Stress engine will fail every tx. Send tXMR from a funded wallet to build outputs first. Each confirmed incoming tx creates 1 spendable output.`;
            } else if (estimatedMaxTxs < 10) {
                fundingWarning = `LOW OUTPUTS: ${numOutputs} spendable output(s), ${(unlocked/1e12).toFixed(4)} tXMR unlocked. You can send at most ${estimatedMaxTxs} tx(s) before change outputs lock for 10 confirmations (~20 min). For sustained stress, send many small incoming txs to build up spendable outputs.`;
            }
        }
    } catch (_) { /* balance check failed — proceed without warning */ }
    // Fire first TX immediately, then at interval
    sendStressTransaction();
    stressTestState.intervalHandle = setInterval(sendStressTransaction, stressTestState.intervalMs);
    pushLog('info', 'stress', `Stress test started — interval: ${stressTestState.intervalMs}ms, target: ${stressTestState.targetAddress.substring(0, 16)}...`);
    if (fundingWarning) pushLog('warning', 'stress', fundingWarning);
    res.json({ status: 'started', fundingWarning, ...stressTestState, intervalHandle: undefined });
});
app.post('/api/stress/stop', (req, res) => {
    if (stressTestState.intervalHandle) {
        clearInterval(stressTestState.intervalHandle);
        stressTestState.intervalHandle = null;
    }
    stressTestState.running = false;
    pushLog('info', 'stress', `Stress test stopped — ${stressTestState.successCount}/${stressTestState.txCount} succeeded`);
    res.json({ status: 'stopped', ...stressTestState, intervalHandle: undefined });
});
app.get('/api/stress/status', (req, res) => {
    const { intervalHandle, ...safe } = stressTestState;
    res.json(safe);
});
app.get('/api/stress/timings', (req, res) => {
    res.json(stressTestState.timings);
});
// ═══════════════════════════════════════════════════════════════════════════════
// SPAMMER WALLET (xmrspammer) ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/xmrspammer/wallet/create', async (req, res) => {
    try {
        const { filename, password } = req.body;
        const result = await spammer.createSpammerWallet(filename, password);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/wallet/open', async (req, res) => {
    try {
        const { filename, password } = req.body;
        const result = await spammer.openSpammerWallet(filename, password);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/wallet/close', async (req, res) => {
    try {
        const result = await spammer.closeSpammerWallet();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/xmrspammer/wallet/status', async (req, res) => {
    try {
        await spammer.refreshSpammerWalletState();
        res.json(spammer.spammerWalletState);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/wallet/refresh', async (req, res) => {
    try {
        const result = await spammer.refreshSpammerWalletState();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/wallet/fund', async (req, res) => {
    try {
        const { amount_xmr } = req.body;
        if (!amount_xmr || amount_xmr <= 0) {
            return res.status(400).json({ error: 'amount_xmr required' });
        }
        const result = await spammer.fundSpammerWallet(amount_xmr);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/tree/build', async (req, res) => {
    try {
        const { levels = 2, outputsPerAccount = 4, priority = 1 } = req.body;
        res.json({ status: 'building', message: 'Starting output tree build...' });
        // Build in background; progress is exposed via wallet/status
        // (tree_building + tree_progress). Note: third arg is a fee PRIORITY
        // (0-4), not an amount — the old code passed 0.0001 here.
        spammer.buildOutputTree(outputsPerAccount, levels, priority).then(result => {
            spammer.spammerWalletState.log.unshift({ time: new Date().toISOString(), level: 'info', message: `Output tree build complete: ${JSON.stringify(result)}` });
        }).catch(err => {
            spammer.spammerWalletState.log.unshift({ time: new Date().toISOString(), level: 'error', message: `Output tree build failed: ${err.message}` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/spam/start', async (req, res) => {
    try {
        const { intervalMs = 15000 } = req.body;
        const result = spammer.startSpamLoop(intervalMs);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/spam/stop', (req, res) => {
    const result = spammer.stopSpamLoop();
    res.json(result);
});
app.get('/api/xmrspammer/spam/status', (req, res) => {
    res.json({
        spamming: spammer.spammerWalletState.spamming,
        spam_count: spammer.spammerWalletState.spam_count || 0,
        spam_success: spammer.spammerWalletState.spam_success || 0,
        wallet_open: spammer.spammerWalletState.wallet_open
    });
});
app.get('/api/xmrspammer/log', (req, res) => {
    // Field is `log` (singular); the old `.logs` read meant this endpoint
    // returned an empty list forever and the UI's spammer log never rendered.
    res.json({ logs: spammer.spammerWalletState.log || [] });
});
app.get('/api/xmrspammer/wallet/seed', async (req, res) => {
    try {
        if (!spammer.spammerWalletState.wallet_open) {
            return res.status(400).json({ error: 'No spammer wallet open' });
        }
        const seed = await spammer.getSpammerSeed();
        const restoreHeight = await spammer.getSpammerRestoreHeight();
        res.json({ result: { key: seed }, restore_height: restoreHeight });
    } catch (e) {
        res.status(504).json({ error: 'Seed phrase temporarily unavailable', details: e.message });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/xmrspammer/recovery/flush_txpool', async (req, res) => {
    try {
        const resp = await axios.post(NODE_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'flush_txpool'
        }, { timeout: 10000 });
        res.json({ status: 'flushed', result: resp.data.result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/recovery/rescan_spent', async (req, res) => {
    try {
        const resp = await axios.post(WALLET_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'rescan_spent'
        }, { timeout: 120000 });
        res.json({ status: 'rescanned_spent', result: resp.data.result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/xmrspammer/recovery/rescan_blockchain', async (req, res) => {
    try {
        const resp = await axios.post(WALLET_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'rescan_blockchain'
        }, { timeout: 120000 });
        res.json({ status: 'rescanned_blockchain', result: resp.data.result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/xmrspammer/recovery/pending_txs', async (req, res) => {
    try {
        const resp = await axios.post(WALLET_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'get_transfers',
            params: { pending: true }
        }, { timeout: 30000 });
        res.json({ pending: resp.data.result || {} });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/xmrspammer/recovery/main_wallet_status', async (req, res) => {
    try {
        const bal = await axios.post(WALLET_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'get_balance'
        }, { timeout: 30000 });
        const info = await axios.post(WALLET_RPC + '/json_rpc', {
            jsonrpc: '2.0', id: '0', method: 'get_height'
        }, { timeout: 30000 });
        res.json({
            balance: bal.data.result?.balance || 0,
            unlocked_balance: bal.data.result?.unlocked_balance || 0,
            height: info.data.result?.height || 0
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// MINING CONTROL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const MINER_CONTAINER_NAME = 'monero-fcmp-stressnet-miner';
const COMPOSE_FILE = '/home/umbrel/umbrel/app-data/monero-fcmp-stressnet/docker-compose.yml';
function callDockerAPI(method, path, body) {
    return new Promise((resolve, reject) => {
        const http = require('http');
        const options = {
            socketPath: DOCKER_SOCK,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const text = buf.toString('utf8');
                // Docker logs endpoint returns binary framed data, return as Buffer
                if (path.includes('/logs')) {
                    resolve(buf);
                    return;
                }
                try { resolve(JSON.parse(text)); }
                catch (e) { resolve(text); }
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}
app.post('/api/miner/start', async (req, res) => {
    try {
        const { threads = 2, address } = req.body;
        if (!address || typeof address !== 'string' || address.trim().length < 95) {
            return res.status(400).json({ error: 'A valid Monero address (at least 95 characters) is required.' });
        }
        const minerAddress = address.trim();
        // Check if already running and compare settings
        try {
            const containers = await callDockerAPI('GET', '/containers/json?all=true');
            const existing = Array.isArray(containers) && containers.find(c =>
                c.Names.includes('/' + MINER_CONTAINER_NAME));
            if (existing) {
                if (existing.State === 'running') {
                    // Inspect current config to compare settings
                    let currentThreads = null;
                    let currentAddress = null;
                    try {
                        const inspect = await callDockerAPI('GET', `/containers/${MINER_CONTAINER_NAME}/json`);
                        const cmd = inspect?.Config?.Cmd || [];
                        const uIdx = cmd.indexOf('-u');
                        const tIdx = cmd.indexOf('-t');
                        if (uIdx >= 0 && uIdx + 1 < cmd.length) currentAddress = cmd[uIdx + 1];
                        if (tIdx >= 0 && tIdx + 1 < cmd.length) currentThreads = parseInt(cmd[tIdx + 1], 10);
                    } catch (e) {}
                    // If settings match, return already running
                    if (currentAddress === minerAddress && currentThreads === threads) {
                        return res.json({ status: 'already_running', container: MINER_CONTAINER_NAME, address: currentAddress, threads: currentThreads });
                    }
                    // Settings changed — stop and recreate
                    await callDockerAPI('POST', `/containers/${MINER_CONTAINER_NAME}/stop?t=10`);
                    await callDockerAPI('DELETE', `/containers/${MINER_CONTAINER_NAME}?force=true`);
                } else {
                    // Remove stopped container
                    await callDockerAPI('DELETE', `/containers/${MINER_CONTAINER_NAME}?force=true`);
                }
            }
        } catch (e) { /* ignore */ }
        // Spawn miner container via Docker API
        const createBody = {
            Image: 'sirjamzalot/superbrain-xmrig:v1.1',
            Cmd: [
                '-o', 'monero-fcmp-stressnet-monerod-1:28081',
                '-u', minerAddress,
                '-p', 'x',
                '-t', String(threads),
                '-a', 'rx/0',
                '--donate-level', '0',
                '--print-time', '5',
                '--daemon',
            ],
            HostConfig: {
                NetworkMode: 'monero-fcmp-stressnet_default',
                RestartPolicy: { Name: 'unless-stopped' }
            },
            Labels: { 'umbrel.app': 'monero-fcmp-stressnet', 'component': 'miner' }
        };
        const createResp = await callDockerAPI('POST', '/containers/create?name=' + MINER_CONTAINER_NAME, createBody);
        if (createResp.Id) {
            await callDockerAPI('POST', `/containers/${createResp.Id}/start`);
            res.json({ status: 'started', container: MINER_CONTAINER_NAME, address: minerAddress, threads });
        } else if (createResp.message) {
            res.status(500).json({ error: createResp.message });
        } else {
            res.status(500).json({ error: 'Unknown Docker create response', response: createResp });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/miner/stop', async (req, res) => {
    try {
        await callDockerAPI('POST', `/containers/${MINER_CONTAINER_NAME}/stop?t=10`);
        res.json({ status: 'stopped', container: MINER_CONTAINER_NAME });
    } catch (e) {
        // Container may not exist
        res.json({ status: 'not_running_or_not_found', error: e.message });
    }
});
app.get('/api/miner/status', async (req, res) => {
    try {
        const containers = await callDockerAPI('GET', '/containers/json?all=true');
        const miner = Array.isArray(containers) && containers.find(c =>
            c.Names.includes('/' + MINER_CONTAINER_NAME));
        if (miner && miner.State === 'running') {
            // Get mining address from container config (Cmd array: ['-o', '...', '-u', 'ADDRESS', ...])
            let minerAddress = null;
            try {
                const inspect = await callDockerAPI('GET', `/containers/${MINER_CONTAINER_NAME}/json`);
                const cmd = inspect?.Config?.Cmd || inspect?.Config?.Entrypoint || [];
                const uIndex = cmd.indexOf('-u');
                if (uIndex >= 0 && uIndex + 1 < cmd.length) {
                    minerAddress = cmd[uIndex + 1];
                }
            } catch (e) {}
            // Try to get hashrate from container logs
            let hashrate = null;
            try {
                const logs = await callDockerAPI('GET', `/containers/${MINER_CONTAINER_NAME}/logs?stdout=true&stderr=false&tail=20`);
                let text = '';
                if (Buffer.isBuffer(logs)) {
                    let offset = 0;
                    while (offset < logs.length) {
                        if (offset + 8 > logs.length) break;
                        const payloadLen = logs.readUInt32BE(offset + 4);
                        if (offset + 8 + payloadLen > logs.length) break;
                        text += logs.slice(offset + 8, offset + 8 + payloadLen).toString('utf8');
                        offset += 8 + payloadLen;
                    }
                } else if (typeof logs === 'string') {
                    text = logs;
                }
                if (text) {
                    // Strip ANSI escape codes before parsing — xmrig output is colorized
                    text = text.replace(/\x1b\[[0-9;]*m/g, '');
                    // Match xmrig speed line: speed 10s/60s/15m 917.4 919.0 n/a H/s max 984.5 H/s
                    const speedMatch = text.match(/speed\s+10s\/60s\/15m\s+(\S+)\s+(\S+)\s+(\S+)\s+H\/s/i);
                    if (speedMatch) {
                        const s10 = speedMatch[1];
                        if (s10 !== 'n/a' && !isNaN(parseFloat(s10))) {
                            hashrate = parseFloat(s10);
                        }
                    }
                    // Fallback: any number followed by H/s
                    if (!hashrate) {
                        const match = text.match(/(\d+\.?\d*)\s*H\/s/i);
                        if (match) hashrate = parseFloat(match[1]);
                    }
                }
            } catch (e) {}
            // Get daemon stats
            let daemonInfo = null;
            try {
                daemonInfo = await callNodeRpc('get_info', {}, 8000);
                if (!daemonInfo?.result) daemonInfo = null;
            } catch (e) {}
            let blockTemplate = null;
            try {
                const bt = await callNodeRpc('get_block_template', {}, 8000);
                if (bt?.result) blockTemplate = bt.result;
            } catch (e) {}
            res.json({
                running: true,
                container: MINER_CONTAINER_NAME,
                image: miner.Image,
                started: miner.Created,
                hashrate,
                difficulty: daemonInfo?.result?.difficulty || null,
                height: daemonInfo?.result?.height || null,
                block_reward: blockTemplate?.expected_reward || null,
                address: minerAddress
            });
        } else {
            res.json({ running: false, container: MINER_CONTAINER_NAME });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/miner/mined-blocks', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, MAX_MINED_BLOCKS);
    res.json({ blocks: minedBlocks.slice(0, limit), total: minedBlocks.length });
});
// ═══════════════════════════════════════════════════════════════════════════════
// STRESSTEST STATIC PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/stresstest', (req, res) => {
    res.redirect('/stresstest.html');
});
app.get('/stresstest.html', (req, res) => {
    res.sendFile(path.join(buildDir, 'stresstest.html'));
});
// ═══════════════════════════════════════════════════════════════════════════════
// SERVE STATIC FRONTEND
// ═══════════════════════════════════════════════════════════════════════════════
const buildDir = path.join(__dirname, 'build');
app.use(express.static(buildDir));
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(buildDir, 'index.html'));
});
// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
app.listen(port, '0.0.0.0', () => {
    console.log(`[stressnet] Dashboard listening on port ${port}`);
    console.log(`[stressnet] Monerod RPC: ${NODE_RPC}`);
    console.log(`[stressnet] Wallet RPC: ${WALLET_RPC}`);
    console.log(`[stressnet] Monitor DB: ${MONITOR_DB_PATH}`);
    // Initialize monitor DB and start collector
    initMonitorDb();
    // Delay collector start to give monerod time to initialize
    setTimeout(startMonitorCollector, 10000);
    // Resume/auto-open the spammer wallet (delayed for spammer-wallet-rpc boot)
    setTimeout(() => spammer.initSpammerState().catch(e =>
        console.log('[spammer] init probe failed:', e.message)), 15000);
    // Auto-open wallet on startup (wallet-rpc may not be ready yet, retry)
    async function autoOpenWallet(retries = 20, delayMs = 2000) {
        await ensureWalletRingDb();
        const meta = readWalletsMeta();
        const preferred = getActiveWalletFilename() || Object.keys(meta).find(Boolean) || 'stressnet_wallet';
        for (let i = 0; i < retries; i++) {
            try {
                await runWalletJobNow('auto_open', `Auto-opening ${preferred}`, async () => {
                    await callWalletRpc('open_wallet', { filename: preferred, password: '' }, WALLET_RPC_SLOW_TIMEOUT_MS);
                    setActiveWalletFilename(preferred);
                    if (!meta[preferred]) {
                        meta[preferred] = { displayName: preferred, createdAt: new Date().toISOString() };
                        writeWalletsMeta(meta);
                    }
                    await refreshWalletState({ force: true });
                });
                console.log(`[stressnet] Auto-opened wallet: ${preferred}`);
                pushLog('info', 'wallet', `Auto-opened ${preferred} on startup`);
                return;
            } catch (err) {
                const msg = err.response?.data?.error?.message || err.message;
                if (msg.includes('No such file') || msg.includes('does not exist')) {
                    console.log('[stressnet] No existing wallet found — skip auto-open');
                    pushLog('info', 'wallet', 'No existing wallet — create one via Wallet tab');
                    walletState.message = 'No existing wallet — create one via Wallet tab';
                    return;
                }
                walletState.last_error = msg;
                walletState.message = `Wallet auto-open retry ${i + 1}/${retries}: ${msg}`;
                if (i < retries - 1) await sleep(delayMs);
            }
        }
        console.log('[stressnet] Failed to auto-open wallet after retries');
    }
    // Start auto-open after a short delay to let wallet-rpc initialize
    setTimeout(autoOpenWallet, 5000);
    setInterval(() => { refreshWalletState().catch(() => null); }, WALLET_REFRESH_MS);
    pushLog('info', 'system', `Dashboard started on port ${port}`);
    pushLog('info', 'system', `Monerod RPC: ${NODE_RPC}`);
    pushLog('info', 'system', `Wallet RPC: ${WALLET_RPC}`);
    pushLog('info', 'system', `Monitor DB: ${MONITOR_DB_PATH}`);
});
