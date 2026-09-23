const fs=require('fs');
const path=require('path');
const bcrypt=require('bcryptjs');
const {pool,initDb,saveState,insertHistoryBatch,closeDb}=require('./db');
(async()=>{
  if(!pool) throw new Error('DATABASE_URL is required');
  const file=path.join(__dirname,'data','db.json');
  if(!fs.existsSync(file)){console.log('No data/db.json found; nothing to migrate.');return;}
  await initDb();
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  data.admin ||= {user:'admin',passHash:bcrypt.hashSync(process.env.ADMIN_PASSWORD||'admin123',10)};
  await saveState(data);
  const existing=await pool.query('SELECT COUNT(*)::int AS count FROM rate_history');
  if(Number(existing.rows[0].count)===0 && data.history?.length) await insertHistoryBatch(data.history);
  console.log('JSON data migrated to PostgreSQL successfully.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await closeDb()});
