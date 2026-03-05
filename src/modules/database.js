import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DB_DIR, 'database.sqlite');

// Minimum quantity to keep in database (0.01 shares = 10,000 base units)
// Dust positions below this threshold will be filtered out
const MIN_QUANTITY_BASE = 10_000n;

let db = null;

// Initialize database and create tables
export function initDatabase() {
  // Ensure data directory exists
  try {
    mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    // Directory may already exist
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  createTables();
  
  return db;
}

function createTables() {
  // Markets cache (for conditionId lookup)
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      token_id_yes TEXT NOT NULL,
      token_id_no TEXT NOT NULL,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_markets_condition ON markets(condition_id);
  `);

  // Positions
  // NOTE: If existing DB has TEXT columns from prior schema, delete data/database.sqlite and restart
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity_base INTEGER NOT NULL,
      avg_price_micro INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(market_id, token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);
    CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);
  `);

  // Orders (cache for quick access)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      order_side TEXT NOT NULL,
      type TEXT NOT NULL,
      price_micro INTEGER,
      original_size_base INTEGER NOT NULL,
      remaining_size_base INTEGER NOT NULL,
      filled_size_base INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `);

  // Strategies
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      token_id_yes TEXT NOT NULL,
      token_id_no TEXT NOT NULL,
      stop_loss_percent INTEGER NOT NULL,
      take_profit_percent INTEGER NOT NULL,
      entry_price_yes_micro INTEGER NOT NULL,
      entry_price_no_micro INTEGER NOT NULL,
      quantity_base INTEGER NOT NULL,
      order_id_stop TEXT,
      order_id_take TEXT,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);
    CREATE INDEX IF NOT EXISTS idx_strategies_market ON strategies(market_id);
  `);

  // Price alerts (prevent spam)
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_alerts (
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      last_price_micro INTEGER NOT NULL,
      last_alert_time DATETIME NOT NULL,
      PRIMARY KEY (market_id, token_id)
    );
  `);

  // Market translations (optional, for caching)
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_translations (
      market_id TEXT NOT NULL,
      language TEXT NOT NULL,
      original_name TEXT NOT NULL,
      translated_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (market_id, language)
    );
    CREATE INDEX IF NOT EXISTS idx_translations_market ON market_translations(market_id);
  `);
}

// Markets cache
export async function cacheMarket(marketId, conditionId, tokenIdYes, tokenIdNo) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO markets (id, condition_id, token_id_yes, token_id_no, cached_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  return stmt.run(marketId, conditionId, tokenIdYes, tokenIdNo);
}

export async function getMarketCache(marketId) {
  const stmt = db.prepare('SELECT * FROM markets WHERE id = ?');
  return stmt.get(marketId);
}

export async function getMarketCacheByConditionId(conditionId) {
  const normalized = String(conditionId || '').trim();
  if (!normalized) return null;
  const stmt = db.prepare('SELECT * FROM markets WHERE condition_id = ? LIMIT 1');
  return stmt.get(normalized) || null;
}

export async function getMarketCacheByTokenId(tokenId) {
  const normalized = String(tokenId || '').trim();
  if (!normalized) return null;
  const stmt = db.prepare(`
    SELECT * FROM markets
    WHERE token_id_yes = ? OR token_id_no = ?
    LIMIT 1
  `);
  return stmt.get(normalized, normalized) || null;
}

export async function getCachedMarkets(limit = 250) {
  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(2000, Math.trunc(Number(limit))))
    : 250;
  const stmt = db.prepare(`
    SELECT id, condition_id, token_id_yes, token_id_no, cached_at
    FROM markets
    ORDER BY datetime(cached_at) DESC
    LIMIT ?
  `);
  return stmt.all(safeLimit);
}

