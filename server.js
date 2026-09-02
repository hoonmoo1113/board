import express from 'express';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PALETTE = ['#E11D48','#2563EB','#059669','#D97706','#7C3AED','#0891B2','#DB2777','#65A30D','#EA580C','#4F46E5','#0D9488','#9333EA'];

const DEFAULT_CONFIG = {
  title: ['2026년 9월 20일  11시~2시쯤', '조슈아 반 : 알렉산드레 판토자'],
  labelHeader: '구분',
  answerCols: ['반', '판토자'],
  rows: [
    {group:'KO/TKO',label:'1라운드'},{group:'KO/TKO',label:'2라운드'},{group:'KO/TKO',label:'3라운드'},{group:'KO/TKO',label:'4라운드'},{group:'KO/TKO',label:'5라운드'},
    {group:'서브미션',label:'1라운드'},{group:'서브미션',label:'2라운드'},{group:'서브미션',label:'3라운드'},{group:'서브미션',label:'4라운드'},{group:'서브미션',label:'5라운드'},
    {group:'',label:'판정 만장일치'},{group:'',label:'판정 스플릿'}
  ]
};
const DEFAULT_TURN = { curIdx: 0, remaining: 1, picksPerTurn: 1, started: false };

const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN });

async function init() {
  await db.execute(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS board_claims(cell TEXT PRIMARY KEY, player_id TEXT, ts INTEGER)`);
  if (!(await getS('board:config'))) await setS('board:config', JSON.stringify(DEFAULT_CONFIG));
  if (!(await getS('board:players'))) await setS('board:players', JSON.stringify([]));
  if (!(await getS('board:turn'))) await setS('board:turn', JSON.stringify(DEFAULT_TURN));
}
async function getS(k){ const r=await db.execute({sql:`SELECT value FROM settings WHERE key=?`,args:[k]}); return r.rows.length?r.rows[0].value:null; }
async function setS(k,v){ await db.execute({sql:`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,args:[k,v]}); }
async function J(k,def){ try{const v=await getS(k); return v?JSON.parse(v):def;}catch{return def;} }
async function getPin(){ return (await getS('board:admin_pin')) || ADMIN_PIN; }
async function getClaims(){ const r=await db.execute(`SELECT cell,player_id FROM board_claims`); const m={}; r.rows.forEach(x=>m[x.cell]=x.player_id); return m; }

app.get('/api/state', async (req,res)=>{
  try{
    res.json({
      config: await J('board:config',DEFAULT_CONFIG),
      players: await J('board:players',[]),
      turn: await J('board:turn',DEFAULT_TURN),
      claims: await getClaims(),
      palette: PALETTE
    });
  }catch(e){res.status(500).json({error:String(e)});}
});

app.post('/api/join', async (req,res)=>{
  try{
    const {id,name}=req.body||{};
    if(!id||!name||!String(name).trim()) return res.status(400).json({error:'name'});
    const players=await J('board:players',[]);
    const ex=players.find(p=>p.id===id);
    if(ex){ ex.name=String(name).trim().slice(0,16); await setS('board:players',JSON.stringify(players)); return res.json({ok:true,id,color:ex.color}); }
    const turn=await J('board:turn',DEFAULT_TURN);
    if(turn.started) return res.status(403).json({error:'started'});
    const color=PALETTE[players.length % PALETTE.length];
    players.push({id:String(id),name:String(name).trim().slice(0,16),color});
    await setS('board:players',JSON.stringify(players));
    res.json({ok:true,id,color});
  }catch(e){res.status(500).json({error:String(e)});}
});

function validCell(cell,config){ const m=/^(\d+)_(\d+)$/.exec(cell||''); if(!m)return false;
  const r=+m[1],a=+m[2]; return r>=0&&r<config.rows.length&&a>=0&&a<config.answerCols.length; }

