import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

const API = process.env.NODE_ENV === 'development' ? 'http://localhost:8080' : window.location.origin;

// ─── Icons ──────────────────────────────────────────────────────────
const Cube = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
  </svg>
);
const Droplet = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
  </svg>
);
const Pickaxe = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
    <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);
const Search = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

// ─── Formatters ─────────────────────────────────────────────────────
function shortHash(h, n = 10) { if (!h) return '\u2014'; return h.slice(0, n) + '\u2026' + h.slice(-4); }
function fmtBytes(b) { if (!b) return '\u2014'; return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB'; }
function fmtXmr(a) { return a ? (a / 1e12).toFixed(3) : '0.000'; }
function fmtDiff(d) { if (!d) return '\u2014'; d = Number(d); return d >= 1e9 ? (d / 1e9).toFixed(2) + 'G' : d >= 1e6 ? (d / 1e6).toFixed(1) + 'M' : d.toLocaleString(); }
function fmtAgo(ts) { if (!ts) return '\u2014'; const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; return Math.floor(s / 3600) + 'h ago'; }

// ─── Block Parade React Wrapper ─────────────────────────────────────
function BlockParadeView({ onBlockClick, onPendingClick }) {
  const hostRef = useRef(null);
  const bpRef = useRef(null);

  useEffect(() => {
    if (!hostRef.current || !window.BlockParade) return;
    const parade = new window.BlockParade(hostRef.current, (height) => {
      if (height === 'pending') {
        if (onPendingClick) onPendingClick();
      } else if (onBlockClick) {
        onBlockClick(height);
      }
    });
    bpRef.current = parade;
    if (typeof parade.start === 'function') parade.start();

    return () => {
      if (!bpRef.current) return;
      try {
        if (typeof bpRef.current.destroy === 'function') bpRef.current.destroy();
        else if (typeof bpRef.current.stop === 'function') bpRef.current.stop();
      } catch (_) {}
      bpRef.current = null;
    };
  }, [onBlockClick, onPendingClick]);

  return <div ref={hostRef} className="block-parade-root" />;
}

// ─── MEMPOOL Tab — React display + optional mempool visualization canvas ─────────
function MempoolView({ onTxClick }) {
  const canvasRef = useRef(null);
  const vizRef = useRef(null);
  const [txs, setTxs] = useState([]);
  const [stats, setStats] = useState(null);
  const [canvasOk, setCanvasOk] = useState(true);
  const [canvasFailed, setCanvasFailed] = useState(false);

  // Poll mempool data via relay
  useEffect(() => {
    const poll = () => {
      axios.get(`${API}/api/xmr?_p=mempool`, { timeout: 8000 })
        .then(r => {
          const d = r.data;
          const list = d.recent_txs || d.txs || [];
          setTxs(list);
          setStats({
            tx_count: d.tx_count || list.length,
            bytes_total: d.bytes_total,
            fees_total: d.fees_total,
            median_fee_rate: d.median_fee_rate,
          });
          // Feed the mempool visualization if available
          if (vizRef.current && list.length > 0) {
            try { vizRef.current.sync(list); } catch (_) {}
          } else if (vizRef.current) {
            try { vizRef.current.sync([]); } catch (_) {}
          }
        })
        .catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 10000);
    return () => clearInterval(iv);
  }, []);

  // Try mounting the mempool visualization — if it fails, fall back to table only
  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const MO = window.MempoolOceanShared;
      if (!MO || !MO.OceanViz) throw new Error('mempool visualization script not loaded');
      if (typeof window.XmrRelayWS === 'undefined') throw new Error('xmr-relay-ws.js not loaded');
      vizRef.current = new MO.OceanViz(canvasRef.current, {
        onClickTx: onTxClick || null,
      });
      vizRef.current.start();
      setCanvasOk(true);
      setCanvasFailed(false);
    } catch (e) {
      console.warn('Mempool visualization init failed, falling back to table:', e.message);
      setCanvasOk(false);
      setCanvasFailed(true);
    }
    return () => {
      if (vizRef.current) {
        try { vizRef.current.stop(); } catch (_) {}
        vizRef.current = null;
      }
    };
  }, []); // only mount once

  function fmtSize(b) { return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB'; }
  function fmtFee(f) { return f ? (f / 1e12).toFixed(6) : '0'; }
  function fmtRate(r) { return r ? r + ' pX/byte' : '\u2014'; }

  return (
    <div>
      {/* Mempool visualization canvas — always mounted so the init effect can attach to it; hidden only after init failure */}
      <div className="mempool-viz-host" style={{ minHeight: canvasOk ? 340 : 0, display: canvasOk ? 'block' : 'none' }}>
        <canvas ref={canvasRef} />
      </div>
      {canvasFailed && (
        <div className="mono-xs dimmed" style={{ marginBottom: 12 }}>
          Mempool visualization unavailable — showing transaction table only.
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="glass-panel" style={{ display: 'flex', gap: 20, padding: '10px 16px', marginTop: canvasOk ? 12 : 0, marginBottom: 12, flexWrap: 'wrap' }}>
          <StatBadge label="TXs in pool" value={stats.tx_count} />
          <StatBadge label="Total bytes" value={fmtSize(stats.bytes_total || 0)} />
          <StatBadge label="Total fees" value={fmtFee(stats.fees_total || 0) + ' tXMR'} />
          <StatBadge label="Median fee rate" value={fmtRate(stats.median_fee_rate)} />
        </div>
      )}

      {/* Mempool TX list */}
      {txs.length === 0 ? (
        <div className="center-msg"><span className="mono-sm dimmed">Mempool is empty — no pending transactions</span></div>
      ) : (
        <div className="tx-detail-card">
          <h3 className="panel-title" style={{ marginBottom: 12, fontFamily: 'var(--mono)', color: 'var(--accent)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
            Pending Transactions ({txs.length})
          </h3>
          {txs.map((tx, i) => (
            <div key={tx.txid || i} className="tx-list-item" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="wallet-tx-clickable" onClick={() => onTxClick && onTxClick(tx.txid)}>
                {shortHash(tx.txid, 18)}
              </button>
              <div style={{ display: 'flex', gap: 16, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-1)' }}>
                <span>{fmtSize(tx.blob_size || 0)}</span>
                <span style={{ color: 'var(--gold)' }}>{fmtFee(tx.fee)} tXMR</span>
                <span style={{ color: tx.fee_tier === 'priority' ? 'var(--red)' : tx.fee_tier === 'fast' ? 'var(--accent)' : 'var(--text-2)' }}>
                  {tx.fee_tier ? tx.fee_tier.toUpperCase() : fmtRate(tx.fee_rate)}
                </span>
                <span>{tx.receive_time ? new Date(tx.receive_time * 1000).toLocaleTimeString() : ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatBadge({ label, value }) {
  return (
    <div>
      <span className="mono-xs dimmed" style={{ display: 'block', marginBottom: 2 }}>{label}</span>
      <span className="mono" style={{ fontWeight: 600, color: 'var(--text-0)' }}>{value}</span>
    </div>
  );
}

// ─── Recent Blocks Table ────────────────────────────────────────────
function BlocksTable({ onBlockClick }) {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchBlocks = () => axios.get(`${API}/api/xmr/blocks?limit=100`, { timeout: 8000 })
      .then(r => {
        if (cancelled) return;
        setBlocks(Array.isArray(r.data) ? r.data : []);
        setError(null);
      })
      .catch(e => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetchBlocks();
    const iv = setInterval(fetchBlocks, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  if (loading) return <div className="blocks-table-card"><div className="center-msg"><div className="pulse-ring" /><span className="mono-sm">Loading blocks...</span></div></div>;
  if (error && !blocks.length) return <div className="blocks-table-card"><div className="mono-xs dimmed" style={{ padding: 16 }}>Unable to load blocks — relay may still be booting ({error})</div></div>;
  if (!blocks.length) return <div className="blocks-table-card"><div className="mono-xs dimmed" style={{ padding: 16 }}>No blocks yet — relay may still be booting</div></div>;

  return (
    <div className="blocks-table-card">
      <div className="blocks-table-header">
        <h3>Recent Blocks</h3>
        <span className="mono-xs dimmed">Last {Math.min(10, blocks.length)}</span>
      </div>
      <table className="blocks-table">
        <thead>
          <tr>
            <th>Height</th><th>Hash</th><th>TXs</th><th>Size</th><th>Reward</th><th>Difficulty</th><th>Pool</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map(b => (
            <tr key={b.height} onClick={() => onBlockClick(String(b.height))}>
              <td style={{ color: 'var(--accent)' }}>{Number(b.height).toLocaleString()}</td>
              <td className="block-hash">{shortHash(b.hash || b.block_hash)}</td>
              <td>{b.tx_count || b.txCount || 0}</td>
              <td>{fmtBytes(b.size || b.block_size)}</td>
              <td className="block-reward">{fmtXmr(b.reward || b.block_reward)} XMR</td>
              <td>{fmtDiff(b.difficulty)}</td>
              <td className="block-pool">{b.pool || b.pool_name || 'Unknown'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── TX Detail ──────────────────────────────────────────────────────
function TxDetail({ txid, onBack }) {
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!txid) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    axios.get(`${API}/api/xmr/tx/${txid}`)
      .then(r => setTx(r.data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [txid]);

  if (loading) return <div className="center-msg"><div className="pulse-ring" /><span className="mono-sm">Fetching TX...</span></div>;
  if (error) return <div className="error-bar">TX lookup failed: {error}</div>;
  if (!tx) return <div className="center-msg"><span className="mono-sm dimmed">TX not found</span></div>;

  const rctType = tx.rct_type || tx.rct_signatures?.type;
  const rctLabel = rctType === 6 ? 'FCMP++ Carrot' : rctType === 5 ? 'Bulletproof+' : rctType === 3 ? 'Bulletproof' : rctType ? `RCT ${rctType}` : '\u2014';
  const isFcmp = rctType === 6;

  return (
    <div className="tx-detail-card">
      {onBack && <button className="btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>{'\u2190'} Back</button>}
      <div className="detail-section">
        <div className="section-title">Transaction</div>
        <div className="kv-row"><span className="kv-label">TXID</span><span className="kv-value mono-sm" style={{ color: 'var(--accent)' }}>{tx.txid || txid}</span></div>
        <div className="kv-row"><span className="kv-label">Size</span><span className="kv-value">{fmtBytes(tx.size || tx.tx_size)}</span></div>
        <div className="kv-row"><span className="kv-label">Fee</span><span className="kv-value">{tx.fee ? fmtXmr(tx.fee) + ' tXMR' : '\u2014'}</span></div>
        <div className="kv-row"><span className="kv-label">Proof Type</span><span className="kv-value" style={isFcmp ? { color: 'var(--tor)' } : {}}>{rctLabel}</span></div>
        {isFcmp && <div className="kv-row"><span className="kv-label">Anonymity</span><span className="kv-value" style={{ color: 'var(--green)' }}>FCMP++ Full Set</span></div>}
      </div>
      {tx.block_height && (
        <div className="detail-section">
          <div className="section-title">Confirmation</div>
          <div className="kv-row"><span className="kv-label">Block</span><span className="kv-value" style={{ color: 'var(--accent)' }}>{tx.block_height.toLocaleString()}</span></div>
          <div className="kv-row"><span className="kv-label">Confirmations</span><span className="kv-value">{tx.confirmations || '\u2014'}</span></div>
        </div>
      )}
    </div>
  );
}

// ─── Block Detail ───────────────────────────────────────────────────
function BlockDetail({ height, onTxClick, onBack }) {
  const [block, setBlock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!height) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    axios.get(`${API}/api/xmr/blocks/${height}`)
      .then(r => setBlock(r.data))
      .catch(async () => {
        try {
          const res = await axios.get(`${API}/api/xmr/blocks`);
          const found = (res.data || []).find(b => String(b.height) === String(height));
          if (found) setBlock(found); else setError('Block not found');
        } catch (e2) {
          setError(e2.message);
        }
      })
      .finally(() => setLoading(false));
  }, [height]);

  if (loading) return <div className="center-msg"><div className="pulse-ring" /><span className="mono-sm">Loading block #{height}...</span></div>;
  if (error) return <div className="error-bar">Block error: {error}</div>;
  if (!block) return <div className="error-bar">Block #{height} not found</div>;

  return (
    <div className="block-detail-card">
      {onBack && <button className="btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>{'\u2190'} Back</button>}
      <div className="detail-section">
        <div className="section-title">Block #{Number(block.height).toLocaleString()}</div>
        <div className="kv-row"><span className="kv-label">Hash</span><span className="kv-value" style={{ color: 'var(--accent)', fontSize: 10 }}>{block.hash || block.block_hash}</span></div>
        <div className="kv-row"><span className="kv-label">Timestamp</span><span className="kv-value">{block.timestamp ? new Date(block.timestamp * 1000).toLocaleString() : '\u2014'}</span></div>
        <div className="kv-row"><span className="kv-label">Transactions</span><span className="kv-value">{block.tx_count || 0}</span></div>
        <div className="kv-row"><span className="kv-label">Size</span><span className="kv-value">{fmtBytes(block.size || block.block_size)}</span></div>
        <div className="kv-row"><span className="kv-label">Reward</span><span className="kv-value" style={{ color: 'var(--gold)' }}>{fmtXmr(block.reward || block.block_reward)} XMR</span></div>
        <div className="kv-row"><span className="kv-label">Difficulty</span><span className="kv-value">{fmtDiff(block.difficulty)}</span></div>
      </div>
      {block.tx_hashes && block.tx_hashes.length > 0 && (
        <div className="detail-section">
          <div className="section-title">Transactions ({block.tx_hashes.length})</div>
          {block.tx_hashes.slice(0, 25).map((txid, i) => (
            <div key={i} className="tx-list-item">
              <button onClick={() => onTxClick && onTxClick(txid)}>{shortHash(txid, 16)}</button>
            </div>
          ))}
          {block.tx_hashes.length > 25 && <div className="dimmed mono-xs">+{block.tx_hashes.length - 25} more</div>}
        </div>
      )}
    </div>
  );
}

// ─── Broadcast Form (inline) ────────────────────────────────────────
function BroadcastInline() {
  const [hex, setHex] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const handleBroadcast = async () => {
    if (!hex.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await axios.post(`${API}/api/xmr/broadcast`, { tx_as_hex: hex.trim() });
      setResult({ ok: true, msg: res.data?.status || 'TX broadcast' });
      setHex('');
    } catch (e) {
      setResult({ ok: false, msg: e.response?.data?.error || e.message });
    } finally { setSending(false); }
  };

  return (
    <div className="explorer-broadcast-area">
      <div className="broadcast-form">
        <p className="mono-xs dimmed" style={{ marginBottom: 10 }}>Paste a raw TX hex to broadcast to the stressnet.</p>
        <textarea placeholder="Paste hex-encoded transaction here..." value={hex} onChange={e => setHex(e.target.value)} />
        <button onClick={handleBroadcast} disabled={sending || !hex.trim()}>
          {'\uD83D\uDCE1'} {sending ? 'Broadcasting...' : 'BROADCAST TX'}
        </button>
        {result && (
          <div className={`tx-result ${result.ok ? 'tx-ok' : 'tx-fail'}`} style={{ marginTop: 12 }}>
            {result.ok ? <>{'\u2705'} {result.msg}</> : <>{'\u274C'} {result.msg}</>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mining Tab ─────────────────────────────────────────────────────
function MiningTab() {
  const [network, setNetwork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/xmr/network`)
      .then(r => { setNetwork(r.data); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center-msg"><div className="pulse-ring" /><span className="mono-sm">Loading network stats...</span></div>;
  if (error) return <div className="center-msg"><span className="mono-sm dimmed">Network data unavailable: relay may still be booting</span></div>;

  return (
    <div className="config-layout">
      <div className="glass-panel config-panel">
        <h3 className="panel-title"><Pickaxe size={14} /> Network Stats</h3>
        <div className="config-rows">
          <div className="config-row"><span className="config-key">Height</span><span className="mono config-val">{network?.height?.toLocaleString() || '\u2014'}</span></div>
          <div className="config-row"><span className="config-key">Difficulty</span><span className="mono config-val">{fmtDiff(network?.difficulty)}</span></div>
          <div className="config-row"><span className="config-key">Peers</span><span className="mono config-val">{network?.peers || '0'}</span></div>
          <div className="config-row"><span className="config-key">Block Target</span><span className="mono config-val">2:00 min</span></div>
          <div className="config-row"><span className="config-key">Protocol</span><span className="mono config-val">v16</span></div>
        </div>
      </div>
    </div>
  );
}

// ─── Explorer Tab ───────────────────────────────────────────────────
export default function ExplorerTab({ explorerTxId, onExplorerTxId }) {
  const [mode, setMode] = useState('explorer'); // explorer | mempool | mining
  const [searchVal, setSearchVal] = useState('');
  const [viewId, setViewId] = useState(null);
  const [viewType, setViewType] = useState(null);

  // Auto-search TXID from wallet
  useEffect(() => {
    if (explorerTxId) {
      setSearchVal(explorerTxId);
      setViewId(explorerTxId);
      setViewType('tx');
      setMode('explorer');
      onExplorerTxId(null);
    }
  }, [explorerTxId, onExplorerTxId]);

  const handleSearch = () => {
    const v = searchVal.trim();
    if (!v) return;
    setMode('explorer');
    if (/^\d+$/.test(v)) { setViewId(v); setViewType('block'); }
    else { setViewId(v); setViewType('tx'); }
  };

  const handleSearchKey = (e) => { if (e.key === 'Enter') handleSearch(); };
  const handleBlockClick = (height) => { setSearchVal(height); setViewId(height); setViewType('block'); };
  const handleTxClick = (txid) => { setSearchVal(txid); setViewId(txid); setViewType('tx'); };
  const handlePendingClick = () => { setMode('mempool'); };
  const handleBack = () => { setViewId(null); setViewType(null); };

  const modes = [
    { id: 'explorer', label: 'EXPLORER', icon: <Cube size={14} /> },
    { id: 'mempool', label: 'MEMPOOL', icon: <Droplet size={14} /> },
    { id: 'mining', label: 'MINING', icon: <Pickaxe size={14} /> },
  ];

  return (
    <div className="explorer-layout">
      {/* Mode tabs */}
      <div className="explorer-subtabs">
        {modes.map(m => (
          <button key={m.id} className={`explorer-subtab ${mode === m.id ? 'active' : ''}`}
            onClick={() => setMode(m.id)}>
            {m.icon} <span style={{ marginLeft: 6 }}>{m.label}</span>
          </button>
        ))}
      </div>

      {mode === 'mempool' && <MempoolView onTxClick={handleTxClick} />}

      {mode === 'mining' && <MiningTab />}

      {mode === 'explorer' && (
        <>
          <div className="explorer-search">
            <input type="text"
              placeholder="Block height, block hash (64 hex), or txid (64 hex)..."
              value={searchVal} onChange={e => setSearchVal(e.target.value)}
              onKeyDown={handleSearchKey} />
            <button onClick={handleSearch}><Search size={14} /> SEARCH</button>
          </div>
          <p className="mono-xs dimmed" style={{ marginTop: -8, marginBottom: 12 }}>
            Number &rarr; block height &middot; 64-char hex &rarr; block hash or txid
          </p>

          <BlockParadeView onBlockClick={handleBlockClick} onPendingClick={handlePendingClick} />

          {viewType === 'block' && viewId && (
            <BlockDetail height={viewId} onTxClick={handleTxClick} onBack={handleBack} />
          )}
          {viewType === 'tx' && viewId && (
            <TxDetail txid={viewId} onBack={handleBack} />
          )}

          {!viewId && <BlocksTable onBlockClick={handleBlockClick} />}
          {!viewId && <BroadcastInline />}
        </>
      )}
    </div>
  );
}