// Helper to normalize integer input to BigInt
// Accepts: bigint, safe integer number, integer string (e.g. "123456")
function toBigInt(value, name) {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${name} must be a bigint, safe integer, or integer string`);
}

// Positions
// All values must be INTEGER fixed-point (already multiplied by 1e6)
// quantityBase: shares * 1e6 (6 decimals) - accepts bigint or safe integer
// avgPriceMicro: price * 1e6 (micro units) - accepts bigint or safe integer
export async function savePosition(marketId, tokenId, side, quantityBase, avgPriceMicro) {
  // Normalize inputs to BigInt
  const deltaQty = toBigInt(quantityBase, 'quantityBase');
  const deltaAvg = toBigInt(avgPriceMicro, 'avgPriceMicro');

  // Check if position exists to compute weighted average
  const existing = db.prepare('SELECT quantity_base, avg_price_micro FROM positions WHERE market_id = ? AND token_id = ?').get(marketId, tokenId);
  
  let newQtyBase, newAvgMicro;
  
  if (existing) {
    // Compute weighted average using BigInt to avoid floating point
    const oldQty = BigInt(existing.quantity_base);
    const oldAvg = BigInt(existing.avg_price_micro);
    
    const resultQty = oldQty + deltaQty;
    // Weighted average: (oldQty*oldAvg + deltaQty*deltaAvg) / (oldQty + deltaQty)
    const resultAvg = (oldQty * oldAvg + deltaQty * deltaAvg) / resultQty;
    
    newQtyBase = resultQty;
    newAvgMicro = resultAvg;
  } else {
    newQtyBase = deltaQty;
    newAvgMicro = deltaAvg;
  }

  // Delete if dust position (below minimum threshold)
  if (newQtyBase < MIN_QUANTITY_BASE) {
    const deleteStmt = db.prepare('DELETE FROM positions WHERE market_id = ? AND token_id = ?');
    return deleteStmt.run(marketId, tokenId);
  }

  const stmt = db.prepare(`
    INSERT INTO positions (market_id, token_id, side, quantity_base, avg_price_micro)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(market_id, token_id) DO UPDATE SET
      quantity_base = excluded.quantity_base,
      avg_price_micro = excluded.avg_price_micro,
      updated_at = datetime('now')
  `);
  // Bind as BigInt to preserve full precision in SQLite INTEGER
  return stmt.run(marketId, tokenId, side, newQtyBase, newAvgMicro);
}

export async function updatePosition(marketId, tokenId, quantityBase, avgPriceMicro) {
  // Normalize inputs to BigInt
  const qty = toBigInt(quantityBase, 'quantityBase');
  const avg = toBigInt(avgPriceMicro, 'avgPriceMicro');

  // Delete if dust position
  if (qty < MIN_QUANTITY_BASE) {
    const deleteStmt = db.prepare('DELETE FROM positions WHERE market_id = ? AND token_id = ?');
    return deleteStmt.run(marketId, tokenId);
  }

  const stmt = db.prepare(`
    UPDATE positions
    SET quantity_base = ?, avg_price_micro = ?, updated_at = datetime('now')
    WHERE market_id = ? AND token_id = ?
  `);
  // Bind as BigInt to preserve full precision
  return stmt.run(qty, avg, marketId, tokenId);
}

// Upsert position snapshot row (source of truth from API/workers).
// Unlike savePosition(), this sets absolute values and does not compute weighted average.
export async function upsertPositionSnapshot(marketId, tokenId, side, quantityBase, avgPriceMicro) {
  const qty = toBigInt(quantityBase, 'quantityBase');
  const avg = toBigInt(avgPriceMicro, 'avgPriceMicro');

  // Delete if fully closed OR below dust threshold
  if (qty <= 0n || qty < MIN_QUANTITY_BASE) {
    const stmtDelete = db.prepare('DELETE FROM positions WHERE market_id = ? AND token_id = ?');
    return stmtDelete.run(marketId, tokenId);
  }

  const stmt = db.prepare(`
    INSERT INTO positions (market_id, token_id, side, quantity_base, avg_price_micro)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(market_id, token_id) DO UPDATE SET
      side = excluded.side,
      quantity_base = excluded.quantity_base,
      avg_price_micro = excluded.avg_price_micro,
      updated_at = datetime('now')
  `);
  return stmt.run(marketId, tokenId, side, qty, avg);
}

// Replace positions table with a fresh snapshot from API.
// Input row shape: { marketId, tokenId, side, quantityBase, avgPriceMicro }
export async function replacePositionsSnapshot(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];

  const tx = db.transaction((snapshotRows) => {
    db.prepare('DELETE FROM positions').run();

    const insertStmt = db.prepare(`
      INSERT INTO positions (market_id, token_id, side, quantity_base, avg_price_micro)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const row of snapshotRows) {
      const marketId = String(row.marketId ?? 'unknown-market');
      const tokenId = String(row.tokenId ?? '');
      if (!tokenId) continue;

      const side = String(row.side ?? 'unknown');
      const qty = toBigInt(row.quantityBase, 'quantityBase');
      // Skip dust positions: qty <= 0 or below minimum threshold
      if (qty <= 0n || qty < MIN_QUANTITY_BASE) continue;

      const avg = toBigInt(row.avgPriceMicro ?? 0, 'avgPriceMicro');
      insertStmt.run(marketId, tokenId, side, qty, avg);
    }
  });

  return tx(normalizedRows);
}

