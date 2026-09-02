import express from 'express';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PALETTE = ['#E11D48','#2563EB','#059669','#D97706','#7C3AED','#0891B2','#DB2777','#65A30D','#EA580C','#4F46E5','#0D9488','#9333EA'];
const NEW_TURN = () => ({ curIdx: 0, remaining: 1, picksPerTurn: 1, started: false });
const DEMO_CONFIG = {
  title: ['2026년 9월 20일  11시~2시쯤', '조슈아 반 : 알렉산드레 판토자'],
  labelHeader: '구분', answerCols: ['반', '판토자'],
  rows: [
    {group:'KO/TKO',label:'1라운드'},{group:'KO/TKO',label:'2라운드'},{group:'KO/TKO',label:'3라운드'},{group:'KO/TKO',label:'4라운드'},{group:'KO/TKO',label:'5라운드'},
    {group:'서브미션',label:'1라운드'},{group:'서브미션',label:'2라운드'},{group:'서브미션',label:'3라운드'},{group:'서브미션',label:'4라운드'},{group:'서브미션',label:'5라운드'},
    {group:'',label:'판정 만장일치'},{group:'',label:'판정 스플릿'}
  ]
};
const BLANK_CONFIG = () => ({ title:['새 게임판'], labelHeader:'구분', answerCols:['선택 1','선택 2'], rows:[{group:'',label:'항목 1'},{group:'',label:'항목 2'},{group:'',label:'항목 3'}] });

const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN });

