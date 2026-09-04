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
const DEMO = { title:['2026년 9월 20일  11시~2시쯤','조슈아 반 : 알렉산드레 판토자'], labelHeader:'구분', answerCols:['반','판토자'],
  rows:[{group:'KO/TKO',label:'1라운드'},{group:'KO/TKO',label:'2라운드'},{group:'KO/TKO',label:'3라운드'},{group:'KO/TKO',label:'4라운드'},{group:'KO/TKO',label:'5라운드'},
    {group:'서브미션',label:'1라운드'},{group:'서브미션',label:'2라운드'},{group:'서브미션',label:'3라운드'},{group:'서브미션',label:'4라운드'},{group:'서브미션',label:'5라운드'},
    {group:'',label:'판정 만장일치'},{group:'',label:'판정 스플릿'}] };
const BLANK = () => ({ title:['새 게임판'], labelHeader:'구분', answerCols:['선택 1','선택 2'], rows:[{group:'',label:'항목 1'},{group:'',label:'항목 2'},{group:'',label:'항목 3'}] });

const db = createClient({ url: process.env.TURSO_DATABASE_URL || 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN });
async function getS(k){ const r=await db.execute({sql:`SELECT value FROM settings WHERE key=?`,args:[k]}); return r.rows.length?r.rows[0].value:null; }
async function setS(k,v){ await db.execute({sql:`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,args:[k,v]}); }
async function J(k,def){ try{const v=await getS(k); return v?JSON.parse(v):def;}catch{return def;} }
const getBoards=()=>J('board:boards',[]), setBoards=b=>setS('board:boards',JSON.stringify(b));
const getPlayers=()=>J('board:players',[]), setPlayers=p=>setS('board:players',JSON.stringify(p));
const getTurn=()=>J('board:turn',NEW_TURN()), setTurn=t=>setS('board:turn',JSON.stringify(t));
async function getPin(){ return (await getS('board:admin_pin')) || ADMIN_PIN; }
async function auth(req){ return !!(req.body) && req.body.pin===await getPin(); }

async function init(){
  await db.execute(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS board_claims_v2(board_id TEXT, cell TEXT, player_id TEXT, ts INTEGER, PRIMARY KEY(board_id,cell))`);
  if(!(await getBoards()).length) await setBoards([{ id:'b1', name:'경기 1', config: DEMO, themeIdx:0 }]);
  if(!(await getS('board:turn'))) await setTurn(NEW_TURN());
  if(!(await getS('board:players'))) await setPlayers([]);
}
async function claimsMap(){ const r=await db.execute(`SELECT board_id,cell,player_id FROM board_claims_v2`); const m={}; r.rows.forEach(x=>{(m[x.board_id]=m[x.board_id]||{})[x.cell]=x.player_id;}); return m; }
function validCell(cell,cfg){ const m=/^(\d+)_(\d+)$/.exec(cell||''); if(!m)return false; const r=+m[1],a=+m[2]; return r>=0&&r<cfg.rows.length&&a>=0&&a<cfg.answerCols.length; }
function advance(t,players){ t.remaining=(t.remaining||1)-1; if(t.remaining<=0){ t.curIdx=(t.curIdx+1)%players.length; t.remaining=t.picksPerTurn||1; } }

app.get('/api/state', async (req,res)=>{
  try{ res.json({ boards:await getBoards(), players:await getPlayers(), turn:await getTurn(), claims:await claimsMap(), palette:PALETTE }); }
  catch(e){ res.status(500).json({error:String(e)}); }
});

// 친구가 이름으로 참여 (열려 있음). 시작 전에만 새로 참여 가능, 재접속(같은 id)은 항상 허용.
app.post('/api/join', async (req,res)=>{
  try{ const {id,name}=req.body||{}; if(!id||!name||!String(name).trim()) return res.status(400).json({error:'name'});
    const players=await getPlayers(); const ex=players.find(p=>p.id===id);
    if(ex){ ex.name=String(name).trim().slice(0,16); await setPlayers(players); return res.json({ok:true,id,color:ex.color}); }
    const turn=await getTurn(); if(turn.started) return res.status(403).json({error:'started'});
    const used=new Set(players.map(p=>p.color)); const color=PALETTE.find(c=>!used.has(c))||PALETTE[players.length%PALETTE.length];
    players.push({id:String(id),name:String(name).trim().slice(0,16),color}); await setPlayers(players);
    res.json({ok:true,id,color});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

// 참가자가 자기 차례에만 자기 이름으로 채움 (순서 강제)
app.post('/api/claim', async (req,res)=>{
  try{ const {boardId,cell,playerId}=req.body||{};
    const boards=await getBoards(), players=await getPlayers(), turn=await getTurn();
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(!turn.started) return res.status(409).json({error:'not_started'});
    if(!players.length) return res.status(409).json({error:'no_players'});
    const cur=players[turn.curIdx%players.length];
    if(!playerId || playerId!==cur.id) return res.status(409).json({error:'not_turn'});
    if(!validCell(cell,b.config)) return res.status(400).json({error:'bad_cell'});
    const ex=await db.execute({sql:`SELECT 1 FROM board_claims_v2 WHERE board_id=? AND cell=?`,args:[boardId,cell]});
    if(ex.rows.length) return res.status(409).json({error:'taken'});
    await db.execute({sql:`INSERT INTO board_claims_v2(board_id,cell,player_id,ts) VALUES(?,?,?,?)`,args:[boardId,cell,cur.id,Date.now()]});
    advance(turn,players); await setTurn(turn); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});

// ----- 방장 전용 (PIN) -----
app.post('/api/turn', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  const {action,patch}=req.body||{}; const players=await getPlayers(); let t=await getTurn();
  if(action==='start'){ t.started=true; t.curIdx=0; t.remaining=t.picksPerTurn||1; }
  else if(action==='pass'){ if(players.length){ t.curIdx=(t.curIdx+1)%players.length; t.remaining=t.picksPerTurn||1; } }
  else if(patch){ if(patch.picksPerTurn!=null){ t.picksPerTurn=Math.max(1,+patch.picksPerTurn); t.remaining=t.picksPerTurn; } if(patch.remaining!=null)t.remaining=Math.max(1,+patch.remaining); if(patch.curIdx!=null&&players.length)t.curIdx=((+patch.curIdx)%players.length+players.length)%players.length; }
  await setTurn(t); res.json({ok:true,turn:t}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/undo', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  const players=await getPlayers(); const last=await db.execute(`SELECT board_id,cell,player_id FROM board_claims_v2 ORDER BY ts DESC LIMIT 1`);
  if(!last.rows.length) return res.json({ok:true,empty:true}); const {board_id,cell,player_id}=last.rows[0];
  await db.execute({sql:`DELETE FROM board_claims_v2 WHERE board_id=? AND cell=?`,args:[board_id,cell]});
  let t=await getTurn(); const i=players.findIndex(p=>p.id===player_id); if(i>=0){ t.curIdx=i; t.remaining=1; t.started=true; await setTurn(t); } res.json({ok:true}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/unclaim', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  const {boardId,cell}=req.body||{}; await db.execute({sql:`DELETE FROM board_claims_v2 WHERE board_id=? AND cell=?`,args:[boardId,cell]}); res.json({ok:true}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/players', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  const p=req.body?.players; if(!Array.isArray(p)) return res.status(400).json({error:'bad'});
  const used=new Set(); p.forEach((pl,i)=>{ if(!pl.id)pl.id='p-'+Date.now()+'-'+i; if(!pl.color){pl.color=PALETTE.find(c=>!used.has(c))||PALETTE[i%PALETTE.length];} used.add(pl.color); pl.name=String(pl.name||('P'+(i+1))).slice(0,16); });
  await setPlayers(p); res.json({ok:true,players:p}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/board', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  const {action,boardId,name,config}=req.body||{}; const boards=await getBoards();
  const THEMES=7;
  if(action==='add'){ const id='b'+Date.now(); boards.push({id,name:String(name||('경기 '+(boards.length+1))).slice(0,24),config:BLANK(),themeIdx:boards.length%THEMES}); await setBoards(boards); return res.json({ok:true,id}); }
  const idx=boards.findIndex(x=>x.id===boardId); const b=boards[idx]; if(!b) return res.status(404).json({error:'no_board'});
  if(action==='rename') b.name=String(name||b.name).slice(0,24);
  else if(action==='config'){ if(!config||!Array.isArray(config.rows)||!Array.isArray(config.answerCols)) return res.status(400).json({error:'bad'}); b.config=config; }
  else if(action==='clear'){ await db.execute({sql:`DELETE FROM board_claims_v2 WHERE board_id=?`,args:[boardId]}); }
  else if(action==='duplicate'){ const id='b'+Date.now(); boards.splice(idx+1,0,{id,name:String(name||(b.name+' 복사')).slice(0,24),config:JSON.parse(JSON.stringify(b.config)),themeIdx:boards.length%THEMES}); await setBoards(boards); return res.json({ok:true,id}); }
  else if(action==='move'){ const j=idx+(req.body.dir<0?-1:1); if(j<0||j>=boards.length) return res.json({ok:true}); const tmp=boards[idx]; boards[idx]=boards[j]; boards[j]=tmp; }
  else if(action==='delete'){ if(boards.length<=1) return res.status(400).json({error:'last'}); boards.splice(idx,1); await db.execute({sql:`DELETE FROM board_claims_v2 WHERE board_id=?`,args:[boardId]}); }
  await setBoards(boards); res.json({ok:true}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/reset', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'});
  await db.execute(`DELETE FROM board_claims_v2`); let t=await getTurn(); t.started=false; t.curIdx=0; t.remaining=t.picksPerTurn||1; await setTurn(t);
  if(req.body?.clearPlayers) await setPlayers([]); res.json({ok:true}); }catch(e){res.status(500).json({error:String(e)});}});
app.post('/api/admin/check', async (req,res)=>res.json({ok:(req.body?.pin)===await getPin()}));
app.post('/api/admin/pin', async (req,res)=>{ try{ if(!await auth(req))return res.status(403).json({error:'pin'}); const np=String(req.body?.newPin||'').trim(); if(np.length<4||np.length>20)return res.status(400).json({error:'length'}); await setS('board:admin_pin',np); res.json({ok:true}); }catch(e){res.status(500).json({error:String(e)});}});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
init().then(()=>app.listen(PORT,()=>console.log('▶ friends-board on '+PORT))).catch(e=>{console.error(e);process.exit(1);});
