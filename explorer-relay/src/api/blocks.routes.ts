import { Router } from 'express';
import type { AppState } from '../state/app-state.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const INT = /^\d+$/;

const parseRef = (raw: string): { hash?: string; height?: number } | null => {
  if (HEX64.test(raw)) return { hash: raw.toLowerCase() };
  if (INT.test(raw)) return { height: Number(raw) };
  return null;
};

export const blocksRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(app.blockHistory.recent(limit, offset));
  });

  router.get('/tip', (_req, res) => {
    res.json(app.blockHistory.getTip());
  });

  router.get('/:ref', async (req, res) => {
    const ref = parseRef(req.params.ref);
    if (!ref) return res.status(400).json({ error: 'invalid hash or height' });
    const detail = await app.blockHistory.getBlockDetail(ref);
    if (!detail) return res.status(404).json({ error: 'block not found' });
    res.json(detail);
  });

  router.get('/:ref/txs', async (req, res) => {
    const ref = parseRef(req.params.ref);
    if (!ref) return res.status(400).json({ error: 'invalid hash or height' });
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const detail = await app.blockHistory.getBlockDetail(ref);
    if (!detail) return res.status(404).json({ error: 'block not found' });
    const start = page * limit;
    const tx_hashes = detail.tx_hashes.slice(start, start + limit);
    res.json({
      block_hash: detail.hash,
      block_height: detail.height,
      page,
      limit,
      total: detail.tx_hashes.length,
      tx_hashes,
    });
  });

  return router;
};
