const express=require("express"), fs=require("fs"), path=require("path"), crypto=require("crypto"), jwt=require("jsonwebtoken"), bcrypt=require("bcryptjs"), cheerio=require("cheerio"), helmet=require("helmet"), rateLimit=require("express-rate-limit");
const { pool, initDb, loadState, saveState, appendHistory, insertHistoryBatch, getHistory, closeDb } = require("./db");
const app=express(), PORT=Number(process.env.PORT||3000), DATA=path.join(__dirname,"data"), SECRET=process.env.JWT_SECRET||"change-this-secret-in-production";
const isProduction=process.env.NODE_ENV==="production";
if(isProduction && (SECRET==="change-this-secret-in-production" || String(process.env.ADMIN_PASSWORD||"").length<12 || !process.env.DATABASE_URL)){ console.error("Production requires DATABASE_URL, strong JWT_SECRET and ADMIN_PASSWORD environment variables."); process.exit(1); }
const CBL="https://cbl.gov.ly/currency-exchange-rates/";
const FULUS_URL=process.env.FULUS_API_URL||"https://fulus.ly/api/v1/rates/current";
const FULUS_KEY=process.env.FULUS_API_KEY||"";
const BANK_SOURCES=[{name:"المصرف الوطني التجاري",url:"https://www.ncb.ly/en/help-and-support/exchange-rates"}];

const dbFile=path.join(DATA,"db.json");
const seed={history:[],parallel:[],banks:[],alerts:[],settings:{refreshMinutes:5},admin:{user:"admin",passHash:bcrypt.hashSync(process.env.ADMIN_PASSWORD||"admin123",10)}};
function loadLocal(){if(!fs.existsSync(dbFile))fs.writeFileSync(dbFile,JSON.stringify(seed,null,2));return JSON.parse(fs.readFileSync(dbFile,"utf8"))}
function saveLocal(d){fs.writeFileSync(dbFile,JSON.stringify(d,null,2))}
async function persist(){ if(pool) await saveState(db); else saveLocal(db); }
let db=pool?null:loadLocal(), officialCache={rates:[],date:null,fetchedAt:null};
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({contentSecurityPolicy:false, crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:"100kb"}));
app.use(rateLimit({windowMs:60*1000,limit:120,standardHeaders:true,legacyHeaders:false}));
app.use(express.static("public",{extensions:["html"]}));

const num=v=>{let n=Number(String(v).replace(/[^\d.-]/g,""));return Number.isFinite(n)?n:null};