// Reduce position quantity WITHOUT changing average price (for SELL operations)
// quantityToReduce: amount to subtract from position (in base units)
// Returns new quantity or null if position should be deleted
export async function reducePosition(marketId, tokenId, quantityToReduce) {
  const reduceQty = toBigInt(quantityToReduce, 'quantityToReduce');
  
  // Get current position
  const existing = db.prepare('SELECT quantity_base, avg_price_micro FROM positions WHERE market_id = ? AND token_id = ?').get(marketId, tokenId);
  
  if (!existing) {
    throw new Error('Position not found');
  }
  
  const currentQty = BigInt(existing.quantity_base);
  const avgPrice = BigInt(existing.avg_price_micro);
  
  // Calculate new quantity
  const newQty = currentQty - reduceQty;
  
  // Delete if fully closed OR below dust threshold
  if (newQty <= 0n || newQty < MIN_QUANTITY_BASE) {
    const stmt = db.prepare('DELETE FROM positions WHERE market_id = ? AND token_id = ?');
    stmt.run(marketId, tokenId);
    return null;
  }
  
  // Update with new quantity, keep same avg price
  const stmt = db.prepare(`
    UPDATE positions
    SET quantity_base = ?, updated_at = datetime('now')
    WHERE market_id = ? AND token_id = ?
  `);
  stmt.run(newQty, marketId, tokenId);
  return newQty;
}

export async function getPositions() {
  const stmt = db.prepare('SELECT * FROM positions ORDER BY updated_at DESC');
  const rows = stmt.all();
  // Return quantity_base and avg_price_micro as strings to preserve precision
  return rows.map(row => ({
    ...row,
    quantity_base: row.quantity_base != null ? String(row.quantity_base) : null,
    avg_price_micro: row.avg_price_micro != null ? String(row.avg_price_micro) : null
  }));
}

export async function deletePosition(marketId, tokenId) {
  const stmt = db.prepare('DELETE FROM positions WHERE market_id = ? AND token_id = ?');
  return stmt.run(marketId, tokenId);
}

