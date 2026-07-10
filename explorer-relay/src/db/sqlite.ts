import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('sqlite');

export interface BlockStatsRow {
  height: number;
  hash: string;
  timestamp: number;
  difficulty: number;
  reward: number;
  block_weight: number;
  tx_count: number;
  pool_name: string;
  pool_type: string;
}

export interface MempoolSnapshotRow {
  timestamp: number;
  tx_count: number;
  bytes_total: number;
  fee_total: number;
  median_fee_rate: number;
  p98_fee_rate: number;
}

export interface FeeSnapshotRow {
  timestamp: number;
  fee_slow: number;
  fee_normal: number;
  fee_fast: number;
  fee_fastest: number;
}

let db: Database.Database | null = null;

export const initDb = (): Database.Database => {
  if (db) return db;
  try {
    mkdirSync(dirname(config.DB_PATH), { recursive: true });
  } catch { /* directory may already exist */ }

  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS block_stats (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      difficulty INTEGER NOT NULL,
      reward INTEGER NOT NULL,
      block_weight INTEGER NOT NULL,
      tx_count INTEGER NOT NULL,
      pool_name TEXT NOT NULL,
      pool_type TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_block_stats_timestamp ON block_stats(timestamp);
    CREATE INDEX IF NOT EXISTS idx_block_stats_pool ON block_stats(pool_name);

    CREATE TABLE IF NOT EXISTS mempool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      tx_count INTEGER NOT NULL,
      bytes_total INTEGER NOT NULL,
      fee_total INTEGER NOT NULL,
      median_fee_rate REAL NOT NULL,
      p98_fee_rate REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mempool_snapshots_timestamp ON mempool_snapshots(timestamp);

    CREATE TABLE IF NOT EXISTS fee_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      fee_slow INTEGER NOT NULL,
      fee_normal INTEGER NOT NULL,
      fee_fast INTEGER NOT NULL,
      fee_fastest INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fee_snapshots_timestamp ON fee_snapshots(timestamp);
  `);

  log.info(`initialized at ${config.DB_PATH}`);
  return db;
};

const getDb = (): Database.Database => {
  if (!db) throw new Error('sqlite not initialized');
  return db;
};

export const insertBlockStat = (row: BlockStatsRow): void => {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO block_stats
    (height, hash, timestamp, difficulty, reward, block_weight, tx_count, pool_name, pool_type)
    VALUES (@height, @hash, @timestamp, @difficulty, @reward, @block_weight, @tx_count, @pool_name, @pool_type)
  `);
  stmt.run(row);
};

export const pruneBlockStats = (keepLast: number): void => {
  const row = getDb().prepare('SELECT MAX(height) AS max_h FROM block_stats').get() as { max_h: number | null };
  if (!row?.max_h) return;
  const cutoff = row.max_h - keepLast;
  if (cutoff <= 0) return;
  getDb().prepare('DELETE FROM block_stats WHERE height < ?').run(cutoff);
};

export const getRecentBlockStats = (limit: number, offset = 0): BlockStatsRow[] =>
  getDb().prepare('SELECT * FROM block_stats ORDER BY height DESC LIMIT ? OFFSET ?').all(limit, offset) as BlockStatsRow[];

export const getBlockStatsRange = (fromHeight: number, toHeight: number): BlockStatsRow[] =>
  getDb()
    .prepare('SELECT * FROM block_stats WHERE height >= ? AND height <= ? ORDER BY height ASC')
    .all(fromHeight, toHeight) as BlockStatsRow[];

export const getBlockStatsSince = (sinceTimestamp: number): BlockStatsRow[] =>
  getDb()
    .prepare('SELECT * FROM block_stats WHERE timestamp >= ? ORDER BY height ASC')
    .all(sinceTimestamp) as BlockStatsRow[];

export const insertMempoolSnapshot = (row: MempoolSnapshotRow): void => {
  getDb().prepare(`
    INSERT INTO mempool_snapshots
    (timestamp, tx_count, bytes_total, fee_total, median_fee_rate, p98_fee_rate)
    VALUES (@timestamp, @tx_count, @bytes_total, @fee_total, @median_fee_rate, @p98_fee_rate)
  `).run(row);
};

export const getMempoolSnapshotsSince = (sinceTimestamp: number): MempoolSnapshotRow[] =>
  getDb()
    .prepare('SELECT timestamp, tx_count, bytes_total, fee_total, median_fee_rate, p98_fee_rate FROM mempool_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC')
    .all(sinceTimestamp) as MempoolSnapshotRow[];

export const pruneMempoolSnapshots = (olderThan: number): void => {
  getDb().prepare('DELETE FROM mempool_snapshots WHERE timestamp < ?').run(olderThan);
};

export const insertFeeSnapshot = (row: FeeSnapshotRow): void => {
  getDb().prepare(`
    INSERT INTO fee_snapshots
    (timestamp, fee_slow, fee_normal, fee_fast, fee_fastest)
    VALUES (@timestamp, @fee_slow, @fee_normal, @fee_fast, @fee_fastest)
  `).run(row);
};

export const getFeeSnapshotsSince = (sinceTimestamp: number): FeeSnapshotRow[] =>
  getDb()
    .prepare('SELECT timestamp, fee_slow, fee_normal, fee_fast, fee_fastest FROM fee_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC')
    .all(sinceTimestamp) as FeeSnapshotRow[];

export const pruneFeeSnapshots = (olderThan: number): void => {
  getDb().prepare('DELETE FROM fee_snapshots WHERE timestamp < ?').run(olderThan);
};

export const closeDb = (): void => {
  if (db) { db.close(); db = null; }
};
