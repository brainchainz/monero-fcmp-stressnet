import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getBlock, getLastBlockHeader, getBlockHeadersRange } from '../rpc/monero-rpc.js';
import { identifyPoolFromCoinbase, identifyPoolFromExtra } from '../mining/pool-identifier.js';
import {
  getBlockStatsSince,
  getRecentBlockStats,
  insertBlockStat,
  pruneBlockStats,
} from '../db/sqlite.js';
import type { XmrBlockSummary } from '../types.js';

const log = createLogger('block-history');

const blockSummaryFromRow = (row: {
  height: number;
  hash: string;
  timestamp: number;
  difficulty: number;
  reward: number;
  block_weight: number;
  tx_count: number;
  pool_name: string;
  pool_type: string;
}): XmrBlockSummary => ({
  height: row.height,
  hash: row.hash,
  timestamp: row.timestamp,
  reward: row.reward,
  difficulty: row.difficulty,
  block_weight: row.block_weight,
  tx_count: row.tx_count,
  pool_name: row.pool_name,
  pool_type: row.pool_type,
  orphan: false,
});

export interface BlockHistoryEvents {
  'block-added': (summary: XmrBlockSummary) => void;
}

export declare interface BlockHistoryService {
  on<K extends keyof BlockHistoryEvents>(event: K, listener: BlockHistoryEvents[K]): this;
  emit<K extends keyof BlockHistoryEvents>(
    event: K,
    ...args: Parameters<BlockHistoryEvents[K]>
  ): boolean;
}

export class BlockHistoryService extends EventEmitter {
  private tipHeight = 0;
  private tipHash = '';

  getTip(): { height: number; hash: string } {
    return { height: this.tipHeight, hash: this.tipHash };
  }

  recent(limit: number, offset = 0): XmrBlockSummary[] {
    return getRecentBlockStats(limit, offset).map(blockSummaryFromRow);
  }

  since(timestampSeconds: number): XmrBlockSummary[] {
    return getBlockStatsSince(timestampSeconds).map(blockSummaryFromRow);
  }