async function parallelAuto(){
  if(!FULUS_URL||!FULUS_KEY) return null;
  const r=await fetch(FULUS_URL,{headers:{Authorization:`Bearer ${FULUS_KEY}`,"User-Agent":"LibyaExchangePro/2.0"},signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw Error("Parallel API "+r.status);
  const j=await r.json();
  const x=j?.data?.currency ? j.data : (j?.data?.USD_LYD||j?.data?.USD||j?.rates?.USD||j?.USD||j);
  const rate=num(x?.rate ?? x?.value ?? x?.sell ?? x?.ask);
  const buy=num(x?.buy ?? x?.bid);
  const sell=num(x?.sell ?? x?.ask ?? rate);
  if(rate==null && (buy==null||sell==null)) throw Error("Unsupported Fulus API response");
  const item={id:crypto.randomUUID(),currency:x?.currency||"USD",rate:rate ?? ((buy+sell)/2),buy:buy ?? null,sell:sell ?? null,city:x?.city||"ليبيا",source:"Fulus API",sourceUrl:"https://fulus.ly/api/v1/rates/current",note:"بيانات السوق الموازي من Fulus",at:x?.timestamp||new Date().toISOString()};
  db.parallel.push(item); db.history.push({currency:item.currency,source:"parallel",buy:item.buy,sell:item.sell,rate:item.rate,average:item.rate,at:item.at,city:item.city});
  db.parallel=db.parallel.slice(-5000);db.history=db.history.slice(-50000);await persist();if(pool) await appendHistory(db.history.at(-1));return item;
}
async function bankAuto(){
  const out=[];
  for(const s of BANK_SOURCES){
    try{
      const r=await fetch(s.url,{headers:{"User-Agent":"LibyaExchangePro/2.0"},signal:AbortSignal.timeout(10000)});
      if(!r.ok)continue;
      const html=await r.text(), $=cheerio.load(html), text=$("body").text().replace(/\s+/g," ");
      const m=text.match(/US dollar\s+([\d.]+)\s+([\d.]+)/i);
      if(m) out.push({id:"ncb-auto",name:s.name,usdBuy:num(m[1]),usdSell:num(m[2]),city:"ليبيا",source:"الموقع الرسمي للمصرف",sourceUrl:s.url,at:new Date().toISOString()});
    }catch(e){}
  }
  if(out.length){ for(const b of out){db.banks=db.banks.filter(x=>x.id!==b.id);db.banks.push(b)} await persist(); }
  return out;
}
async function official(){
  const r=await fetch(CBL,{headers:{"User-Agent":"LibyaExchangePro/2.0"},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error("CBL "+r.status);
  const $=cheerio.load(await r.text()), out=[];
  $("table tr").each((_,tr)=>{
    const c=$(tr).find("th,td").map((__,td)=>$(td).text().replace(/\s+/g," ").trim()).get();
    if(c.length<5)return;
    const n=c.map(num).filter(v=>v!==null);
    if(n.length<3)return;
    const currency=c.find(x=>!(/^\d|تاريخ|وحدة|متوسط|بيع|شراء/i.test(x)))||c[1];
    if(!currency)return;
    out.push({currency,unit:c.find(x=>/دولار واحد|يورو واحد|جنيه واحد|واحد|فرنك/i.test(x))||"",average:n.at(-3),sell:n.at(-2),buy:n.at(-1)});
  });
  const seen=new Set(), rates=out.filter(x=>{let k=x.currency+"|"+x.unit;if(seen.has(k))return false;seen.add(k);return true});
  if(!rates.length)throw Error("No CBL rates parsed");
  officialCache={rates,date:new Date().toISOString().slice(0,10),fetchedAt:new Date().toISOString(),source:"مصرف ليبيا المركزي",sourceUrl:CBL};
  return officialCache;
}
app.get("/health",(req,res)=>res.json({ok:true,service:"libya-exchange-pro",version:"4.0.0",time:new Date().toISOString(),uptime:Math.round(process.uptime())}));
function auth(req,res,next){try{let h=req.headers.authorization||"";req.user=jwt.verify(h.replace("Bearer ",""),SECRET);next()}catch(e){res.status(401).json({error:"غير مصرح"})}}
app.get("/api/official",async(req,res)=>{try{res.json({ok:true,...await official()})}catch(e){res.status(502).json({ok:false,error:"تعذر جلب السعر الرسمي الآن"})}});
app.get("/api/dashboard",async(req,res)=>{
  let o;try{o=await official()}catch(e){o=officialCache}
  try{await parallelAuto()}catch(e){}
  try{await bankAuto()}catch(e){}
  const usd=o?.rates?.find(x=>/الدولار الأمريكي/i.test(x.currency));
  const p=db.parallel.slice(-1)[0]||null;
  res.json({official:o,usd,parallel:p,banks:db.banks,alerts:db.alerts.map(a=>({...a,active:!!a.active})),settings:db.settings,connectors:{parallel:!!FULUS_URL&&!!FULUS_KEY,banks:true}});
});
app.get("/api/history",async(req,res)=>{
  const source=req.query.source||"all", currency=req.query.currency||"USD", days=Math.min(Number(req.query.days||30),365);
  try {
    const items=pool ? await getHistory({source,currency,days}) : db.history.filter(x=>(source==="all"||x.source===source)&&x.currency===currency).filter(x=>Date.now()-new Date(x.at).getTime()<=days*864e5);
    res.json({ok:true,items});
  } catch(e) { res.status(500).json({ok:false,error:"تعذر قراءة السجل التاريخي"}); }
});
app.post("/api/login",async(req,res)=>{
  const {user,password}=req.body||{};
  if(user===db.admin.user&&bcrypt.compareSync(password||"",db.admin.passHash))
    return res.json({token:jwt.sign({user},SECRET,{expiresIn:"12h"})});
  res.status(401).json({error:"بيانات الدخول غير صحيحة"});
});
app.get("/api/admin/state",auth,(req,res)=>res.json({parallel:db.parallel,banks:db.banks,alerts:db.alerts,settings:db.settings}));
app.post("/api/admin/parallel",auth,async(req,res)=>{
  const {currency="USD",buy,sell,city="طرابلس",source="إدخال إداري",note=""}=req.body;
  if(num(buy)==null||num(sell)==null)return res.status(400).json({error:"أدخل الشراء والبيع"});
  const item={id:crypto.randomUUID(),currency,buy:num(buy),sell:num(sell),city,source,note,at:new Date().toISOString()};
  db.parallel.push(item); db.history.push({currency,source:"parallel",buy:item.buy,sell:item.sell,average:(item.buy+item.sell)/2,at:item.at,city});
  db.parallel=db.parallel.slice(-5000); db.history=db.history.slice(-50000); await persist(); if(pool) await appendHistory(db.history.at(-1)); res.json(item);
});
app.post("/api/admin/bank",auth,async(req,res)=>{
  const b={id:req.body.id||crypto.randomUUID(),name:String(req.body.name||"").trim(),usdBuy:num(req.body.usdBuy),usdSell:num(req.body.usdSell),eurBuy:num(req.body.eurBuy),eurSell:num(req.body.eurSell),city:req.body.city||"ليبيا",at:new Date().toISOString()};
  if(!b.name)return res.status(400).json({error:"اسم المصرف مطلوب"});
  db.banks=db.banks.filter(x=>x.id!==b.id);db.banks.push(b);await persist();res.json(b);
});
app.delete("/api/admin/bank/:id",auth,async(req,res)=>{db.banks=db.banks.filter(x=>x.id!==req.params.id);await persist();res.json({ok:true})});
app.post("/api/admin/alert",auth,async(req,res)=>{
  const a={id:req.body.id||crypto.randomUUID(),name:req.body.name||"تنبيه الدولار",currency:req.body.currency||"USD",market:req.body.market||"parallel",direction:req.body.direction||"above",value:num(req.body.value),active:req.body.active!==false,createdAt:new Date().toISOString()};
  if(a.value==null)return res.status(400).json({error:"قيمة التنبيه مطلوبة"});
  db.alerts=db.alerts.filter(x=>x.id!==a.id);db.alerts.push(a);await persist();res.json(a);
});
app.delete("/api/admin/alert/:id",auth,async(req,res)=>{db.alerts=db.alerts.filter(x=>x.id!==req.params.id);await persist();res.json({ok:true})});
app.post("/api/admin/settings",auth,async(req,res)=>{db.settings.refreshMinutes=Math.max(1,Number(req.body.refreshMinutes||5));await persist();res.json(db.settings)});
app.get("/api/alerts/check",async(req,res)=>{
  let o;try{o=await official()}catch(e){o=officialCache}
  const usd=o?.rates?.find(x=>/الدولار الأمريكي/i.test(x.currency)), p=db.parallel.slice(-1)[0], hits=[];
  for(const a of db.alerts.filter(x=>x.active)){
    const base=a.market==="official"?usd?.sell:(p?.rate ?? p?.sell); if(base==null)continue;
    const ok=a.direction==="above"?base>=a.value:base<=a.value;
    if(ok)hits.push({...a,current:base});
  }
  res.json({hits});
});
const REFRESH_MS=Math.max(1,Number(process.env.REFRESH_MINUTES||5))*60*1000;
setInterval(async()=>{
  try { await parallelAuto(); } catch(e) {}
  try { await bankAuto(); } catch(e) {}
  try {
    const o=await official();
    const u=o.rates.find(x=>/الدولار الأمريكي/i.test(x.currency));
    if(u){ const h={currency:"USD",source:"official",buy:u.buy,sell:u.sell,average:u.average,at:new Date().toISOString()}; db.history.push(h); db.history=db.history.slice(-50000); await persist(); if(pool) await appendHistory(h); }
  } catch(e) {}
},REFRESH_MS);

async function bootstrap(){
  if(pool){ await initDb(); db=await loadState(); }
  else if(isProduction){ throw new Error("DATABASE_URL is required in production"); }
  const server=app.listen(PORT,"0.0.0.0",()=>console.log(`Libya Exchange Pro on ${PORT} (${pool?"PostgreSQL":"local JSON"})`));
  const shutdown=async()=>{ server.close(async()=>{ try{await closeDb();}finally{process.exit(0);} }); };
  process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);
}
bootstrap().catch(err=>{ console.error("Startup failed:",err); process.exit(1); });