// Orders
// priceMicro: price * 1e6 or null (INTEGER) - accepts bigint, safe integer, or null
// quantityBase: shares * 1e6 (INTEGER) - accepts bigint or safe integer
export async function saveOrder(orderId, marketId, tokenId, side, orderSide, type, priceMicro, quantityBase, status = 'open') {
  // Normalize inputs to BigInt where applicable
  if (priceMicro !== null) {
    if (!Number.isSafeInteger(priceMicro) && typeof priceMicro !== 'bigint') {
      throw new Error('priceMicro must be a safe integer, bigint, or null');
    }
  }
  const qtyBase = toBigInt(quantityBase, 'quantityBase');
  const normalizedStatus = String(status ?? 'open').trim().toLowerCase() || 'open';
  const normalizedOrderId = String(orderId ?? '').trim();
  if (!normalizedOrderId || normalizedOrderId.toLowerCase() === 'null' || normalizedOrderId.toLowerCase() === 'undefined') {
    throw new Error('saveOrder requires a real non-empty orderId');
  }

  const remainingSizeBase = normalizedStatus === 'filled' ? 0n : qtyBase;
  const filledSizeBase = normalizedStatus === 'filled' ? qtyBase : 0n;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO orders
    (id, market_id, token_id, side, order_side, type, price_micro, original_size_base, remaining_size_base, filled_size_base, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Bind quantity fields as BigInt to preserve precision
  return stmt.run(
    normalizedOrderId,
    marketId,
    tokenId,
    side,
    orderSide,
    type,
    priceMicro,
    qtyBase,
    remainingSizeBase,
    filledSizeBase,
    normalizedStatus
  );
}

export async function getOrders() {
  const stmt = db.prepare('SELECT * FROM orders ORDER BY created_at DESC');
  const rows = stmt.all();
  // Return size fields as strings to preserve precision
  return rows.map(row => ({
    ...row,
    original_size_base: row.original_size_base != null ? String(row.original_size_base) : null,
    remaining_size_base: row.remaining_size_base != null ? String(row.remaining_size_base) : null,
    filled_size_base: row.filled_size_base != null ? String(row.filled_size_base) : null
  }));
}

export async function getOrderById(orderId) {
  const stmt = db.prepare('SELECT * FROM orders WHERE id = ?');
  const row = stmt.get(orderId);
  if (!row) return row;
  return {
    ...row,
    original_size_base: row.original_size_base != null ? String(row.original_size_base) : null,
    remaining_size_base: row.remaining_size_base != null ? String(row.remaining_size_base) : null,
    filled_size_base: row.filled_size_base != null ? String(row.filled_size_base) : null
  };
}

export async function getTrackedOrders() {
  const stmt = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('open', 'partially_filled')
      AND lower(type) = 'gtc'
      AND lower(order_side) != 'market'
      AND id IS NOT NULL
      AND trim(id) != ''
      AND lower(trim(id)) NOT IN ('null', 'undefined')
    ORDER BY updated_at DESC
  `);
  const rows = stmt.all();
  return rows.map(row => ({
    ...row,
    original_size_base: row.original_size_base != null ? String(row.original_size_base) : null,
    remaining_size_base: row.remaining_size_base != null ? String(row.remaining_size_base) : null,
    filled_size_base: row.filled_size_base != null ? String(row.filled_size_base) : null
  }));
}

// Remove invalid tracked order records that cannot be reconciled with CLOB API.
export async function cleanupInvalidTrackedOrders() {
  const stmt = db.prepare(`
    DELETE FROM orders
    WHERE status IN ('open', 'partially_filled')
      AND (
        id IS NULL
        OR trim(id) = ''
        OR lower(trim(id)) IN ('null', 'undefined')
      )
  `);
  return stmt.run();
}

// Remove non-manageable orders from local cache:
// market/FOK entries should not live in `orders` table.
export async function cleanupUnmanagedOrders() {
  const stmt = db.prepare(`
    DELETE FROM orders
    WHERE lower(type) != 'gtc'
       OR lower(order_side) = 'market'
  `);
  return stmt.run();
}

// Upsert order status from live API data.
// orderPayload:
// {
//   id, marketId, tokenId, side, orderSide, type, priceMicro,
//   originalSizeBase, remainingSizeBase, filledSizeBase, status
// }
export async function upsertOrderStatus(orderPayload) {
  const id = String(orderPayload?.id ?? '').trim();
  if (!id) {
    throw new Error('upsertOrderStatus: id is required');
  }

  const marketId = String(orderPayload?.marketId ?? 'unknown-market');
  const tokenId = String(orderPayload?.tokenId ?? 'unknown-token');
  const side = String(orderPayload?.side ?? 'unknown');
  const orderSide = String(orderPayload?.orderSide ?? 'unknown');
  const type = String(orderPayload?.type ?? 'unknown');
  const priceMicro = orderPayload?.priceMicro === null || orderPayload?.priceMicro === undefined
    ? null
    : toBigInt(orderPayload.priceMicro, 'priceMicro');
  const originalSizeBase = toBigInt(orderPayload?.originalSizeBase ?? 0, 'originalSizeBase');
  const remainingSizeBase = toBigInt(orderPayload?.remainingSizeBase ?? 0, 'remainingSizeBase');
  const filledSizeBase = toBigInt(orderPayload?.filledSizeBase ?? 0, 'filledSizeBase');
  const status = String(orderPayload?.status ?? 'unknown');

  const stmt = db.prepare(`
    INSERT INTO orders (
      id, market_id, token_id, side, order_side, type,
      price_micro, original_size_base, remaining_size_base, filled_size_base, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      market_id = excluded.market_id,
      token_id = excluded.token_id,
      side = excluded.side,
      order_side = excluded.order_side,
      type = excluded.type,
      price_micro = excluded.price_micro,
      original_size_base = excluded.original_size_base,
      remaining_size_base = excluded.remaining_size_base,
      filled_size_base = excluded.filled_size_base,
      status = excluded.status,
      updated_at = datetime('now')
  `);

  return stmt.run(
    id,
    marketId,
    tokenId,
    side,
    orderSide,
    type,
    priceMicro,
    originalSizeBase,
    remainingSizeBase,
    filledSizeBase,
    status
  );
}

export async function updateOrderStatus(orderId, status, updates = {}) {
  const allowed = ['remaining_size_base', 'filled_size_base', 'original_size_base', 'price_micro'];
  const setParts = ['status = ?', "updated_at = datetime('now')"];
  const values = [status];

  for (const field of allowed) {
    if (!(field in updates)) continue;
    const rawValue = updates[field];
    if (rawValue === null || rawValue === undefined) {
      setParts.push(`${field} = NULL`);
    } else {
      const normalized = toBigInt(rawValue, field);
      setParts.push(`${field} = ?`);
      values.push(normalized);
    }
  }

  values.push(orderId);
  const stmt = db.prepare(`
    UPDATE orders
    SET ${setParts.join(', ')}
    WHERE id = ?
  `);
  return stmt.run(...values);
}

export async function deleteOrder(orderId) {
  const stmt = db.prepare('DELETE FROM orders WHERE id = ?');
  return stmt.run(orderId);
}

// Strategies
// stopLossPercent * 100 (e.g., -10% → -1000)
// takeProfitPercent * 100 (e.g., 30% → 3000)
// entryPriceYesMicro: price * 1e6 (INTEGER) - accepts bigint or safe integer
// entryPriceNoMicro: price * 1e6 (INTEGER) - accepts bigint or safe integer
// quantityBase: shares * 1e6 (INTEGER) - accepts bigint or safe integer
export async function saveStrategy(strategyData) {
  const {
    marketId, conditionId, tokenIdYes, tokenIdNo,
    stopLossPercent, takeProfitPercent,
    entryPriceYesMicro, entryPriceNoMicro, quantityBase
  } = strategyData;

  // Normalize to BigInt
  const priceYes = toBigInt(entryPriceYesMicro, 'entryPriceYesMicro');
  const priceNo = toBigInt(entryPriceNoMicro, 'entryPriceNoMicro');
  const qty = toBigInt(quantityBase, 'quantityBase');

  const stmt = db.prepare(`
    INSERT INTO strategies
    (market_id, condition_id, token_id_yes, token_id_no, stop_loss_percent, take_profit_percent,
     entry_price_yes_micro, entry_price_no_micro, quantity_base, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  
  // Bind price/quantity fields as BigInt to preserve precision
  return stmt.run(
    marketId, conditionId, tokenIdYes, tokenIdNo,
    stopLossPercent * 100, takeProfitPercent * 100,
    priceYes, priceNo, qty
  );
}

export async function updateStrategy(strategyId, updates) {
  const allowedFields = ['order_id_stop', 'order_id_take', 'status'];
  const fields = Object.keys(updates).filter(f => allowedFields.includes(f));
  
  if (fields.length === 0) return;

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  values.push(strategyId);

  const stmt = db.prepare(`
    UPDATE strategies 
    SET ${setClause}, updated_at = datetime('now')
    WHERE id = ?
  `);
  return stmt.run(...values);
}

export async function getActiveStrategies() {
  const stmt = db.prepare("SELECT * FROM strategies WHERE status IN ('active', 'partial_close') ORDER BY created_at DESC");
  const rows = stmt.all();
  // Return price/quantity fields as strings to preserve precision
  return rows.map(row => ({
    ...row,
    entry_price_yes_micro: row.entry_price_yes_micro != null ? String(row.entry_price_yes_micro) : null,
    entry_price_no_micro: row.entry_price_no_micro != null ? String(row.entry_price_no_micro) : null,
    quantity_base: row.quantity_base != null ? String(row.quantity_base) : null
  }));
}

export async function closeStrategy(strategyId) {
  const stmt = db.prepare("UPDATE strategies SET status = 'closed', updated_at = datetime('now') WHERE id = ?");
  return stmt.run(strategyId);
}

// Price alerts
// lastPriceMicro: price * 1e6 (INTEGER) - accepts bigint or safe integer
export async function updatePriceAlert(marketId, tokenId, lastPriceMicro, lastAlertTime) {
  // Normalize to BigInt
  const price = toBigInt(lastPriceMicro, 'lastPriceMicro');

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO price_alerts (market_id, token_id, last_price_micro, last_alert_time)
    VALUES (?, ?, ?, ?)
  `);
  // Bind as BigInt to preserve precision
  return stmt.run(marketId, tokenId, price, lastAlertTime.toISOString());
}

export async function getPriceAlert(marketId, tokenId) {
  const stmt = db.prepare('SELECT * FROM price_alerts WHERE market_id = ? AND token_id = ?');
  const row = stmt.get(marketId, tokenId);
  if (!row) return row;
  // Return last_price_micro as string to preserve precision
  return {
    ...row,
    last_price_micro: row.last_price_micro != null ? String(row.last_price_micro) : null
  };
}

// Market translations (optional)
export async function saveTranslation(marketId, language, originalName, translatedName) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO market_translations (market_id, language, original_name, translated_name)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(marketId, language, originalName, translatedName);
}

export async function getTranslation(marketId, language) {
  const stmt = db.prepare('SELECT * FROM market_translations WHERE market_id = ? AND language = ?');
  return stmt.get(marketId, language);
}