  async bootstrap(): Promise<void> {
    const header = await getLastBlockHeader();
    if (!header?.block_header) {
      log.warn('bootstrap could not fetch last block header');
      return;
    }
    const tip = header.block_header;
    this.tipHeight = tip.height;
    this.tipHash = tip.hash;

    const haveRecent = getRecentBlockStats(1);
    const backfillStart = haveRecent.length
      ? Math.max(haveRecent[0].height + 1, tip.height - config.BLOCKS_HISTORY + 1)
      : Math.max(0, tip.height - config.BLOCKS_HISTORY + 1);

    if (backfillStart > tip.height) {
      log.info(`bootstrap: already at tip ${tip.height}`);
      return;
    }

    log.info(`bootstrap: backfilling blocks ${backfillStart}..${tip.height}`);
    const chunkSize = 500;
    for (let from = backfillStart; from <= tip.height; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, tip.height);
      const res = await getBlockHeadersRange(from, to);
      if (!res?.headers) continue;
      for (const h of res.headers) {
        const summary = await this.buildSummary(h.hash, h.height);
        if (summary) insertBlockStat(toRow(summary));
      }
    }
    pruneBlockStats(config.BLOCKS_HISTORY);
    log.info(`bootstrap complete, tip=${this.tipHeight}`);
  }

  async onNewBlockByHash(hash: string): Promise<XmrBlockSummary | null> {
    const summary = await this.buildSummary(hash);
    if (!summary) return null;
    insertBlockStat(toRow(summary));
    pruneBlockStats(config.BLOCKS_HISTORY);
    this.tipHeight = summary.height;
    this.tipHash = summary.hash;
    this.emit('block-added', summary);
    return summary;
  }

  async onNewBlockByHeight(height: number): Promise<XmrBlockSummary | null> {
    const summary = await this.buildSummary(undefined, height);
    if (!summary) return null;
    insertBlockStat(toRow(summary));
    pruneBlockStats(config.BLOCKS_HISTORY);
    this.tipHeight = summary.height;
    this.tipHash = summary.hash;
    this.emit('block-added', summary);
    return summary;
  }

  async syncFromRpc(): Promise<XmrBlockSummary[]> {
    const added: XmrBlockSummary[] = [];
    const header = await getLastBlockHeader();
    if (!header?.block_header) return added;
    const tip = header.block_header;
    if (tip.height <= this.tipHeight) return added;

    const chunkSize = 500;
    for (let from = this.tipHeight + 1; from <= tip.height; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, tip.height);
      const res = await getBlockHeadersRange(from, to);
      if (!res?.headers) continue;
      for (const h of res.headers) {
        const summary = await this.buildSummary(h.hash, h.height);
        if (summary) {
          insertBlockStat(toRow(summary));
          added.push(summary);
        }
      }
    }

    if (added.length) {
      const last = added[added.length - 1];
      this.tipHeight = last.height;
      this.tipHash = last.hash;
    } else {
      this.tipHeight = tip.height;
      this.tipHash = tip.hash;
    }
    pruneBlockStats(config.BLOCKS_HISTORY);
    return added;
  }

  async getBlockDetail(ref: { hash?: string; height?: number }): Promise<(XmrBlockSummary & {
    prev_hash: string;
    nonce: number;
    major_version: number;
    minor_version: number;
    miner_tx_hash: string;
    tx_hashes: string[];
    size: number;
    cumulative_difficulty: number;
  }) | null> {
    const block = await getBlock(ref);
    if (!block?.block_header) return null;
    const h = block.block_header;
    const pool = identifyPoolFromBlock(block);

    return {
      height: h.height,
      hash: h.hash,
      timestamp: h.timestamp,
      reward: h.reward,
      difficulty: h.difficulty,
      block_weight: h.block_weight ?? h.block_size ?? 0,
      tx_count: h.num_txes,
      pool_name: pool.name,
      pool_type: pool.type,
      orphan: h.orphan_status,
      prev_hash: h.prev_hash,
      nonce: h.nonce,
      major_version: h.major_version,
      minor_version: h.minor_version,
      miner_tx_hash: h.miner_tx_hash,
      tx_hashes: block.tx_hashes ?? [],
      size: h.block_size ?? h.block_weight ?? 0,
      cumulative_difficulty: h.cumulative_difficulty ?? 0,
    };
  }

  private async buildSummary(hash?: string, height?: number): Promise<XmrBlockSummary | null> {
    const block = await getBlock({ hash, height });
    if (!block?.block_header) return null;
    const h = block.block_header;
    const pool = identifyPoolFromBlock(block);

    return {
      height: h.height,
      hash: h.hash,
      timestamp: h.timestamp,
      reward: h.reward,
      difficulty: h.difficulty,
      block_weight: h.block_weight ?? h.block_size ?? 0,
      tx_count: h.num_txes,
      pool_name: pool.name,
      pool_type: pool.type,
      orphan: h.orphan_status,
    };
  }
}

const identifyPoolFromBlock = (block: { json?: string; miner_tx_hash?: string }): {
  name: string;
  type: string;
  url: string | null;
} => {
  if (block.json) {
    try {
      const parsed = JSON.parse(block.json) as { miner_tx?: unknown };
      if (parsed.miner_tx) return identifyPoolFromCoinbase(parsed.miner_tx);
    } catch { /* fall through */ }
  }
  return identifyPoolFromExtra('');
};

const toRow = (s: XmrBlockSummary) => ({
  height: s.height,
  hash: s.hash,
  timestamp: s.timestamp,
  difficulty: s.difficulty,
  reward: s.reward,
  block_weight: s.block_weight,
  tx_count: s.tx_count,
  pool_name: s.pool_name,
  pool_type: s.pool_type,
});
