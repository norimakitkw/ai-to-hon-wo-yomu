// しおりの問い返しだけを作る小さなサーバー。
// - Anthropic のキーはこのサーバーにだけ置く。公開のページには置かない。
// - 受け取るのは、学年・本の題名・質問と答えだけ。AI への指示文はここで組み立てるので、ほかの用途には使えない。
// - 子どもの答えはどこにも保存しない。ログに残すのは時刻・結果・かかった時間だけ。
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {askFollowup, FU_SCHEMA, MODEL_SERVER} from '../ai-followup.mjs';

const PORT = +(process.env.PORT || 8790);
const ORIGINS = new Set(['https://norimakitkw.github.io', 'http://localhost:4184']);
// 1 クラスが同じ学校の回線から一斉に使っても止まらない数。費用の歯止めは 1 日の上限と、Anthropic のコンソールの使用上限
const LIMIT = {perIpMin: 60, allMin: 120, allDay: 2000};
// 文字数の上限。日本語は 1 文字 3 バイトなので、中身全体の上限はそれが全部埋まっても収まる大きさにする
const CAP = {body: 64000, title: 100, status: 20, grade: 20, prev: 6, q: 120, a: 1000};
const KEY_FILE = join(homedir(), '.config', 'ai-to-hon-wo-yomu', 'anthropic-key');

function loadKey(){
  if(process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try{ return readFileSync(KEY_FILE, 'utf8').trim(); }catch{ return ''; }
}
const apiKey = loadKey();
if(!apiKey){ console.error(`Anthropic のキーが見つかりません。${KEY_FILE} に入れてください（server/README.md）。`); process.exit(1); }
const client = new Anthropic({apiKey, timeout: 20000, maxRetries: 1});

async function ask(system, messages){
  const res = await client.messages.create({model: MODEL_SERVER, max_tokens: 2048, system, messages,
    output_config: {effort: 'low', format: {type: 'json_schema', schema: FU_SCHEMA}}});
  if(res.stop_reason !== 'end_turn') throw new Error(res.stop_reason === 'refusal' ? 'AIが答えるのを断りました' : `返事が途中で止まりました（${res.stop_reason}）`);
  return {out: JSON.parse(res.content.find(b => b.type === 'text')?.text || '{}'), reply: {role: 'assistant', content: res.content}};
}
// Anthropic 側の失敗を、子どもの画面の記録に残せる短い日本語にする
function explain(e){
  if(e instanceof Anthropic.AuthenticationError) return [502, 'サーバーのキーが正しくありません'];
  if(e instanceof Anthropic.PermissionDeniedError) return [502, 'サーバーのキーでは使えません'];
  if(e instanceof Anthropic.RateLimitError) return [503, 'Claude が混み合っています'];
  if(e instanceof Anthropic.APIConnectionTimeoutError) return [504, '時間切れ（20秒）'];
  if(e instanceof Anthropic.APIConnectionError) return [502, 'サーバーから Claude につながりませんでした'];
  if(e instanceof Anthropic.APIError) return [502, `Claude のエラー（${e.status ?? '?'}）`];
  if(e instanceof SyntaxError) return [502, 'AIの返事を読めませんでした'];
  return [500, String(e.message || e).slice(0, 100)];
}

// 回数の上限（メモリの中だけ。サーバーを立て直すと数え直し）
const hits = new Map();
let recent = [], day = {date: '', n: 0};
function overLimit(ip){
  const now = Date.now(), today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'});
  if(day.date !== today) day = {date: today, n: 0};
  if(day.n >= LIMIT.allDay) return '今日の上限に達しました';
  recent = recent.filter(t => now - t < 60000);
  if(recent.length >= LIMIT.allMin) return '混み合っています';
  const mine = (hits.get(ip) || []).filter(t => now - t < 60000);
  if(mine.length >= LIMIT.perIpMin) return '呼び出しが多すぎます';
  mine.push(now); hits.set(ip, mine); recent.push(now); day.n++;
  return '';
}
setInterval(() => { const now = Date.now(); for(const [ip, ts] of hits) if(!ts.some(t => now - t < 60000)) hits.delete(ip); }, 60000).unref();

// 決まった形・決まった長さの中身だけを通す
function readCtx(j){
  const str = (v, max) => typeof v === 'string' && [...v].length <= max ? v : null;   // ページと同じく文字（コードポイント）で数える
  if(!j || typeof j !== 'object' || !Array.isArray(j.prev) || j.prev.length > CAP.prev) return null;
  const ctx = {title: str(j.title, CAP.title), status: str(j.status ?? '', CAP.status), grade: str(j.grade ?? '', CAP.grade),
    question: str(j.question, CAP.q), answer: str(j.answer, CAP.a),
    prev: j.prev.map(p => ({q: str(p?.q, CAP.q), a: str(p?.a ?? '', CAP.a)}))};
  if([ctx.title, ctx.status, ctx.grade, ctx.question, ctx.answer].includes(null) || !ctx.answer.trim()) return null;
  if(ctx.prev.some(p => p.q === null || p.a === null)) return null;
  return ctx;
}
function readBody(req){
  return new Promise(ok => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if(n > CAP.body) ok(null); else chunks.push(c); });   // 上限を超えたら読み捨てて、413 を返してから切る
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => ok(null));
  });
}
const log = (status, what, ms='') => console.log(`${new Date().toISOString()} ${status} ${what}${ms === '' ? '' : ' ' + ms + 'ms'}`);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = ORIGINS.has(origin) ? {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin'} : {'Vary': 'Origin'};
  const send = (code, obj) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors}); res.end(JSON.stringify(obj)); };
  const path = (req.url || '').split('?')[0];

  if(req.method === 'GET' && path === '/health') return send(200, {ok: true, model: MODEL_SERVER});
  if(path !== '/followup') return send(404, {error: '見つかりません'});
  if(!ORIGINS.has(origin)){ log(403, 'origin'); return send(403, {error: 'このページからは使えません'}); }
  if(req.method === 'OPTIONS'){
    res.writeHead(204, {...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600'});
    return res.end();
  }
  if(req.method !== 'POST') return send(405, {error: 'POST だけ受けつけます'});

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const why = overLimit(ip);
  if(why){ log(429, 'limit'); return send(429, {error: why}); }

  const body = await readBody(req);
  if(body === null){ log(413, 'too-large'); res.setHeader('Connection', 'close'); res.on('finish', () => req.socket?.destroy()); return send(413, {error: '中身が大きすぎます'}); }
  let ctx = null;
  try{ ctx = readCtx(JSON.parse(body)); }catch{}
  if(!ctx){ log(400, 'bad-input'); return send(400, {error: '送られてきた中身の形が違います'}); }

  const t0 = Date.now();
  try{
    const r = await askFollowup(ctx, ask);
    log(200, r.ask ? (r.issues.length ? 'skip' : 'ask') : 'pass', Date.now() - t0);
    send(200, {ask: r.ask, text: r.text.slice(0, 200), issues: r.issues, fixed: r.fixed});
  }catch(e){
    const [code, msg] = explain(e);
    log(code, e?.constructor?.name || 'Error', Date.now() - t0);
    send(code, {error: msg});
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`${new Date().toISOString()} listening on 127.0.0.1:${PORT} (${MODEL_SERVER})`));
