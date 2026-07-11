import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './mining.css';

// Highest network tip observed this session. monerod reports target_height=0
// (and synchronized=true) whenever it has no peers, so a peerless gap must not
// be mistaken for "caught up". Kept at module scope so it survives tab
// remounts. The chain only grows, so this is monotonic by construction.
let maxObservedTip = 0;

const API = process.env.NODE_ENV === 'development' ? 'http://localhost:8080/api' : '/api';

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════

const fmt = {
    xmr: (a) => a ? (a / 1e12).toFixed(4) : '0.0000',
    diff: (d) => {
        if (!d) return '0';
        if (d > 1e9) return (d / 1e9).toFixed(2) + 'G';
        if (d > 1e6) return (d / 1e6).toFixed(2) + 'M';
        if (d > 1e3) return (d / 1e3).toFixed(2) + 'K';
        return d.toString();
    },
    hash: (h) => h ? h.substring(0, 12) + '...' + h.substring(h.length - 6) : '\u2014',
    time: (ts) => {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    bytes: (b) => {
        if (!b) return '0 B';
        if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
        if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
        if (b > 1e3) return (b / 1e3).toFixed(1) + ' KB';
        return b + ' B';
    },
    shortTime: (ts) => {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ICONS (inline SVG to avoid lucide bundle size)
// ═══════════════════════════════════════════════════════════════════════════════

const Icon = ({ d, size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d={d} />
    </svg>
);

const Icons = {
    Activity: (p) => <Icon {...p} d="M22 12h-4l-3 9L9 3l-3 9H2" />,
    Terminal: (p) => <><Icon {...p} d="M4 17l6-6-6-6" /><line x1="12" y1="19" x2="20" y2="19" stroke={p.color || 'currentColor'} strokeWidth="2" /></>,
    Shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    Send: (p) => <Icon {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
    Settings: (p) => <Icon {...p} d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />,
    Copy: (p) => <Icon {...p} d="M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />,
    Check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
    Refresh: (p) => <Icon {...p} d="M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />,
    Wallet: (p) => <Icon {...p} d="M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />,
    Zap: (p) => <Icon {...p} d="M13 2L3 14h9l-1 10 10-12h-9l1-10z" />,
    BarChart: (p) => <Icon {...p} d="M12 20V10M18 20V4M6 20v-4" />,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MINI CHART — pure SVG sparkline/area chart, no dependencies
// ═══════════════════════════════════════════════════════════════════════════════

function MiniChart({ data, dataKey, width = 320, height = 120, color = 'var(--accent)', label, yFormat }) {
    const [hoverIdx, setHoverIdx] = useState(-1);
    const svgRef = useRef(null);

    if (!data || data.length < 2) {
        return (
            <div className="mini-chart-empty" style={{ width, height }}>
                <span className="mono-xs dimmed">Collecting data...</span>
            </div>
        );
    }

    const values = data.map(d => d[dataKey] || 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const padTop = 10;
    const padBottom = 24;
    const padLeft = 4;
    const padRight = 4;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    const points = values.map((v, i) => {
        const x = padLeft + (i / (values.length - 1)) * chartW;
        const y = padTop + chartH - ((v - min) / range) * chartH;
        return { x, y, v };
    });

    const linePath = `M${points.map(p => `${p.x},${p.y}`).join(' L')}`;
    const areaPath = `${linePath} L${padLeft + chartW},${padTop + chartH} L${padLeft},${padTop + chartH} Z`;

    const lastVal = values[values.length - 1];
    const firstTime = data[0].time;
    const lastTime = data[data.length - 1].time;

    const handleMouseMove = (e) => {
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        // Find nearest point
        let nearest = 0, minDist = Infinity;
        points.forEach((p, i) => {
            const dist = Math.abs(p.x - mx);
            if (dist < minDist) { minDist = dist; nearest = i; }
        });
        // Only snap if within reasonable distance
        setHoverIdx(minDist < chartW * 0.1 ? nearest : -1);
    };

    const handleMouseLeave = () => setHoverIdx(-1);

    const hoveredPt = hoverIdx >= 0 ? points[hoverIdx] : null;
    const hoveredData = hoverIdx >= 0 ? data[hoverIdx] : null;

    return (
        <div className="mini-chart glass-panel" style={{ position: 'relative', overflow: 'visible' }}>
            <div className="mini-chart-header">
                <span className="mini-chart-label">{label}</span>
                <span className="mini-chart-value" style={{ color }}>
                    {hoveredPt && hoveredData
                        ? yFormat ? yFormat(hoveredPt.v) : hoveredPt.v.toLocaleString()
                        : yFormat ? yFormat(lastVal) : lastVal.toLocaleString()
                    }
                </span>
            </div>
            <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
                onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
                <defs>
                    <linearGradient id={`grad-${label?.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                    </linearGradient>
                </defs>
                <path d={areaPath} fill={`url(#grad-${label?.replace(/\s/g, '')})`} />
                <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
                {/* Hover guide line */}
                {hoveredPt && (
                    <>
                        <line x1={hoveredPt.x} y1={padTop} x2={hoveredPt.x} y2={padTop + chartH}
                            stroke="rgba(255,255,255,0.3)" strokeWidth="1" strokeDasharray="3,2" />
                        <circle cx={hoveredPt.x} cy={hoveredPt.y} r="3"
                            fill={color} stroke="#fff" strokeWidth="1" />
                    </>
                )}
                {/* Time labels */}
                <text x={padLeft} y={height - 4} fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="var(--mono)">
                    {fmt.shortTime(firstTime)}
                </text>
                <text x={width - padRight} y={height - 4} fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="var(--mono)" textAnchor="end">
                    {fmt.shortTime(lastTime)}
                </text>
            </svg>
            {/* Tooltip popup */}
            {hoveredPt && hoveredData && (
                <div style={{
                    position: 'absolute',
                    left: hoveredPt.x - 50,
                    top: -8,
                    background: 'rgba(0,0,0,0.9)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                    color: '#fff',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    zIndex: 10,
                    transform: 'translateY(-100%)'
                }}>
                    <div style={{ color }}>{yFormat ? yFormat(hoveredPt.v) : hoveredPt.v.toLocaleString()}</div>
                    <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 9 }}>
                        {fmt.shortTime(hoveredData.time)}
                    </div>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAT CARD
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, sub, accent }) {
    return (
        <div className="stat-card">
            <span className="stat-label">{label}</span>
            <span className="stat-value" style={accent ? { color: accent } : {}}>{value}</span>
            {sub && <span className="stat-sub">{sub}</span>}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD TAB
// ═══════════════════════════════════════════════════════════════════════════════

function DashboardTab({ nodeInfo, syncInfo, poolStats }) {
    if (!nodeInfo) {
        return (
            <div className="center-msg">
                <div className="pulse-ring" />
                <span className="mono-sm">Connecting to monerod via Tor...</span>
            </div>
        );
    }

    const height = nodeInfo.height || 0;
    const reportedTip = Math.max(nodeInfo.target_height || 0, height);
    if (reportedTip > maxObservedTip) maxObservedTip = reportedTip;
    const networkTip = maxObservedTip || height;
    const blocksBehind = Math.max(0, networkTip - height);
    const peerCount = (nodeInfo.outgoing_connections_count || 0) + (nodeInfo.incoming_connections_count || 0);
    // Judge "synchronized" on absolute blocks behind, not a percentage: on a
    // ~3M-block chain, being 23k blocks behind is still ~99% and would wrongly
    // pass a percent threshold. Require a known tip and being within 2 blocks.
    const synced = maxObservedTip > 0 && blocksBehind <= 2;
    const syncPct = networkTip > 0 ? Math.min(100, (height / networkTip) * 100) : 0;

    return (
        <div className="dashboard-grid">
            <div className="stats-row">
                <StatCard label="Block Height" value={nodeInfo.height?.toLocaleString() || '0'} accent="var(--accent)" />
                <StatCard label="Network" value={nodeInfo.nettype?.toUpperCase() || 'STRESSNET'} accent="var(--tor)" />
                <StatCard label="Difficulty" value={fmt.diff(nodeInfo.difficulty)} />
                <StatCard label="TX Count" value={nodeInfo.tx_count?.toLocaleString() || '0'} />
                <StatCard label="DB Size" value={fmt.bytes(nodeInfo.database_size)} />
            </div>

            <div className="glass-panel sync-panel">
                <div className="sync-header">
                    <span className="mono-sm">
                        {synced ? '\u25cf SYNCHRONIZED' : (peerCount > 0 ? '\u25cc SYNCING...' : '\u25cc SEARCHING FOR PEERS')}
                    </span>
                    <span className="mono-sm">{synced ? '100%' : `${blocksBehind.toLocaleString()} behind`}</span>
                </div>
                <div className="sync-track">
                    <div className="sync-fill" style={{ width: `${syncPct}%` }}>
                        <div className="sync-glow" />
                    </div>
                </div>
                <div className="sync-footer">
                    <span>Current: {height.toLocaleString()}</span>
                    <span>Target: {networkTip.toLocaleString()}</span>
                </div>
            </div>

            <div className="detail-grid">
                <div className="glass-panel detail-panel">
                    <h3 className="panel-title"><Icons.Shield size={14} color="var(--tor)" /> Tor Connections</h3>
                    <div className="detail-rows">
                        <div className="detail-row">
                            <span>Inbound</span>
                            <span className="mono">{nodeInfo.incoming_connections_count || 0}</span>
                        </div>
                        <div className="detail-row">
                            <span>Outbound</span>
                            <span className="mono">{nodeInfo.outgoing_connections_count || 0}</span>
                        </div>
                        <div className="detail-row">
                            <span>RPC Connections</span>
                            <span className="mono">{nodeInfo.rpc_connections_count || 0}</span>
                        </div>
                        <div className="detail-row">
                            <span>White Peerlist</span>
                            <span className="mono">{nodeInfo.white_peerlist_size || 0}</span>
                        </div>
                        <div className="detail-row">
                            <span>Grey Peerlist</span>
                            <span className="mono">{nodeInfo.grey_peerlist_size || 0}</span>
                        </div>
                    </div>
                </div>

                <div className="glass-panel detail-panel">
                    <h3 className="panel-title"><Icons.Activity size={14} color="var(--accent)" /> Chain Info</h3>
                    <div className="detail-rows">
                        <div className="detail-row">
                            <span>Top Block</span>
                            <span className="mono hash">{fmt.hash(nodeInfo.top_block_hash)}</span>
                        </div>
                        <div className="detail-row">
                            <span>Version</span>
                            <span className="mono">{nodeInfo.version || '\u2014'}</span>
                        </div>
                        <div className="detail-row">
                            <span>Free Disk</span>
                            <span className="mono">{fmt.bytes(nodeInfo.free_space)}</span>
                        </div>
                        <div className="detail-row">
                            <span>Busy Syncing</span>
                            <span className="mono">{nodeInfo.busy_syncing ? 'YES' : 'NO'}</span>
                        </div>
                        <div className="detail-row">
                            <span>TX Pool Size</span>
                            <span className="mono">{poolStats?.pool_stats?.txs_total || 0}</span>
                        </div>
                    </div>
                </div>

                {syncInfo && syncInfo.peers && syncInfo.peers.length > 0 && (
                    <div className="glass-panel detail-panel peer-panel">
                        <h3 className="panel-title">Connected Peers ({syncInfo.peers.length})</h3>
                        <div className="peer-list">
                            {syncInfo.peers.slice(0, 8).map((p, i) => (
                                <div key={i} className="peer-row">
                                    <span className="peer-dot" />
                                    <span className="mono-xs">{p.info?.address?.substring(0, 24) || 'hidden'}</span>
                                    <span className="mono-xs dimmed">h:{p.info?.height || '?'}</span>
                                </div>
                            ))}
                            {syncInfo.peers.length > 8 && (
                                <span className="mono-xs dimmed">+{syncInfo.peers.length - 8} more</span>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function LogsTab() {
    const [logs, setLogs] = useState([]);
    const [filter, setFilter] = useState('all');
    const [autoScroll, setAutoScroll] = useState(true);
    const logRef = useRef(null);

    useEffect(() => {
        const es = new EventSource(`${API}/logs/stream`);
        es.onmessage = (evt) => {
            try {
                const entry = JSON.parse(evt.data);
                setLogs(prev => {
                    const next = [...prev, entry];
                    return next.length > 500 ? next.slice(-500) : next;
                });
            } catch {}
        };
        return () => es.close();
    }, []);

    useEffect(() => {
        if (autoScroll && logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    const filtered = filter === 'all' ? logs : logs.filter(l => l.source === filter || l.level === filter);

    return (
        <div className="logs-container">
            <div className="logs-toolbar">
                <div className="log-filters">
                    {['all', 'monerod', 'wallet', 'miner', 'monitor', 'stress', 'system', 'error'].map(f => (
                        <button key={f} className={`log-filter-btn ${filter === f ? 'active' : ''}`}
                            onClick={() => setFilter(f)}>
                            {f}
                        </button>
                    ))}
                </div>
                <label className="auto-scroll-toggle">
                    <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                    <span>auto-scroll</span>
                </label>
            </div>
            <div className="log-output" ref={logRef}>
                {filtered.length === 0 && (
                    <div className="log-empty">Waiting for events...</div>
                )}
                {filtered.map((entry, i) => (
                    <div key={i} className={`log-line level-${entry.level}`}>
                        <span className="log-ts">{fmt.time(entry.ts)}</span>
                        <span className={`log-src src-${entry.source}`}>[{entry.source}]</span>
                        <span className="log-msg">{entry.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TAB
// ═══════════════════════════════════════════════════════════════════════════════

function WalletTab({ onExplorerTx }) {
    const [address, setAddress] = useState(null);
    const [addresses, setAddresses] = useState([]);
    const [balance, setBalance] = useState(null);
    const [transfers, setTransfers] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);
    const [sendAddr, setSendAddr] = useState('');
    const [sendAmt, setSendAmt] = useState('');
    const [sending, setSending] = useState(false);
    const [txResult, setTxResult] = useState(null);
    const [seed, setSeed] = useState(null);
    const [showSeed, setShowSeed] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);
    const [seedLoading, setSeedLoading] = useState(false);
    const [seedRes, setSeedRes] = useState(null);
    const [restoreSeed, setRestoreSeed] = useState('');
    const [restoreHeight, setRestoreHeight] = useState('');
    const [restoreName, setRestoreName] = useState('');
    const [restoring, setRestoring] = useState(false);
    const [showRestore, setShowRestore] = useState(false);
    const [wallets, setWallets] = useState([]);
    const [showCreate, setShowCreate] = useState(false);
    const [newWalletName, setNewWalletName] = useState('');
    const [creating, setCreating] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [deletingWallet, setDeletingWallet] = useState(null);
    const [walletStatus, setWalletStatus] = useState(null);
    const [walletLoadingDetail, setWalletLoadingDetail] = useState('Checking wallet service...');
    const [addrCopied, setAddrCopied] = useState(null);

    const fetchAddresses = useCallback(async () => {
        try {
            const res = await axios.get(`${API}/wallet/addresses`, { timeout: 8000 });
            if (res.data?.result?.addresses) {
                setAddresses(res.data.result.addresses);
            }
        } catch {}
    }, []);

    const applyWalletState = useCallback((state) => {
        if (!state) return;
        setWalletStatus(state);
        if (state.address) setAddress(state.address);
        else if (!state.wallet_open) setAddress(null);
        if (state.balance !== null || state.unlocked_balance !== null) {
            setBalance({
                balance: state.balance || 0,
                unlocked_balance: state.unlocked_balance || 0,
                blocks_to_unlock: state.blocks_to_unlock || 0,
                num_unspent_outputs: state.num_unspent_outputs || 0
            });
        }
        if (state.history) setTransfers(state.history);
    }, []);

    const clearSensitiveWalletState = useCallback(() => {
        setSeed(null);
        setShowSeed(false);
        setSeedCopied(false);
        setSeedLoading(false);
        setTxResult(null);
    }, []);

    const fetchWallet = useCallback(async ({ initial = false, force = false } = {}) => {
        if (initial) {
            setLoading(true);
            setWalletLoadingDetail('Checking wallet service...');
        }
        try {
            const statusRes = await axios.get(`${API}/wallet/status${force ? '?force=1' : ''}`, { timeout: 45000 });
            const status = statusRes.data || null;
            applyWalletState(status);
            if (initial && status?.message) setWalletLoadingDetail(status.message);
            setError(status?.wallet_open && !status?.healthy ? status.message : null);
        } catch (e) {
            const msg = e.response?.data?.message || e.response?.data?.error || e.message;
            setError(msg);
            if (initial) setWalletLoadingDetail(msg);
        } finally {
            if (initial) setLoading(false);
        }
    }, [applyWalletState]);

    const fetchWallets = useCallback(async () => {
        try {
            const res = await axios.get(`${API}/wallet/list`, { timeout: 8000 });
            setWallets(res.data?.wallets || []);
        } catch {}
    }, []);

    useEffect(() => {
        fetchWallet({ initial: true });
        fetchWallets();
        fetchAddresses();
        const iv = setInterval(() => { fetchWallet(); fetchAddresses(); }, 15000);
        return () => clearInterval(iv);
    }, [fetchWallet, fetchWallets, fetchAddresses]);

    const createWallet = async () => {
        setLoading(true);
        try {
            const res = await axios.post(`${API}/wallet/create`, { filename: 'stressnet_wallet', password: '' }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallets();
            await fetchWallet({ initial: true });
        } catch (e) {
            setError('Failed to create wallet: ' + (e.response?.data?.details || e.message));
            setLoading(false);
        }
    };

    const openWallet = async () => {
        setLoading(true);
        try {
            const res = await axios.post(`${API}/wallet/open`, { filename: 'stressnet_wallet', password: '' }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallet({ initial: true });
            await fetchWallets();
        } catch (e) {
            setError('Failed to open wallet: ' + (e.response?.data?.details || e.message));
            setLoading(false);
        }
    };

    const switchWallet = async (filename) => {
        setSwitching(true);
        setError(null);
        clearSensitiveWalletState();
        try {
            const res = await axios.post(`${API}/wallet/switch`, { filename }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallets();
            await fetchWallet({ initial: true });
        } catch (e) {
            setError('Switch failed: ' + (e.response?.data?.details || e.message));
            if (e.response?.data?.wallet) applyWalletState(e.response.data.wallet);
        } finally {
            setSwitching(false);
        }
    };

    const closeWallet = async () => {
        setLoading(true);
        setError(null);
        clearSensitiveWalletState();
        try {
            await axios.post(`${API}/wallet/close`, {}, { timeout: 15000 });
            setAddress(null);
            setBalance(null);
            setTransfers(null);
            setWalletStatus(null);
            await fetchWallets();
        } catch (e) {
            setError('Close failed: ' + (e.response?.data?.details || e.message));
        } finally {
            setLoading(false);
        }
    };

    const deleteWallet = async (filename) => {
        if (!filename) return;
        if (!window.confirm(`Delete wallet "${filename}"? This removes the wallet cache and keys from this app. Make sure the seed is backed up.`)) return;
        setDeletingWallet(filename);
        setError(null);
        clearSensitiveWalletState();
        try {
            const res = await axios.post(`${API}/wallet/delete`, { filename, confirm: 'DELETE' }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallets();
            await fetchWallet({ initial: true });
        } catch (e) {
            setError('Delete failed: ' + (e.response?.data?.details || e.response?.data?.error || e.message));
            if (e.response?.data?.wallet) applyWalletState(e.response.data.wallet);
        } finally {
            setDeletingWallet(null);
        }
    };

    const createNamedWallet = async () => {
        if (!newWalletName.trim()) return;
        setCreating(true);
        setError(null);
        clearSensitiveWalletState();
        const safeFilename = newWalletName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 32);
        try {
            const res = await axios.post(`${API}/wallet/create`, {
                filename: safeFilename,
                password: '',
                name: newWalletName.trim()
            }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallets();
            await fetchWallet({ initial: true });
            setShowCreate(false);
            setNewWalletName('');
        } catch (e) {
            setError('Create failed: ' + (e.response?.data?.details || e.message));
        } finally {
            setCreating(false);
        }
    };

    const restoreWallet = async () => {
        if (!restoreSeed.trim()) return;
        setRestoring(true);
        setError(null);
        clearSensitiveWalletState();
        const safeFilename = (restoreName.trim() || 'restored_wallet')
            .toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 32);
        try {
            const res = await axios.post(`${API}/wallet/restore`, {
                seed: restoreSeed.trim(),
                filename: safeFilename,
                password: '',
                restore_height: restoreHeight ? parseInt(restoreHeight) : 0,
                name: restoreName.trim() || 'Restored Wallet'
            }, { timeout: 45000 });
            applyWalletState(res.data?.wallet);
            await fetchWallets();
            await fetchWallet({ initial: true });
            setShowRestore(false);
            setRestoreSeed('');
            setRestoreHeight('');
            setRestoreName('');
        } catch (e) {
            setError('Failed to restore: ' + (e.response?.data?.details || e.message));
        } finally {
            setRestoring(false);
        }
    };

    const sendTx = async () => {
        if (!sendAddr || !sendAmt) return;
        setSending(true);
        setTxResult(null);
        try {
            const res = await axios.post(`${API}/wallet/transfer`, {
                destinations: [{ address: sendAddr, amount: Math.round(parseFloat(sendAmt) * 1e12) }]
            }, { timeout: 45000 });
            setTxResult({ success: true, hash: res.data?.result?.tx_hash });
            setSendAddr('');
            setSendAmt('');
            fetchWallet({ force: true });
        } catch (e) {
            setTxResult({ success: false, error: e.response?.data?.details || e.message });
        } finally {
            setSending(false);
        }
    };

    const refreshWallet = async () => {
        setAddrCopied('creating');
        try {
            const res = await axios.post(`${API}/wallet/new_address`, {}, { timeout: 45000 });
            if (res.data?.createdAddress) {
                setAddress(res.data.createdAddress);
                setAddrCopied('done');
                setTimeout(() => setAddrCopied(null), 2000);
            }
            if (res.data?.wallet) applyWalletState(res.data.wallet);
        } catch (e) {
            setError('New address failed: ' + (e.response?.data?.details || e.message));
            setAddrCopied(null);
        }
    };

    const revealSeed = async () => {
        if (seed) {
            setShowSeed(v => !v);
            return;
        }
        setSeedLoading(true);
        setError(null);
        try {
            const seedResponse = await axios.get(`${API}/wallet/seed`, { timeout: 45000 });
            setSeedRes(seedResponse);
            if (seedResponse?.data?.result?.key) {
                setSeed(seedResponse.data.result.key);
                setShowSeed(true);
            } else {
                setError('Seed phrase was not returned by wallet-rpc. Try again after sync completes.');
            }
            if (seedResponse.data?.wallet) applyWalletState(seedResponse.data.wallet);
        } catch (e) {
            const detail = e.response?.data?.details || e.response?.data?.error || e.message;
            setError('Seed phrase temporarily unavailable: ' + detail);
            if (e.response?.data?.wallet) applyWalletState(e.response.data.wallet);
        } finally {
            setSeedLoading(false);
        }
    };

    const copySeed = () => {
        if (seed) {
            try { navigator.clipboard.writeText(seed); }
            catch {
                const ta = document.createElement('textarea');
                ta.value = seed; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
            }
            setSeedCopied(true);
            setTimeout(() => setSeedCopied(false), 2000);
        }
    };

    const copyAddr = () => {
        if (address) {
            try { navigator.clipboard.writeText(address); }
            catch {
                const ta = document.createElement('textarea');
                ta.value = address; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const activeWallet = wallets.find(w => w.isActive);
    const activeDisplayName = activeWallet?.displayName || walletStatus?.active_wallet || 'stressnet_wallet';
    const walletSyncText = walletStatus
        ? walletStatus.synced ? 'SYNCED' : walletStatus.syncing ? `SYNCING · ${walletStatus.blocks_behind ?? '?'} BLOCKS BEHIND` : 'NOT SYNCED'
        : 'CHECKING';
    const walletSyncClass = walletStatus?.synced ? 'sync-ok' : walletStatus?.healthy ? 'sync-warn' : 'sync-bad';

    if (!address && !loading && !showRestore && !showCreate) {
        return (
            <div className="wallet-init">
                <div className="wallet-init-icon">{'\u25C8'}</div>
                <h3>No Wallet Loaded</h3>
                <p className="dimmed">Initialize a stressnet wallet to begin testing FCMP++ transactions over Tor.</p>
                {error && <div className="error-bar">{error}</div>}
                {wallets.length > 0 && (
                    <div className="wallet-switcher-list">
                        <div className="mono-xs dimmed" style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Saved Wallets</div>
                        {wallets.map(w => (
                            <button key={w.filename} className="wallet-switch-btn" onClick={() => switchWallet(w.filename)} disabled={switching}>
                                <span className="mono-sm">{w.displayName}</span>
                                <span className="mono-xs dimmed">{w.filename}</span>
                            </button>
                        ))}
                    </div>
                )}
                <div className="wallet-init-btns">
                    <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Wallet</button>
                    <button className="btn-ghost" onClick={createWallet}>Create Default</button>
                    <button className="btn-ghost" onClick={openWallet}>Open Existing</button>
                    <button className="btn-ghost" onClick={() => setShowRestore(true)}>Import from Seed</button>
                </div>
            </div>
        );
    }

    if (showCreate) {
        return (
            <div className="wallet-init">
                <div className="wallet-init-icon">{'\u25C8'}</div>
                <h3>Create New Wallet</h3>
                <p className="dimmed">Give your wallet a name. It will be saved and you can switch between wallets.</p>
                {error && <div className="error-bar">{error}</div>}
                <div className="restore-form">
                    <div className="form-group"><label>Wallet Name</label><input type="text" className="input-dark" placeholder="My Stressnet Wallet" value={newWalletName} onChange={e => setNewWalletName(e.target.value)} autoFocus maxLength={32} /></div>
                    <div className="wallet-init-btns">
                        <button className="btn-primary" onClick={createNamedWallet} disabled={creating || !newWalletName.trim()}>{creating ? 'Creating...' : 'Create Wallet'}</button>
                        <button className="btn-ghost" onClick={() => { setShowCreate(false); setError(null); setNewWalletName(''); }}>Cancel</button>
                    </div>
                </div>
            </div>
        );
    }

    if (showRestore) {
        return (
            <div className="wallet-init">
                <div className="wallet-init-icon">{'\u25C8'}</div>
                <h3>Restore from Seed Phrase</h3>
                <p className="dimmed">Enter your 25-word mnemonic seed phrase. Give it a name to save it to your wallet list.</p>
                {error && <div className="error-bar">{error}</div>}
                <div className="restore-form">
                    <div className="form-group"><label>Wallet Name</label><input type="text" className="input-dark" placeholder="My Restored Wallet" value={restoreName} onChange={e => setRestoreName(e.target.value)} maxLength={32} /></div>
                    <div className="form-group"><label>Seed Phrase (25 words)</label><textarea className="input-dark seed-input" placeholder="Enter all 25 words separated by spaces..." value={restoreSeed} onChange={e => setRestoreSeed(e.target.value)} rows={3} autoFocus /></div>
                    <div className="form-group"><label>Restore Height (optional — 0 = scan from beginning)</label><input type="number" className="input-dark" placeholder="0" value={restoreHeight} onChange={e => setRestoreHeight(e.target.value)} /></div>
                    <div className="wallet-init-btns">
                        <button className="btn-primary" onClick={restoreWallet} disabled={restoring || !restoreSeed.trim()}>{restoring ? 'Restoring...' : 'Restore Wallet'}</button>
                        <button className="btn-ghost" onClick={() => { setShowRestore(false); setError(null); }}>Cancel</button>
                    </div>
                </div>
            </div>
        );
    }

    if (loading && !address) return <div className="center-msg"><div className="pulse-ring" /><span className="mono-sm">Loading wallet...</span><span className="mono-xs dimmed">{walletLoadingDetail}</span></div>;

    const allTx = [];
    if (transfers) ['in', 'out', 'pending', 'pool'].forEach(type => transfers[type]?.forEach(tx => allTx.push({ ...tx, type })));
    allTx.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return (
        <div className="wallet-layout">
            {error && <div className="error-bar">{error}</div>}
            {wallets.length > 1 && (
                <div className="wallet-switcher-bar glass-panel">
                    <span className="mono-xs dimmed" style={{ marginRight: 8 }}>WALLETS:</span>
                    {wallets.map(w => (
                        <button key={w.filename} className={`wallet-switch-tag ${w.isActive ? 'active' : ''}`} onClick={() => !w.isActive && switchWallet(w.filename)} disabled={switching} title={w.filename}>{w.displayName}{w.isActive && <span className="active-dot" />}</button>
                    ))}
                    <button className="btn-ghost btn-sm" onClick={() => setShowCreate(true)} style={{ marginLeft: 4 }}>+ New</button>
                    <button className="btn-ghost btn-sm" onClick={() => setShowRestore(true)} style={{ marginLeft: 4 }}>Import Seed</button>
                </div>
            )}
            <div className="wallet-dashboard-grid"><div className="glass-panel wallet-overview-card"><div className="wallet-overview-top"><div><span className="stat-label">Active Wallet</span><div className="mono" style={{ color: 'var(--text-0)', fontWeight: 700 }}>{activeDisplayName}</div><div className="mono-xs dimmed">{walletStatus?.active_wallet || activeWallet?.filename || 'stressnet_wallet'}</div></div><div className={`wallet-sync-pill ${walletSyncClass}`}>{walletSyncText}</div></div><div className="wallet-actions-row"><button className="btn-ghost btn-sm" onClick={() => fetchWallet({ initial: true, force: true })}>Refresh Status</button><button className="btn-ghost btn-sm" onClick={closeWallet}>Close Wallet</button><button className="btn-danger btn-sm" onClick={() => deleteWallet(walletStatus?.active_wallet || activeWallet?.filename)} disabled={wallets.length <= 1 || deletingWallet || walletStatus?.busy}>{deletingWallet ? 'Deleting...' : 'Delete Wallet'}</button></div></div></div>
            <div className="wallet-header-row">
                <div className="glass-panel wallet-balance-card"><span className="stat-label">Total Balance</span><span className="wallet-balance">{fmt.xmr(balance?.balance)} <small>tXMR</small></span><span className="stat-sub">Unlocked: {fmt.xmr(balance?.unlocked_balance)} tXMR</span><div className={`wallet-sync-pill ${walletSyncClass}`}>{walletSyncText}</div><span className="stat-sub">Daemon: {walletStatus?.daemon_height?.toLocaleString() || '\u2014'} · Outputs: {walletStatus?.num_unspent_outputs ?? balance?.num_unspent_outputs ?? '\u2014'}</span>{walletStatus?.message && <span className="mono-xs dimmed">{walletStatus.message}</span>}</div>
                <div className="glass-panel wallet-address-card"><span className="stat-label">Addresses ({addresses.length})</span><div className="addr-list">{addresses.length === 0 && <div className="mono-xs dimmed">Loading addresses...</div>}{addresses.map((a, i) => (<div key={i} className="addr-row"><span className="mono-xs addr-text">{a.address}</span><button className="icon-btn" onClick={() => { try { navigator.clipboard.writeText(a.address); setAddrCopied(i); setTimeout(() => setAddrCopied(null), 2000); } catch {} }} title="Copy">{addrCopied === i ? <><Icons.Check size={14} color="var(--green)" /> <span style={{ color: 'var(--green)', fontSize: 10, marginLeft: 2 }}>Copied!</span></> : <Icons.Copy size={14} />}</button></div>))}</div><button className="btn-ghost btn-sm" onClick={refreshWallet} disabled={addrCopied === 'creating'}>{addrCopied === 'creating' ? 'Creating...' : addrCopied === 'done' ? <><Icons.Check size={12} color="var(--green)" /> Created</> : <><Icons.Refresh size={12} /> New Address</>}</button></div>
                {address && <div className="glass-panel wallet-seed-card"><div className="seed-header"><span className="stat-label">Seed Phrase (backup for testnet)</span><div className="seed-actions"><button className="icon-btn" onClick={copySeed} title="Copy seed" disabled={!seed || seedLoading}>{seedCopied ? <Icons.Check size={14} color="var(--green)" /> : <Icons.Copy size={14} />}</button><button className="btn-ghost btn-sm" onClick={revealSeed} disabled={seedLoading || walletStatus?.busy}>{seedLoading ? 'Loading...' : showSeed ? 'Hide' : seed ? 'Show' : 'Reveal'}</button></div></div>{showSeed && seed ? <div className="seed-phrase">{seed}</div> : <div className="mono-xs dimmed">Seed is fetched only when you click Reveal, then cleared on wallet switch/create/restore.</div>}{showSeed && seed && seedRes?.data?.restore_height != null && <div className="mono-xs dimmed" style={{ marginTop: 8 }}>Restore height: {seedRes.data.restore_height.toLocaleString()}</div>}</div>}
            </div>
            <div className="wallet-body-row">
                <div className="glass-panel send-panel"><h3 className="panel-title"><Icons.Send size={14} color="var(--accent)" /> Send FCMP++ TX</h3><div className="send-form"><div className="form-group"><label>Recipient</label><input type="text" className="input-dark" placeholder="Stressnet address..." value={sendAddr} onChange={e => setSendAddr(e.target.value)} /></div><div className="form-row"><div className="form-group" style={{ flex: 1 }}><label>Amount (tXMR)</label><input type="number" step="0.0001" className="input-dark" placeholder="0.0000" value={sendAmt} onChange={e => setSendAmt(e.target.value)} /></div><div className="form-group" style={{ width: 90 }}><label style={{ color: 'var(--green)' }}>Proof</label><input type="text" className="input-dark" value="FCMP++" disabled /></div></div><button className="btn-primary btn-full" onClick={sendTx} disabled={sending || !sendAddr || !sendAmt || !balance?.unlocked_balance}>{sending ? 'Broadcasting...' : 'Send Transaction'}</button>{txResult && <div className={`tx-result ${txResult.success ? 'tx-ok' : 'tx-fail'}`}>{txResult.success ? <>TX Sent: <span className="mono-xs">{txResult.hash?.substring(0, 24)}...</span></> : <>Failed: {txResult.error}</>}</div>}</div></div>
                <div className="glass-panel history-panel"><h3 className="panel-title"><Icons.Activity size={14} /> Transaction History</h3><div className="tx-list">{allTx.length === 0 && <div className="dimmed mono-xs" style={{ padding: 16 }}>No transactions yet</div>}{allTx.map((tx, i) => <div key={i} className={`tx-row tx-${tx.type}`}><span className={`tx-dir ${tx.type === 'in' || tx.type === 'pool' ? 'tx-in' : 'tx-out'}`}>{tx.type === 'in' ? '\u2193' : tx.type === 'out' ? '\u2191' : '\u25cc'}</span><span className="mono-xs">{fmt.xmr(tx.amount)} tXMR</span><button className="wallet-tx-clickable" onClick={() => onExplorerTx && onExplorerTx(tx.txid)} title="Explore in block explorer">{tx.txid?.substring(0, 16)}...</button><span className="mono-xs dimmed">{tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString() : 'pending'}</span></div>)}</div></div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITOR TAB — time-series charts from monerod-monitor data
// ═══════════════════════════════════════════════════════════════════════════════

function MonitorTab() {
    const [window, setWindow] = useState('hour');
    const [infoData, setInfoData] = useState([]);
    const [poolData, setPoolData] = useState([]);
    const [blockData, setBlockData] = useState([]);
    const [connData, setConnData] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchData = useCallback(async () => {
        try {
            const [info, pool, blocks, conns, sum] = await Promise.all([
                axios.get(`${API}/monitor/info?window=${window}`).catch(() => ({ data: [] })),
                axios.get(`${API}/monitor/pool?window=${window}`).catch(() => ({ data: [] })),
                axios.get(`${API}/monitor/blocks?window=${window}`).catch(() => ({ data: [] })),
                axios.get(`${API}/monitor/connections?window=${window}`).catch(() => ({ data: [] })),
                axios.get(`${API}/monitor/summary`).catch(() => ({ data: null })),
            ]);
            setInfoData(info.data);
            setPoolData(pool.data);
            setBlockData(blocks.data);
            setConnData(conns.data);
            setSummary(sum.data);
        } catch {} finally {
            setLoading(false);
        }
    }, [window]);

    useEffect(() => {
        fetchData();
        const iv = setInterval(fetchData, 30000);
        return () => clearInterval(iv);
    }, [fetchData]);

    return (
        <div className="monitor-layout">
            {/* Time window selector */}
            <div className="monitor-toolbar">
                <div className="monitor-title">
                    <Icons.BarChart size={14} color="var(--accent)" />
                    <span>Network Monitor</span>
                    {summary && <span className="mono-xs dimmed" style={{ marginLeft: 8 }}>
                        {summary.total_data_points} data points
                    </span>}
                </div>
                <div className="window-selector">
                    {['hour', 'day', 'week', 'all'].map(w => (
                        <button key={w} className={`log-filter-btn ${window === w ? 'active' : ''}`}
                            onClick={() => setWindow(w)}>
                            {w}
                        </button>
                    ))}
                </div>
            </div>

            {loading && infoData.length === 0 ? (
                <div className="center-msg">
                    <div className="pulse-ring" />
                    <span className="mono-sm">Collecting initial data points...</span>
                    <span className="mono-xs dimmed">Charts appear after ~60 seconds of data collection</span>
                </div>
            ) : (
                <>
                    {/* Summary cards */}
                    {summary?.info && (
                        <div className="stats-row" style={{ marginBottom: 16 }}>
                            <StatCard label="Height" value={summary.info.height?.toLocaleString()} accent="var(--accent)" />
                            <StatCard label="Pool TXs" value={summary.pool?.txs_total || 0} />
                            <StatCard label="Difficulty" value={fmt.diff(summary.info.difficulty)} />
                            <StatCard label="RPC Latency" value={`${summary.info.rpc_response_ms?.toFixed(0)}ms`} accent="var(--tor)" />
                            <StatCard label="DB Size" value={fmt.bytes(summary.info.database_size)} />
                        </div>
                    )}

                    {/* Chart grid — txpool & blocks */}
                    <div className="chart-section-title">Transaction Pool &amp; Blocks</div>
                    <div className="chart-grid">
                        <MiniChart data={poolData} dataKey="bytes_total" label="TX Pool Bytes"
                            color="var(--accent)" yFormat={fmt.bytes} />
                        <MiniChart data={poolData} dataKey="txs_total" label="TX Pool Count"
                            color="var(--tor)" />
                        <MiniChart data={blockData} dataKey="block_weight" label="Block Weight"
                            color="#22c55e" yFormat={v => fmt.bytes(v)} />
                        <MiniChart data={blockData} dataKey="reward" label="Block Reward"
                            color="#eab308" yFormat={v => fmt.xmr(v) + ' tXMR'} />
                    </div>

                    {/* Chart grid — network */}
                    <div className="chart-section-title">Network &amp; Connections</div>
                    <div className="chart-grid">
                        <MiniChart data={infoData} dataKey="difficulty" label="Difficulty"
                            color="var(--accent)" yFormat={fmt.diff} />
                        <MiniChart data={infoData} dataKey="database_size" label="Blockchain Size"
                            color="var(--tor)" yFormat={fmt.bytes} />
                        <MiniChart data={connData} dataKey="total" label="Total Connections"
                            color="#22c55e" />
                        <MiniChart data={infoData} dataKey="rpc_response_ms" label="RPC Response Time"
                            color="#ef4444" yFormat={v => v?.toFixed(0) + 'ms'} />
                    </div>

                    {/* Chart grid — mempool health */}
                    <div className="chart-section-title">Mempool Health</div>
                    <div className="chart-grid">
                        <MiniChart data={poolData} dataKey="fee_total" label="Total Fees"
                            color="#eab308" yFormat={v => fmt.xmr(v) + ' tXMR'} />
                        <MiniChart data={poolData} dataKey="bytes_mean" label="Avg TX Size"
                            color="var(--accent)" yFormat={v => fmt.bytes(v)} />
                        <MiniChart data={infoData} dataKey="block_weight_median" label="Block Weight Median"
                            color="var(--tor)" yFormat={fmt.bytes} />
                        <MiniChart data={infoData} dataKey="tx_pool_size" label="Pool Size (from info)"
                            color="#22c55e" />
                    </div>
                </>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRESS TEST TAB — automated FCMP++ TX sending
// ═══════════════════════════════════════════════════════════════════════════════

function StressTestTab() {
    const [spammer, setSpammer] = useState(null);
    const [logs, setLogs] = useState([]);
    const [fundAmount, setFundAmount] = useState('1.0');
    const [treeOutputs, setTreeOutputs] = useState(8);
    const [treeLevels, setTreeLevels] = useState(2);
    const [treeBuilding, setTreeBuilding] = useState(false);
    const [funding, setFunding] = useState(false);
    const [spamStarting, setSpamStarting] = useState(false);
    const [spamStopping, setSpamStopping] = useState(false);
    const [creatingSpammer, setCreatingSpammer] = useState(false);
    const [openingSpammer, setOpeningSpammer] = useState(false);
    const [treeResult, setTreeResult] = useState(null);
    const [fundResult, setFundResult] = useState(null);
    const [spamResult, setSpamResult] = useState(null);
    const [openSpamResult, setOpenSpamResult] = useState(null);
    const [spamInterval, setSpamInterval] = useState(5);
    const [addrCopied, setAddrCopied] = useState(false);
    const [spammerSeed, setSpammerSeed] = useState(null);
    const [showSpammerSeed, setShowSpammerSeed] = useState(false);
    const [spammerSeedLoading, setSpammerSeedLoading] = useState(false);
    const [spammerSeedCopied, setSpammerSeedCopied] = useState(false);

    const fetchSpammer = useCallback(async () => {
        try {
            const res = await axios.get(`${API}/xmrspammer/wallet/status`, { timeout: 8000 });
            setSpammer(res.data);
        } catch {}
    }, []);

    const fetchLogs = useCallback(async () => {
        try {
            const res = await axios.get(`${API}/xmrspammer/log`, { timeout: 5000 });
            setLogs(res.data?.logs || []);
        } catch {}
    }, []);

    useEffect(() => {
        fetchSpammer();
        fetchLogs();
        const iv = setInterval(() => { fetchSpammer(); fetchLogs(); }, 3000);
        return () => clearInterval(iv);
    }, [fetchSpammer, fetchLogs]);

    const handleFund = async () => {
        setFunding(true);
        setFundResult(null);
        try {
            const amt = parseFloat(fundAmount);
            if (!amt || amt <= 0) throw new Error('Invalid amount');
            const res = await axios.post(`${API}/xmrspammer/wallet/fund`, { amount_xmr: Math.floor(amt * 1e12) }, { timeout: 120000 });
            setFundResult({ success: true, msg: res.data?.result?.tx_hash ? `Funded — tx ${res.data.result.tx_hash.substring(0, 24)}...` : 'Funded successfully' });
            fetchSpammer();
        } catch (e) {
            setFundResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setFunding(false); }
    };

    const handleBuildTree = async () => {
        setTreeBuilding(true);
        setTreeResult(null);
        try {
            await axios.post(`${API}/xmrspammer/tree/build`, {
                levels: parseInt(treeLevels),
                outputsPerAccount: parseInt(treeOutputs),
                fee: 0.0001
            }, { timeout: 30000 });
            setTreeResult({ success: true, msg: 'Tree built successfully' });
            fetchSpammer();
        } catch (e) {
            setTreeResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setTreeBuilding(false); }
    };

    const handleStartSpam = async () => {
        setSpamStarting(true);
        setSpamResult(null);
        try {
            const res = await axios.post(`${API}/xmrspammer/spam/start`, { intervalMs: spamInterval * 1000 });
            if (res.data?.status === 'started') {
                setSpamResult({ success: true, msg: 'Spam loop started' });
            } else {
                setSpamResult({ success: false, msg: res.data?.error || res.data?.status || 'Failed to start spam loop' });
            }
            fetchSpammer();
        } catch (e) {
            setSpamResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setSpamStarting(false); }
    };

    const handleStopSpam = async () => {
        setSpamStopping(true);
        setSpamResult(null);
        try {
            await axios.post(`${API}/xmrspammer/spam/stop`);
            setSpamResult({ success: true, msg: 'Spam loop stopped' });
            fetchSpammer();
        } catch (e) {
            setSpamResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setSpamStopping(false); }
    };

    const handleCreateSpammer = async () => {
        setCreatingSpammer(true);
        setSpamResult(null);
        try {
            const res = await axios.post(`${API}/xmrspammer/wallet/create`, { filename: 'spammer_main', password: '' }, { timeout: 80000 });
            setSpamResult({ success: true, msg: `Created spammer wallet — address ${res.data?.address || res.data?.result?.address || 'ready'}` });
            fetchSpammer();
        } catch (e) {
            setSpamResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setCreatingSpammer(false); }
    };

    const handleOpenSpammer = async () => {
        setOpeningSpammer(true);
        setOpenSpamResult(null);
        try {
            const res = await axios.post(`${API}/xmrspammer/wallet/open`, { filename: 'spammer_main', password: '' }, { timeout: 80000 });
            setOpenSpamResult({ success: true, msg: `Opened spammer wallet — address ${res.data?.address || 'ready'}` });
            fetchSpammer();
        } catch (e) {
            setOpenSpamResult({ success: false, msg: e.response?.data?.error || e.message });
        } finally { setOpeningSpammer(false); }
    };

    const revealSpammerSeed = async () => {
        if (spammerSeed) { setShowSpammerSeed(v => !v); return; }
        setSpammerSeedLoading(true);
        try {
            const res = await axios.get(`${API}/xmrspammer/wallet/seed`, { timeout: 60000 });
            if (res.data?.result?.key) {
                setSpammerSeed(res.data.result.key);
                setShowSpammerSeed(true);
            }
        } catch (e) {
            console.error('Failed to fetch spammer seed:', e);
        } finally { setSpammerSeedLoading(false); }
    };

    const copySpammerSeed = () => {
        if (spammerSeed) {
            try { navigator.clipboard.writeText(spammerSeed); setSpammerSeedCopied(true); setTimeout(() => setSpammerSeedCopied(false), 2000); } catch {}
        }
    };

    const fmtBal = (a) => a ? (a / 1e12).toFixed(4) : '0.0000';

    return (
        <div className="stress-layout">
            {/* Spammer Wallet Status */}
            <div className="glass-panel stress-control">
                <h3 className="panel-title"><Icons.Wallet size={14} color="var(--tor)" /> Spammer Wallet</h3>
                {spammer?.wallet_opening ? (
                    <div style={{ padding: '12px 0' }}>
                        <div className="info-bar" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="spinner" /> Opening spammer wallet...
                        </div>
                    </div>
                ) : !spammer?.wallet_open ? (
                    <div style={{ padding: '12px 0' }}>
                        {spammer?.wallet_file_exists ? (
                            <>
                                <div className="info-bar">Wallet file found on disk but not loaded. Click Open to activate it.</div>
                                <button className="btn-primary" style={{ marginTop: 10 }} onClick={handleOpenSpammer} disabled={openingSpammer}>
                                    <Icons.Wallet size={14} /> {openingSpammer ? 'Opening...' : 'Open Spammer Wallet'}
                                </button>
                                {openSpamResult && (
                                    <div className={`tx-result ${openSpamResult.success ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 8 }}>
                                        {openSpamResult.msg}
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <div className="error-bar">No spammer wallet found. Create one to start the stress test.</div>
                                <button className="btn-primary" style={{ marginTop: 10 }} onClick={handleCreateSpammer} disabled={creatingSpammer}>
                                    <Icons.Wallet size={14} /> {creatingSpammer ? 'Creating...' : 'Create Spammer Wallet'}
                                </button>
                                {spamResult && (
                                    <div className={`tx-result ${spamResult.success ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 8 }}>
                                        {spamResult.msg}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                ) : (
                    <div className="stress-form">
                        <div className="form-row">
                            <StatCard label="Balance" value={`${fmtBal(spammer.balance)} tXMR`} accent="var(--accent)" />
                            <StatCard label="Unlocked" value={`${fmtBal(spammer.unlocked_balance)} tXMR`} accent="var(--green)" />
                            <StatCard label="Accounts" value={spammer.num_accounts || 1} accent="var(--tor)" />
                            <StatCard label="Outputs" value={spammer.num_outputs || 0} accent="var(--text-2)" />
                        </div>
                        <div className="form-group" style={{ marginTop: 8 }}>
                            <label>Spammer Address</label>
                            <div className="addr-row">
                                <span className="mono-xs addr-text">{spammer.address}</span>
                                <button className="icon-btn" onClick={() => {
                                    try { navigator.clipboard.writeText(spammer.address); setAddrCopied(true); setTimeout(() => setAddrCopied(false), 2000); } catch {}
                                }} title="Copy">
                                    {addrCopied ? <><Icons.Check size={14} color="var(--green)" /> <span style={{ color: 'var(--green)', fontSize: 10 }}>Copied!</span></> : <Icons.Copy size={14} />}
                                </button>
                            </div>
                        </div>
                        <div className="form-group" style={{ marginTop: 12 }}>
                            <label>Seed Phrase (backup for testnet)</label>
                            <div className="seed-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <button className="icon-btn" onClick={copySpammerSeed} title="Copy seed" disabled={!spammerSeed || spammerSeedLoading}>
                                    {spammerSeedCopied ? <Icons.Check size={14} color="var(--green)" /> : <Icons.Copy size={14} />}
                                </button>
                                <button className="btn-ghost btn-sm" onClick={revealSpammerSeed} disabled={spammerSeedLoading}>
                                    {spammerSeedLoading ? 'Loading...' : showSpammerSeed ? 'Hide' : spammerSeed ? 'Show' : 'Reveal'}
                                </button>
                            </div>
                            {showSpammerSeed && spammerSeed ? (
                                <div className="seed-phrase" style={{ marginTop: 8 }}>{spammerSeed}</div>
                            ) : (
                                <div className="mono-xs dimmed" style={{ marginTop: 4 }}>
                                    Seed is fetched only when you click Reveal.
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Step 1: Fund */}
            {spammer?.wallet_open && (
                <div className="glass-panel stress-control">
                    <h3 className="panel-title"><Icons.Zap size={14} color="var(--green)" /> Step 1 — Fund Spammer Wallet</h3>
                    <p className="mono-xs dimmed" style={{ marginBottom: 8 }}>
                        Sends tXMR from your main wallet to the spammer wallet. Needed to create outputs for the stress test.
                    </p>
                    <div className="form-row">
                        <div className="form-group" style={{ flex: 1 }}>
                            <label>Amount (tXMR)</label>
                            <input type="number" step="0.1" className="input-dark" value={fundAmount}
                                onChange={e => setFundAmount(e.target.value)} disabled={funding} />
                        </div>
                        <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                            <button className="btn-primary" onClick={handleFund} disabled={funding}>
                                <Icons.Zap size={14} /> {funding ? 'Sending...' : 'Fund Spammer'}
                            </button>
                        </div>
                    </div>
                    {fundResult && (
                        <div className={`tx-result ${fundResult.success ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 8 }}>
                            {fundResult.msg}
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Build Output Tree */}
            {spammer?.wallet_open && (
                <div className="glass-panel stress-control">
                    <h3 className="panel-title"><Icons.BarChart size={14} color="var(--accent)" /> Step 2 — Build Output Tree</h3>
                    <p className="mono-xs dimmed" style={{ marginBottom: 8 }}>
                        Creates sub-accounts and funds them from the spammer root. Each account becomes a spendable output for the spam loop.
                    </p>
                    <div className="form-row">
                        <div className="form-group" style={{ flex: 1 }}>
                            <label>Outputs per Account</label>
                            <input type="number" className="input-dark" value={treeOutputs}
                                onChange={e => setTreeOutputs(Math.min(16, parseInt(e.target.value) || 1))} disabled={treeBuilding} min="1" max="16" />
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                            <label>Tree Levels</label>
                            <input type="number" className="input-dark" value={treeLevels}
                                onChange={e => setTreeLevels(Math.min(5, parseInt(e.target.value) || 1))} disabled={treeBuilding} min="1" max="5" />
                        </div>
                        <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                            <button className="btn-primary" onClick={handleBuildTree} disabled={treeBuilding || spammer?.spamming}>
                                <Icons.BarChart size={14} /> {treeBuilding ? 'Building...' : 'Build Tree'}
                            </button>
                        </div>
                    </div>
                    {treeResult && (
                        <div className={`tx-result ${treeResult.success ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 8 }}>
                            {treeResult.msg}
                        </div>
                    )}
                    {spammer.tree_built && (
                        <p className="mono-xs" style={{ color: 'var(--green)', marginTop: 8 }}>
                            Tree built: {spammer.tree_leaves} funded leaves across {spammer.num_accounts} accounts
                        </p>
                    )}
                </div>
            )}

            {/* Step 3: Spam Controls */}
            {spammer?.wallet_open && (
                <div className="glass-panel stress-control">
                    <h3 className="panel-title"><Icons.Zap size={14} color="var(--red)" /> Step 3 — Run Spam Loop</h3>
                    <div className="form-row">
                        <div className="form-group" style={{ flex: 1 }}>
                            <label>Interval (seconds)</label>
                            <input type="number" className="input-dark" value={spamInterval}
                                onChange={e => setSpamInterval(parseInt(e.target.value) || 5)} disabled={spammer?.spamming} min="1" />
                        </div>
                        <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                            {!spammer?.spamming ? (
                                <button className="btn-danger" onClick={handleStartSpam} disabled={spamStarting || treeBuilding}>
                                    <Icons.Zap size={14} /> {spamStarting ? 'Starting...' : 'Start Spam'}
                                </button>
                            ) : (
                                <button className="btn-primary" onClick={handleStopSpam} disabled={spamStopping}>
                                    {spamStopping ? 'Stopping...' : 'Stop Spam'}
                                </button>
                            )}
                        </div>
                    </div>
                    {spamResult && (
                        <div className={`tx-result ${spamResult.success ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 8 }}>
                            {spamResult.msg}
                        </div>
                    )}
                </div>
            )}

            {/* Live Stats */}
            {spammer && (
                <div className="stats-row">
                    <StatCard label="Spamming" value={spammer.spamming ? 'RUNNING' : 'STOPPED'}
                        accent={spammer.spamming ? 'var(--green)' : 'var(--text-2)'} />
                    <StatCard label="TX Sent" value={spammer.spam_count || 0} accent="var(--accent)" />
                    <StatCard label="Success" value={spammer.spam_success || 0} accent="var(--green)" />
                    <StatCard label="Failed" value={spammer.spam_fail || 0} accent="var(--red)" />
                    <StatCard label="Tree Built" value={spammer.tree_built ? 'YES' : 'NO'} accent={spammer.tree_built ? 'var(--green)' : 'var(--text-2)'} />
                </div>
            )}

            {/* Spammer Log */}
            {logs.length > 0 && (
                <div className="glass-panel stress-tx-log">
                    <h3 className="panel-title">Spammer Log</h3>
                    <div className="tx-list">
                        {logs.slice(0, 50).map((entry, i) => (
                            <div key={i} className="tx-row">
                                <span className={`mono-xs ${entry.level === 'error' ? 'tx-err' : entry.level === 'warning' ? 'tx-warn' : ''}`}>
                                    [{entry.level?.toUpperCase()}]
                                </span>
                                <span className="mono-xs dimmed">{entry.message}</span>
                                <span className="mono-xs dimmed">{new Date(entry.time).toLocaleTimeString()}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {spammer?.last_error && (
                <div className="error-bar">Last error: {spammer.last_error}</div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG TAB
// ═══════════════════════════════════════════════════════════════════════════════

function ConfigTab({ nodeInfo }) {
    const [config, setConfig] = useState(null);
    const [hfInfo, setHfInfo] = useState(null);
    const [logLevel, setLogLevel] = useState('0');
    const [logResult, setLogResult] = useState('');
    const [flushing, setFlushing] = useState(false);
    const [flushResult, setFlushResult] = useState('');

    useEffect(() => {
        axios.get(`${API}/config`).then(r => setConfig(r.data)).catch(() => {});
        axios.get(`${API}/node/hard_fork`).then(r => setHfInfo(r.data?.result)).catch(() => {});
        axios.get(`${API}/node/log_level`).then(r => { if (r.data?.level != null) setLogLevel(r.data.level); }).catch(() => {});
    }, []);

    const setLog = async () => {
        setLogResult('');
        try {
            const res = await axios.post(`${API}/node/set_log`, { level: logLevel });
            setLogResult('Log level set to: ' + res.data.level);
        } catch (e) {
            setLogResult('Error: ' + (e.response?.data?.error || e.message));
        }
    };

    const flushTxPool = async () => {
        setFlushing(true);
        setFlushResult('');
        try {
            const res = await axios.post(`${API}/node/flush_txpool`);
            setFlushResult('TX pool flushed (' + (res.data.tx_count || 0) + ' transactions removed)');
        } catch (e) {
            setFlushResult('Error: ' + (e.response?.data?.error || e.message));
        }
        setFlushing(false);
    };

    return (
        <div className="config-layout">
            <div className="glass-panel config-panel">
                <h3 className="panel-title"><Icons.Settings size={14} color="var(--accent)" /> Server Configuration</h3>
                <div className="config-rows">
                    {config && Object.entries({
                        'Dashboard Version': config.version,
                        'Stressnet Tag': config.stressnet_tag,
                        'Network': config.network,
                        'Monerod RPC': config.monerod_rpc,
                        'Wallet RPC': config.wallet_rpc,
                        'Dashboard Port': config.port,
                        'Tor Proxy': config.tor_proxy,
                        'Storage': config.pruned ? 'Pruned' : 'Unpruned',
                    }).map(([k, v]) => (
                        <div key={k} className="config-row">
                            <span className="config-key">{k}</span>
                            <span className="mono config-val">{String(v)}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="glass-panel config-panel">
                <h3 className="panel-title">Protocol Features</h3>
                <div className="config-rows">
                    {config?.features && Object.entries(config.features).map(([k, v]) => (
                        <div key={k} className="config-row">
                            <span className="config-key">{k.replace(/_/g, ' ').toUpperCase()}</span>
                            <span className={`feature-badge ${v ? 'on' : 'off'}`}>{v ? 'ENABLED' : 'DISABLED'}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="glass-panel config-panel">
                <h3 className="panel-title">Daemon Controls</h3>
                <div className="config-rows">
                    <div className="config-row">
                        <span className="config-key">Log Level</span>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <select value={logLevel} onChange={e => setLogLevel(e.target.value)} className="log-select">
                                <option value="0">0 — Off</option>
                                <option value="1">1 — Error</option>
                                <option value="2">2 — Warning</option>
                                <option value="3">3 — Info</option>
                                <option value="4">4 — Debug</option>
                                <option value="*">* — All</option>
                            </select>
                            <button className="btn-primary btn-sm" onClick={setLog} style={{ padding: '4px 12px', fontSize: '12px' }}>Set</button>
                        </div>
                    </div>
                    {logResult && <div className="config-row"><span className="mono-xs dimmed">{logResult}</span></div>}
                    <div className="config-row">
                        <span className="config-key">TX Pool</span>
                        <button className="btn-danger btn-sm" onClick={flushTxPool} disabled={flushing} style={{ padding: '4px 12px', fontSize: '12px' }}>
                            {flushing ? 'Flushing...' : 'Flush Pool'}
                        </button>
                    </div>
                    {flushResult && <div className="config-row"><span className="mono-xs dimmed">{flushResult}</span></div>}
                </div>
            </div>

            {hfInfo && (
                <div className="glass-panel config-panel">
                    <h3 className="panel-title">Hard Fork Info</h3>
                    <div className="config-rows">
                        <div className="config-row">
                            <span className="config-key">Version</span>
                            <span className="mono config-val">{hfInfo.version}</span>
                        </div>
                        <div className="config-row">
                            <span className="config-key">Enabled</span>
                            <span className="mono config-val">{hfInfo.enabled ? 'YES' : 'NO'}</span>
                        </div>
                        <div className="config-row">
                            <span className="config-key">Earliest Height</span>
                            <span className="mono config-val">{hfInfo.earliest_height}</span>
                        </div>
                    </div>
                </div>
            )}

            {nodeInfo && (
                <div className="glass-panel config-panel">
                    <h3 className="panel-title">Node Details</h3>
                    <div className="config-rows">
                        {Object.entries({
                            'Version': nodeInfo.version,
                            'Net Type': nodeInfo.nettype,
                            'Offline': nodeInfo.offline ? 'YES' : 'NO',
                            'Bootstrap Height': nodeInfo.height_without_bootstrap || '\u2014',
                            'Start Time': nodeInfo.start_time ? new Date(nodeInfo.start_time * 1000).toLocaleString() : '\u2014',
                            'Cumulative Difficulty': nodeInfo.cumulative_difficulty?.toLocaleString() || '\u2014',
                        }).map(([k, v]) => (
                            <div key={k} className="config-row">
                                <span className="config-key">{k}</span>
                                <span className="mono config-val">{String(v)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

import ExplorerTab from './ExplorerTab.jsx';

// ═══════════════════════════════════════════════════════════════════════════════
// MINING TAB
// ═══════════════════════════════════════════════════════════════════════════════

function MiningTab({ nodeInfo }) {
    const [minerStatus, setMinerStatus] = useState(null);
    const [mining, setMining] = useState(false);
    const [address, setAddress] = useState(() => localStorage.getItem('miningAddress') || '');
    const [threads, setThreads] = useState(() => {
        const saved = localStorage.getItem('miningThreads');
        return saved ? parseInt(saved, 10) : 2;
    });
    const [hashrate, setHashrate] = useState(null);
    const [error, setError] = useState(null);
    const [actioning, setActioning] = useState(false);
    const [blocks, setBlocks] = useState([]);
    const [blocksLoading, setBlocksLoading] = useState(false);
    const [addressDirty, setAddressDirty] = useState(false); // Track manual edits
    const [addressChanged, setAddressChanged] = useState(false); // Show update button

    const fetchStatus = useCallback(async () => {
        try {
            const res = await axios.get(`${API}/miner/status`, { timeout: 8000 });
            setMinerStatus(res.data);
            setMining(res.data?.running || false);
            if (res.data?.hashrate) setHashrate(res.data.hashrate);
            // Only update address from server if user hasn't manually edited it
            if (res.data?.address && !addressDirty) {
                setAddress(res.data.address);
                localStorage.setItem('miningAddress', res.data.address);
            }
            if (res.data?.address && addressDirty) {
                // Check if server address matches current input
                setAddressChanged(res.data.address !== address.trim());
            }
        } catch (e) {
            setMinerStatus({ running: false, error: e.message });
        }
    }, [address, addressDirty]);

    const fetchBlocks = useCallback(async () => {
        setBlocksLoading(true);
        try {
            const res = await axios.get(`${API}/miner/mined-blocks?limit=25`, { timeout: 15000 });
            setBlocks(res.data?.blocks || []);
        } catch (e) {
            console.error('Failed to fetch mined blocks:', e);
        } finally {
            setBlocksLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
        fetchBlocks();
        const iv1 = setInterval(fetchStatus, 5000);
        const iv2 = setInterval(fetchBlocks, 30000);
        return () => { clearInterval(iv1); clearInterval(iv2); };
    }, [fetchStatus, fetchBlocks]);

    // Auto-fill with wallet address if empty
    const autoFillWalletAddress = async () => {
        try {
            const res = await axios.get(`${API}/wallet/status`, { timeout: 15000 });
            const addr = res.data?.address;
            if (addr && !address.trim()) {
                setAddress(addr);
                localStorage.setItem('miningAddress', addr);
                setAddressDirty(false);
            }
        } catch (e) {
            console.log('No wallet open for auto-fill');
        }
    };
    useEffect(() => { autoFillWalletAddress(); }, []);

    const validateAddress = (addr) => {
        if (!addr || addr.trim().length < 95) return 'Address must be at least 95 characters';
        if (!addr.trim().startsWith('9') && !addr.trim().startsWith('A')) return 'Invalid Monero address format';
        return null;
    };

    const startMining = async () => {
        const validation = validateAddress(address);
        if (validation) {
            setError(validation);
            return;
        }
        setError(null);
        setActioning(true);
        try {
            const res = await axios.post(`${API}/miner/start`, { address: address.trim(), threads }, { timeout: 30000 });
            setMining(true);
            setMinerStatus(res.data);
            setAddressDirty(false);
            setAddressChanged(false);
            localStorage.setItem('miningAddress', address.trim());
            localStorage.setItem('miningThreads', String(threads));
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally {
            setActioning(false);
        }
    };

    const updateAddress = async () => {
        const validation = validateAddress(address);
        if (validation) {
            setError(validation);
            return;
        }
        setError(null);
        setActioning(true);
        try {
            const res = await axios.post(`${API}/miner/start`, { address: address.trim(), threads }, { timeout: 30000 });
            setMinerStatus(res.data);
            setAddressDirty(false);
            setAddressChanged(false);
            localStorage.setItem('miningAddress', address.trim());
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally {
            setActioning(false);
        }
    };

    const stopMining = async () => {
        setActioning(true);
        try {
            await axios.post(`${API}/miner/stop`, {}, { timeout: 15000 });
            setMining(false);
            setHashrate(null);
            setAddressChanged(false);
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally {
            setActioning(false);
        }
    };

    const reward = nodeInfo?.block_reward || nodeInfo?.expected_reward || null;
    const height = nodeInfo?.height || null;
    const diff = nodeInfo?.difficulty || null;

    const fmtTime = (ts) => {
        if (!ts) return '\u2014';
        const d = new Date(ts * 1000);
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    return (
        <div className="mining-layout">
            {error && <div className="error-bar">{error}</div>}

            <div className="glass-panel mining-control-panel">
                <h3 className="panel-title">{'\u26CF'} Miner Control</h3>
                <div className="mining-form">
                    <div className="form-group">
                        <label>Mining Address {mining && <span style={{fontSize:'0.8em',opacity:0.6}}>(editing while running will update on next block find)</span>}</label>
                        <input
                            type="text"
                            className="input-dark"
                            placeholder="Paste stressnet address..."
                            value={address}
                            onChange={e => {
                                setAddress(e.target.value);
                                setAddressDirty(true);
                                if (mining && minerStatus?.address) {
                                    setAddressChanged(e.target.value.trim() !== minerStatus.address);
                                }
                            }}
                            disabled={actioning}
                        />
                        {addressChanged && (
                            <div style={{marginTop: 8, color: 'var(--accent)', fontSize: '0.85em'}}>
                                Address changed — click Update to restart miner with new address
                            </div>
                        )}
                    </div>
                    <div className="form-row">
                        <div className="form-group" style={{ width: 120 }}>
                            <label>Threads</label>
                            <input
                                type="number"
                                min={1}
                                max={16}
                                className="input-dark"
                                value={threads}
                                onChange={e => setThreads(parseInt(e.target.value) || 1)}
                                disabled={mining || actioning}
                            />
                        </div>
                        <div className="mining-actions">
                            {!mining ? (
                                <button className="btn-primary" onClick={startMining} disabled={actioning}>
                                    {actioning ? 'Starting...' : 'Start Mining'}
                                </button>
                            ) : (
                                <>
                                    {addressChanged && (
                                        <button className="btn-primary" onClick={updateAddress} disabled={actioning} style={{marginRight: 8}}>
                                            {actioning ? 'Updating...' : 'Update Address'}
                                        </button>
                                    )}
                                    <button className="btn-danger" onClick={stopMining} disabled={actioning}>
                                        {actioning ? 'Stopping...' : 'Stop Mining'}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="mining-stats-grid">
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Status</span>
                    <span className={`mining-status ${mining ? 'on' : 'off'}`}>{mining ? 'RUNNING' : 'STOPPED'}</span>
                </div>
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Hashrate</span>
                    <span className="mining-value">{hashrate ? `${hashrate} H/s` : '\u2014'}</span>
                </div>
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Difficulty</span>
                    <span className="mining-value">{diff ? fmt.diff(diff) : '\u2014'}</span>
                </div>
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Block Reward</span>
                    <span className="mining-value">{reward ? `${fmt.xmr(reward)} tXMR` : '\u2014'}</span>
                </div>
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Height</span>
                    <span className="mining-value">{height ? height.toLocaleString() : '\u2014'}</span>
                </div>
                <div className="glass-panel mining-stat">
                    <span className="stat-label">Threads</span>
                    <span className="mining-value">{threads}</span>
                </div>
            </div>

            {minerStatus?.container && (
                <div className="glass-panel mining-info">
                    <span className="mono-xs dimmed">Container: {minerStatus.container}</span>
                    {minerStatus.image && <span className="mono-xs dimmed">Image: {minerStatus.image}</span>}
                </div>
            )}

            <div className="glass-panel mining-blocks-panel">
                <div className="blocks-table-header">
                    <h3><Icons.BarChart size={14} /> Mined Blocks</h3>
                    <button className="btn-ghost btn-sm" onClick={fetchBlocks} disabled={blocksLoading}>
                        {blocksLoading ? 'Loading...' : 'Refresh'}
                    </button>
                </div>
                <div className="blocks-table-wrapper">
                    {blocks.length === 0 ? (
                        <div className="dimmed mono-xs" style={{ padding: 20 }}>
                            {blocksLoading ? 'Loading mined blocks...' : 'No blocks mined yet — keep hashing!'}
                        </div>
                    ) : (
                        <table className="blocks-table mining-blocks-table">
                            <thead>
                                <tr>
                                    <th>Height</th>
                                    <th>Time</th>
                                    <th>Hash</th>
                                    <th>Difficulty</th>
                                    <th>Reward</th>
                                    <th>TXs</th>
                                    <th>Size</th>
                                </tr>
                            </thead>
                            <tbody>
                                {blocks.map((b) => (
                                    <tr key={b.height}>
                                        <td className="mono">{b.height.toLocaleString()}</td>
                                        <td className="mono-xs">{fmtTime(b.timestamp)}</td>
                                        <td className="mono-xs block-hash">{fmt.hash(b.hash)}</td>
                                        <td className="mono-xs">{fmt.diff(b.difficulty)}</td>
                                        <td className="mono-xs block-reward">{fmt.xmr(b.reward)}</td>
                                        <td className="mono-xs">{b.num_txes}</td>
                                        <td className="mono-xs">{fmt.bytes(b.block_size)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR BOUNDARY — catches crashes so the user sees an error, not a blank page
// ═══════════════════════════════════════════════════════════════════════════════

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="center-msg" style={{ padding: 40 }}>
          <span className="mono" style={{ color: 'var(--red)', fontSize: 14, marginBottom: 8 }}>Component Crashed</span>
          <span className="mono-xs dimmed" style={{ maxWidth: 500, wordBreak: 'break-all' }}>
            {this.state.error.message || String(this.state.error)}
          </span>
          <button className="btn-ghost btn-sm" style={{ marginTop: 12 }}
            onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
    const [tab, setTab] = useState('dashboard');
    const [nodeInfo, setNodeInfo] = useState(null);
    const [syncInfo, setSyncInfo] = useState(null);
    const [poolStats, setPoolStats] = useState(null);
    const [online, setOnline] = useState(false);
    const [explorerTxId, setExplorerTxId] = useState(null);

    const openExplorerTx = useCallback((txid) => {
        setExplorerTxId(txid);
        setTab('explorer');
    }, []);

    useEffect(() => {
        const poll = async () => {
            try {
                const [info, sync, pool] = await Promise.all([
                    axios.get(`${API}/node/info`).catch(() => null),
                    axios.get(`${API}/node/sync`).catch(() => null),
                    axios.get(`${API}/node/tx_pool`).catch(() => null),
                ]);
                if (info?.data?.result) { setNodeInfo(info.data.result); setOnline(true); }
                else setOnline(false);
                if (sync?.data?.result) setSyncInfo(sync.data.result);
                if (pool?.data) setPoolStats(pool.data);
            } catch {
                setOnline(false);
            }
        };
        poll();
        const iv = setInterval(poll, 12000);
        return () => clearInterval(iv);
    }, []);

    const tabs = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'monitor', label: 'Monitor' },
        { id: 'stress', label: 'Stress Test' },
        { id: 'logs', label: 'Logs' },
        { id: 'wallet', label: 'Wallet' },
        { id: 'explorer', label: 'Explorer' },
        { id: 'miner', label: 'Mining' },
        { id: 'config', label: 'Config' },
    ];

    return (
        <div className="app-shell">
            <div className="scanlines" />

            <header className="app-header">
                <div className="header-left">
                    <img src="/supersress-logo.png" alt="SuperStress" className="brand-icon" />
                    <div className="brand-text">
                        <h1>MONERO SUPERSTRESS</h1>
                        <span className="brand-sub">FCMP++ &middot; v0.19.0.0-beta.2.0 &middot; TOR ONLY</span>
                    </div>
                </div>
                <div className="header-right">
                    <span className={`status-dot ${online ? 'on' : 'off'}`} />
                    <span className="mono-sm">{online ? 'NODE ONLINE' : 'OFFLINE'}</span>
                </div>
            </header>

            <nav className="tab-bar">
                {tabs.map(t => (
                    <button key={t.id}
                        className={`tab-btn ${tab === t.id ? 'active' : ''}`}
                        onClick={() => setTab(t.id)}>
                        {t.label}
                    </button>
                ))}
            </nav>

            <main className="app-content">
                <ErrorBoundary key={tab}>
                {tab === 'dashboard' && <DashboardTab nodeInfo={nodeInfo} syncInfo={syncInfo} poolStats={poolStats} />}
                {tab === 'monitor' && <MonitorTab />}
                {tab === 'stress' && <StressTestTab />}
                {tab === 'logs' && <LogsTab />}
                {tab === 'wallet' && <WalletTab onExplorerTx={openExplorerTx} />}
                {tab === 'explorer' && <ExplorerTab explorerTxId={explorerTxId} onExplorerTxId={setExplorerTxId} />}
                {tab === 'miner' && <MiningTab nodeInfo={nodeInfo} />}
                {tab === 'config' && <ConfigTab nodeInfo={nodeInfo} />}
                </ErrorBoundary>
            </main>

            <footer className="app-footer">
                <span>FCMP++ Stressnet Node</span>
                <span className="dimmed">github.com/brainchainz</span>
            </footer>
        </div>
    );
}