async function getS(k){ const r=await db.execute({sql:`SELECT value FROM settings WHERE key=?`,args:[k]}); return r.rows.length?r.rows[0].value:null; }
async function setS(k,v){ await db.execute({sql:`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,args:[k,v]}); }
async function J(k,def){ try{const v=await getS(k); return v?JSON.parse(v):def;}catch{return def;} }
const getBoards=()=>J('board:boards',[]);
const setBoards=b=>setS('board:boards',JSON.stringify(b));
const getPlayers=()=>J('board:players',[]);
const setPlayers=p=>setS('board:players',JSON.stringify(p));
async function getPin(){ return (await getS('board:admin_pin')) || ADMIN_PIN; }
async function auth(req){ return !!(req.body) && req.body.pin===await getPin(); }

async function init(){
  await db.execute(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS board_claims(board_id TEXT, cell TEXT, player_id TEXT, ts INTEGER, PRIMARY KEY(board_id,cell))`);
  const boards = await getBoards();
  if (!boards.length){
    await setBoards([{ id:'b1', name:'경기 1', config: DEMO_CONFIG, turn: NEW_TURN() }]);
    await setS('board:active','b1');
  }
  if (!(await getS('board:players'))) await setPlayers([]);
}

async function claimsMap(){
  const r=await db.execute(`SELECT board_id,cell,player_id FROM board_claims`);
  const m={}; r.rows.forEach(x=>{ (m[x.board_id]=m[x.board_id]||{})[x.cell]=x.player_id; }); return m;
}
function validCell(cell,cfg){ const m=/^(\d+)_(\d+)$/.exec(cell||''); if(!m)return false; const r=+m[1],a=+m[2]; return r>=0&&r<cfg.rows.length&&a>=0&&a<cfg.answerCols.length; }
function advance(b,players){ b.turn.remaining=(b.turn.remaining||1)-1; if(b.turn.remaining<=0){ b.turn.curIdx=(b.turn.curIdx+1)%players.length; b.turn.remaining=b.turn.picksPerTurn||1; } }

app.get('/api/state', async (req,res)=>{
  try{ res.json({ boards: await getBoards(), players: await getPlayers(), active: (await getS('board:active'))||'', claims: await claimsMap(), palette: PALETTE }); }
  catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/claim', async (req,res)=>{
  try{
    if(!await auth(req))return res.status(403).json({error:'pin'});
    const { boardId, cell } = req.body||{};
    const boards=await getBoards(), players=await getPlayers();
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(!b.turn.started) return res.status(409).json({error:'not_started'});
    if(!players.length) return res.status(409).json({error:'no_players'});
    if(!validCell(cell,b.config)) return res.status(400).json({error:'bad_cell'});
    const cur=players[b.turn.curIdx%players.length];
    const ex=await db.execute({sql:`SELECT 1 FROM board_claims WHERE board_id=? AND cell=?`,args:[boardId,cell]});
    if(ex.rows.length) return res.status(409).json({error:'taken'});
    await db.execute({sql:`INSERT INTO board_claims(board_id,cell,player_id,ts) VALUES(?,?,?,?)`,args:[boardId,cell,cur.id,Date.now()]});
    advance(b,players); await setBoards(boards); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/undo', async (req,res)=>{
  try{
    if(!await auth(req))return res.status(403).json({error:'pin'});
    const { boardId } = req.body||{};
    const boards=await getBoards(), players=await getPlayers();
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    const last=await db.execute({sql:`SELECT cell,player_id FROM board_claims WHERE board_id=? ORDER BY ts DESC LIMIT 1`,args:[boardId]});
    if(!last.rows.length) return res.json({ok:true,empty:true});
    const pid=last.rows[0].player_id;
    await db.execute({sql:`DELETE FROM board_claims WHERE board_id=? AND cell=?`,args:[boardId,last.rows[0].cell]});
    const idx=players.findIndex(p=>p.id===pid);
    if(idx>=0){ b.turn.curIdx=idx; b.turn.remaining=1; b.turn.started=true; await setBoards(boards); }
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/unclaim', async (req,res)=>{
  try{ if(!await auth(req))return res.status(403).json({error:'pin'}); const {boardId,cell}=req.body||{}; await db.execute({sql:`DELETE FROM board_claims WHERE board_id=? AND cell=?`,args:[boardId,cell]}); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/turn', async (req,res)=>{
  try{
    if(!await auth(req))return res.status(403).json({error:'pin'});
    const { boardId, action, patch } = req.body||{};
    const boards=await getBoards(), players=await getPlayers();
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(action==='start'){ b.turn.started=true; b.turn.curIdx=0; b.turn.remaining=b.turn.picksPerTurn||1; }
    else if(action==='pass'){ if(players.length){ b.turn.curIdx=(b.turn.curIdx+1)%players.length; b.turn.remaining=b.turn.picksPerTurn||1; } }
    else if(patch){ if(patch.picksPerTurn!=null){ b.turn.picksPerTurn=Math.max(1,+patch.picksPerTurn); if(!b.turn.started)b.turn.remaining=b.turn.picksPerTurn; }
      if(patch.remaining!=null)b.turn.remaining=Math.max(1,+patch.remaining);
      if(patch.curIdx!=null&&players.length)b.turn.curIdx=((+patch.curIdx)%players.length+players.length)%players.length; }
    await setBoards(boards); res.json({ok:true,turn:b.turn});
  }catch(e){ res.status(500).json({error:String(e)}); }
});


app.post('/api/players', async (req,res)=>{
  try{ if(!await auth(req))return res.status(403).json({error:'pin'}); const p=req.body?.players; if(!Array.isArray(p)) return res.status(400).json({error:'bad'});
    // ensure colors
    const used=new Set();
    p.forEach((pl,i)=>{ if(!pl.id)pl.id='p-'+Date.now()+'-'+i; if(!pl.color){pl.color=PALETTE.find(c=>!used.has(c))||PALETTE[i%PALETTE.length];} used.add(pl.color); pl.name=String(pl.name||('P'+(i+1))).slice(0,16); });
    await setPlayers(p); res.json({ok:true,players:p});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/board', async (req,res)=>{
  try{
    if(!await auth(req))return res.status(403).json({error:'pin'});
    const { action, boardId, name, config } = req.body||{};
    const boards=await getBoards();
    if(action==='add'){ const id='b'+Date.now(); boards.push({id,name:String(name||('경기 '+(boards.length+1))).slice(0,24),config:BLANK_CONFIG(),turn:NEW_TURN()}); await setBoards(boards); await setS('board:active',id); return res.json({ok:true,id}); }
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(action==='rename'){ b.name=String(name||b.name).slice(0,24); }
    else if(action==='config'){ if(!config||!Array.isArray(config.rows)||!Array.isArray(config.answerCols)) return res.status(400).json({error:'bad'}); b.config=config; }
    else if(action==='clear'){ await db.execute({sql:`DELETE FROM board_claims WHERE board_id=?`,args:[boardId]}); b.turn=NEW_TURN(); if(config&&config.picksPerTurn)b.turn.picksPerTurn=config.picksPerTurn; }
    else if(action==='delete'){ if(boards.length<=1) return res.status(400).json({error:'last'}); const i=boards.findIndex(x=>x.id===boardId); boards.splice(i,1); await db.execute({sql:`DELETE FROM board_claims WHERE board_id=?`,args:[boardId]}); const act=await getS('board:active'); if(act===boardId) await setS('board:active',boards[0].id); }
    await setBoards(boards); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/reset', async (req,res)=>{
  try{ if(!await auth(req))return res.status(403).json({error:'pin'}); await db.execute(`DELETE FROM board_claims`);
    const boards=await getBoards(); boards.forEach(b=>b.turn=NEW_TURN()); await setBoards(boards);
    if(req.body?.clearPlayers) await setPlayers([]);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

app.post('/api/admin/check', async (req,res)=>res.json({ok:(req.body?.pin)===await getPin()}));
app.post('/api/admin/pin', async (req,res)=>{
  try{ if(!await auth(req))return res.status(403).json({error:'pin'}); const np=String(req.body?.newPin||'').trim();
    if(np.length<4||np.length>20)return res.status(400).json({error:'length'}); await setS('board:admin_pin',np); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:String(e)}); }
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
init().then(()=>app.listen(PORT,()=>console.log('▶ board on '+PORT))).catch(e=>{console.error(e);process.exit(1);});