async function doClaim(cell, forPid, byTurn){
  const config=await J('board:config',DEFAULT_CONFIG), players=await J('board:players',[]), turn=await J('board:turn',DEFAULT_TURN);
  if(!turn.started) return {error:'not_started'};
  if(!players.length) return {error:'no_players'};
  if(!validCell(cell,config)) return {error:'bad_cell'};
  const cur=players[turn.curIdx%players.length];
  if(byTurn && cur.id!==forPid) return {error:'not_turn'};
  const claims=await getClaims();
  if(claims[cell]) return {error:'taken'};
  const owner = byTurn ? forPid : cur.id;
  await db.execute({sql:`INSERT INTO board_claims(cell,player_id,ts) VALUES(?,?,?) ON CONFLICT(cell) DO NOTHING`,args:[cell,owner,Date.now()]});
  turn.remaining=(turn.remaining||1)-1;
  if(turn.remaining<=0){ turn.curIdx=(turn.curIdx+1)%players.length; turn.remaining=turn.picksPerTurn||1; }
  await setS('board:turn',JSON.stringify(turn));
  return {ok:true};
}

app.post('/api/claim', async (req,res)=>{
  try{ const r=await doClaim(req.body?.cell, req.body?.id, true); res.status(r.error?409:200).json(r);}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/claim', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    const r=await doClaim(req.body?.cell, null, false); res.status(r.error?409:200).json(r);}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/unclaim', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    await db.execute({sql:`DELETE FROM board_claims WHERE cell=?`,args:[req.body?.cell]}); res.json({ok:true});}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/check', async (req,res)=>res.json({ok:(req.body?.pin)===await getPin()}));
app.post('/api/admin/config', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    const c=req.body?.config; if(!c||!Array.isArray(c.rows)||!Array.isArray(c.answerCols)) return res.status(400).json({error:'bad'});
    await setS('board:config',JSON.stringify(c)); res.json({ok:true});}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/players', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    const p=req.body?.players; if(!Array.isArray(p)) return res.status(400).json({error:'bad'});
    await setS('board:players',JSON.stringify(p)); res.json({ok:true});}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/turn', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    let turn=await J('board:turn',DEFAULT_TURN); const players=await J('board:players',[]);
    const act=req.body?.action, patch=req.body?.patch||{};
    if(act==='start'){ turn.started=true; turn.curIdx=0; turn.remaining=turn.picksPerTurn||1; }
    else if(act==='pass'){ if(players.length){turn.curIdx=(turn.curIdx+1)%players.length; turn.remaining=turn.picksPerTurn||1;} }
    else { turn={...turn,...patch}; if(patch.picksPerTurn){ turn.picksPerTurn=Math.max(1,+patch.picksPerTurn); if(!turn.started) turn.remaining=turn.picksPerTurn; } if(patch.curIdx!=null&&players.length){turn.curIdx=((+patch.curIdx)%players.length+players.length)%players.length;} if(patch.remaining!=null)turn.remaining=Math.max(1,+patch.remaining); }
    await setS('board:turn',JSON.stringify(turn)); res.json({ok:true,turn});}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/reset', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    await db.execute(`DELETE FROM board_claims`);
    let turn=await J('board:turn',DEFAULT_TURN); turn.started=false; turn.curIdx=0; turn.remaining=turn.picksPerTurn||1;
    await setS('board:turn',JSON.stringify(turn));
    if(req.body?.clearPlayers) await setS('board:players',JSON.stringify([]));
    res.json({ok:true});}catch(e){res.status(500).json({error:String(e)});}
});
app.post('/api/admin/pin', async (req,res)=>{
  try{ if((req.body?.pin)!==await getPin()) return res.status(403).json({error:'pin'});
    const np=String(req.body?.newPin||'').trim(); if(np.length<4||np.length>20) return res.status(400).json({error:'length'});
    await setS('board:admin_pin',np); res.json({ok:true});}catch(e){res.status(500).json({error:String(e)});}
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
init().then(()=>app.listen(PORT,()=>console.log('▶ board on '+PORT))).catch(e=>{console.error(e);process.exit(1);});
