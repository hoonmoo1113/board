import express from 'express';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
const getBoards=()=>J('board:boards',[]), setBoards=b=>setS('board:boards',JSON.stringify(b));
const getPlayers=()=>J('board:players',[]), setPlayers=p=>setS('board:players',JSON.stringify(p));
const getTurn=()=>J('board:turn',NEW_TURN()), setTurn=t=>setS('board:turn',JSON.stringify(t));

async function init(){
  await db.execute(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS board_claims(board_id TEXT, cell TEXT, player_id TEXT, ts INTEGER, PRIMARY KEY(board_id,cell))`);
  if(!(await getBoards()).length) await setBoards([{ id:'b1', name:'경기 1', config: DEMO_CONFIG }]);
  if(!(await getS('board:turn'))) await setTurn(NEW_TURN());
  if(!(await getS('board:players'))) await setPlayers([]);
}
async function claimsMap(){ const r=await db.execute(`SELECT board_id,cell,player_id FROM board_claims`); const m={}; r.rows.forEach(x=>{(m[x.board_id]=m[x.board_id]||{})[x.cell]=x.player_id;}); return m; }
function validCell(cell,cfg){ const m=/^(\d+)_(\d+)$/.exec(cell||''); if(!m)return false; const r=+m[1],a=+m[2]; return r>=0&&r<cfg.rows.length&&a>=0&&a<cfg.answerCols.length; }
function advance(t,players){ t.remaining=(t.remaining||1)-1; if(t.remaining<=0){ t.curIdx=(t.curIdx+1)%players.length; t.remaining=t.picksPerTurn||1; } }

app.get('/api/state', async (req,res)=>{
  try{ res.json({ boards: await getBoards(), players: await getPlayers(), turn: await getTurn(), claims: await claimsMap(), palette: PALETTE }); }
  catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/claim', async (req,res)=>{
  try{ const { boardId, cell } = req.body||{};
    const boards=await getBoards(), players=await getPlayers(), turn=await getTurn();
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(!turn.started) return res.status(409).json({error:'not_started'});
    if(!players.length) return res.status(409).json({error:'no_players'});
    if(!validCell(cell,b.config)) return res.status(400).json({error:'bad_cell'});
    const cur=players[turn.curIdx%players.length];
    const ex=await db.execute({sql:`SELECT 1 FROM board_claims WHERE board_id=? AND cell=?`,args:[boardId,cell]});
    if(ex.rows.length) return res.status(409).json({error:'taken'});
    await db.execute({sql:`INSERT INTO board_claims(board_id,cell,player_id,ts) VALUES(?,?,?,?)`,args:[boardId,cell,cur.id,Date.now()]});
    advance(turn,players); await setTurn(turn); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/turn', async (req,res)=>{
  try{ const {action,patch}=req.body||{}; const players=await getPlayers(); let t=await getTurn();
    if(action==='start'){ t.started=true; t.curIdx=0; t.remaining=t.picksPerTurn||1; }
    else if(action==='pass'){ if(players.length){ t.curIdx=(t.curIdx+1)%players.length; t.remaining=t.picksPerTurn||1; } }
    else if(patch){ if(patch.picksPerTurn!=null){ t.picksPerTurn=Math.max(1,+patch.picksPerTurn); t.remaining=t.picksPerTurn; }
      if(patch.remaining!=null)t.remaining=Math.max(1,+patch.remaining);
      if(patch.curIdx!=null&&players.length)t.curIdx=((+patch.curIdx)%players.length+players.length)%players.length; }
    await setTurn(t); res.json({ok:true,turn:t});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/undo', async (req,res)=>{
  try{ const players=await getPlayers();
    const last=await db.execute(`SELECT board_id,cell,player_id FROM board_claims ORDER BY ts DESC LIMIT 1`);
    if(!last.rows.length) return res.json({ok:true,empty:true});
    const {board_id,cell,player_id}=last.rows[0];
    await db.execute({sql:`DELETE FROM board_claims WHERE board_id=? AND cell=?`,args:[board_id,cell]});
    let t=await getTurn(); const i=players.findIndex(p=>p.id===player_id);
    if(i>=0){ t.curIdx=i; t.remaining=1; t.started=true; await setTurn(t); }
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/unclaim', async (req,res)=>{
  try{ const {boardId,cell}=req.body||{}; await db.execute({sql:`DELETE FROM board_claims WHERE board_id=? AND cell=?`,args:[boardId,cell]}); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/players', async (req,res)=>{
  try{ const p=req.body?.players; if(!Array.isArray(p)) return res.status(400).json({error:'bad'});
    const used=new Set(); p.forEach((pl,i)=>{ if(!pl.id)pl.id='p-'+Date.now()+'-'+i+'-'+Math.random().toString(16).slice(2,5); if(!pl.color){pl.color=PALETTE.find(c=>!used.has(c))||PALETTE[i%PALETTE.length];} used.add(pl.color); pl.name=String(pl.name||('P'+(i+1))).slice(0,16); });
    await setPlayers(p); res.json({ok:true,players:p});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/board', async (req,res)=>{
  try{ const {action,boardId,name,config}=req.body||{}; const boards=await getBoards();
    if(action==='add'){ const id='b'+Date.now(); boards.push({id,name:String(name||('경기 '+(boards.length+1))).slice(0,24),config:BLANK_CONFIG()}); await setBoards(boards); return res.json({ok:true,id}); }
    const b=boards.find(x=>x.id===boardId); if(!b) return res.status(404).json({error:'no_board'});
    if(action==='rename') b.name=String(name||b.name).slice(0,24);
    else if(action==='config'){ if(!config||!Array.isArray(config.rows)||!Array.isArray(config.answerCols)) return res.status(400).json({error:'bad'}); b.config=config; }
    else if(action==='clear'){ await db.execute({sql:`DELETE FROM board_claims WHERE board_id=?`,args:[boardId]}); }
    else if(action==='delete'){ if(boards.length<=1) return res.status(400).json({error:'last'}); boards.splice(boards.findIndex(x=>x.id===boardId),1); await db.execute({sql:`DELETE FROM board_claims WHERE board_id=?`,args:[boardId]}); }
    await setBoards(boards); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.post('/api/reset', async (req,res)=>{
  try{ await db.execute(`DELETE FROM board_claims`); let t=await getTurn(); t.started=false; t.curIdx=0; t.remaining=t.picksPerTurn||1; await setTurn(t);
    if(req.body?.clearPlayers) await setPlayers([]); res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e)}); }
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
init().then(()=>app.listen(PORT,()=>console.log('▶ board on '+PORT))).catch(e=>{console.error(e);process.exit(1);});
