const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL || '';
const pool = connectionString ? new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS parallel_rates (
      id TEXT PRIMARY KEY,
      currency TEXT NOT NULL,
      rate NUMERIC,
      buy NUMERIC,
      sell NUMERIC,
      city TEXT,
      source TEXT,
      source_url TEXT,
      note TEXT,
      at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bank_rates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      usd_buy NUMERIC,
      usd_sell NUMERIC,
      eur_buy NUMERIC,
      eur_sell NUMERIC,
      city TEXT,
      source TEXT,
      source_url TEXT,
      at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_history (
      id BIGSERIAL PRIMARY KEY,
      currency TEXT NOT NULL,
      source TEXT NOT NULL,
      buy NUMERIC,
      sell NUMERIC,
      rate NUMERIC,
      average NUMERIC,
      city TEXT,
      at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_history_currency_source_at_idx ON rate_history(currency, source, at DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      market TEXT NOT NULL,
      direction TEXT NOT NULL,
      value NUMERIC NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
  const admin = await pool.query('SELECT username FROM admin_users LIMIT 1');
  if (!admin.rowCount) {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    await pool.query('INSERT INTO admin_users(username,password_hash) VALUES($1,$2)', ['admin', bcrypt.hashSync(password, 10)]);
  }
  const setting = await pool.query("SELECT 1 FROM app_settings WHERE key='settings'");
  if (!setting.rowCount) await pool.query("INSERT INTO app_settings(key,value) VALUES('settings',$1)", [{refreshMinutes:5}]);
}

async function loadState() {
  if (!pool) return null;
  const [parallel,banks,history,alerts,settings,admin] = await Promise.all([
    pool.query('SELECT id,currency,rate,buy,sell,city,source,source_url AS "sourceUrl",note,at FROM parallel_rates ORDER BY at ASC'),
    pool.query('SELECT id,name,usd_buy AS "usdBuy",usd_sell AS "usdSell",eur_buy AS "eurBuy",eur_sell AS "eurSell",city,source,source_url AS "sourceUrl",at FROM bank_rates ORDER BY at ASC'),
    pool.query('SELECT currency,source,buy,sell,rate,average,city,at FROM rate_history ORDER BY at ASC'),
    pool.query('SELECT id,name,currency,market,direction,value,active,created_at AS "createdAt" FROM alerts ORDER BY created_at ASC'),
    pool.query("SELECT value FROM app_settings WHERE key='settings'"),
    pool.query('SELECT username AS user,password_hash AS "passHash" FROM admin_users LIMIT 1')
  ]);
  return {
    history: history.rows.map(normalizeDates),
    parallel: parallel.rows.map(normalizeDates),
    banks: banks.rows.map(normalizeDates),
    alerts: alerts.rows.map(normalizeDates),
    settings: settings.rows[0]?.value || {refreshMinutes:5},
    admin: admin.rows[0] || {user:'admin',passHash:''}
  };
}
function normalizeDates(row){
  const out={...row};
  for(const k of ['at','createdAt']) if(out[k] instanceof Date) out[k]=out[k].toISOString();
  for(const k of ['rate','buy','sell','average','usdBuy','usdSell','eurBuy','eurSell','value']) if(out[k]!==null && out[k]!==undefined) out[k]=Number(out[k]);
  return out;
}

async function saveState(db) {
  if (!pool) throw new Error('DATABASE_URL is required for PostgreSQL persistence');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO app_settings(key,value) VALUES('settings',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [db.settings || {refreshMinutes:5}]);
    if (db.admin?.user && db.admin?.passHash) {
      await client.query('INSERT INTO admin_users(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash', [db.admin.user, db.admin.passHash]);
    }
    await client.query('DELETE FROM parallel_rates');
    for (const x of db.parallel.slice(-5000)) await client.query('INSERT INTO parallel_rates(id,currency,rate,buy,sell,city,source,source_url,note,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [x.id,x.currency,x.rate??null,x.buy??null,x.sell??null,x.city||null,x.source||null,x.sourceUrl||null,x.note||null,new Date(x.at)]);
    await client.query('DELETE FROM bank_rates');
    for (const x of db.banks) await client.query('INSERT INTO bank_rates(id,name,usd_buy,usd_sell,eur_buy,eur_sell,city,source,source_url,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [x.id,x.name,x.usdBuy??null,x.usdSell??null,x.eurBuy??null,x.eurSell??null,x.city||null,x.source||null,x.sourceUrl||null,new Date(x.at)]);
    await client.query('DELETE FROM alerts');
    for (const x of db.alerts) await client.query('INSERT INTO alerts(id,name,currency,market,direction,value,active,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [x.id,x.name,x.currency,x.market,x.direction,x.value,x.active,new Date(x.createdAt)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function appendHistory(item) {
  if (!pool) return;
  await pool.query('INSERT INTO rate_history(currency,source,buy,sell,rate,average,city,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [item.currency,item.source,item.buy??null,item.sell??null,item.rate??null,item.average??null,item.city||null,new Date(item.at)]);
  await pool.query('DELETE FROM rate_history WHERE id NOT IN (SELECT id FROM rate_history ORDER BY at DESC LIMIT 50000)');
}
async function insertHistoryBatch(items) {
  if (!pool || !items?.length) return;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for(const item of items) await client.query('INSERT INTO rate_history(currency,source,buy,sell,rate,average,city,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [item.currency,item.source,item.buy??null,item.sell??null,item.rate??null,item.average??null,item.city||null,new Date(item.at)]);
    await client.query('DELETE FROM rate_history WHERE id NOT IN (SELECT id FROM rate_history ORDER BY at DESC LIMIT 50000)');
    await client.query('COMMIT');
  } catch(e){ await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function getHistory({source='all',currency='USD',days=30}) {
  if (!pool) return [];
  const params=[currency, Math.min(Number(days||30),365)];
  let sql='SELECT currency,source,buy,sell,rate,average,city,at FROM rate_history WHERE currency=$1 AND at >= NOW() - ($2 * INTERVAL \'1 day\')';
  if(source!=='all'){ params.push(source); sql += ' AND source=$3'; }
  sql += ' ORDER BY at ASC';
  const r=await pool.query(sql,params); return r.rows.map(normalizeDates);
}
async function closeDb(){ if(pool) await pool.end(); }
module.exports={pool,initDb,loadState,saveState,appendHistory,insertHistoryBatch,getHistory,closeDb};
