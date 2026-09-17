'use strict';

// Codec98 话术编解码器（多领域版）—— 零依赖 Node HTTP 服务
// API:
//   GET  /api/domains
//   POST /api/translate  {domainId, text, context?, direction, tone, bossId?, compare?}
//   GET  /api/bosses?domainId=xxx
//   POST /api/bosses     {domainId, name, type, catchphrases[], seedExamples[], radar{}}
//   POST /api/feedback   {bossId, direction, 原话, AI翻译, 准确, 纠正内容?}
//   GET  /api/bosses/:id/corpus
//   GET  /api/chats?domainId=xxx&bossId=yyy      会话列表
//   GET  /api/chats/:id                          单个会话（含消息）
//   POST /api/chats      {domainId, bossId?}     新建会话
//   POST /api/chats/:id/message {role, text, tone?}  追加消息；role=them 时同时返回解码结果
//   GET  /api/forum?domainId=xxx                 帖子列表
//   POST /api/forum      {domainId, author?, 原话, 场景?, 潜台词, 应对?}
//   POST /api/forum/:id/like                     点赞
//   POST /api/forum/:id/adopt                    收入本地语料库（参与后续解码）
//   POST /api/forum/:id/unadopt                  取消收入

require('./lib/env').loadEnv();

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { assemblePrompt } = require('./lib/prompt');
const { decode, llmProvider } = require('./lib/llm');
const store = require('./lib/store');

const PORT = process.env.PORT || 3210;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const BASE_PREFIX = '/Codec98';

function stripBasePath(pathname) {
  if (pathname === BASE_PREFIX || pathname === BASE_PREFIX + '/') return '/';
  if (pathname.startsWith(BASE_PREFIX + '/')) return pathname.slice(BASE_PREFIX.length) || '/';
  return pathname;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let tooBig = false;
    req.on('data', c => {
      buf += c;
      if (buf.length > 1e6 && !tooBig) { tooBig = true; reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => { if (!tooBig) { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } } });
    req.on('error', e => reject(e));
  });
}

// 单字段长度上限：超长文本会被存进 JSON 反复重写，还会注入后续每次解码的 prompt
const LIMITS = { 原话: 500, 潜台词: 500, 场景: 300, 应对: 500, author: 30, text: 2000, context: 500 };
function tooLong(fields) {
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === 'string' && val.length > (LIMITS[key] || 2000)) return `「${key}」超过 ${LIMITS[key]} 字上限`;
  }
  return null;
}

async function translateOnce({ domain, text, context, direction, tone, bossId, history }) {
  const boss = bossId ? store.getBoss(bossId) : null;
  const bossEntries = boss ? store.getBossEntries(boss.id) : [];
  const domainCorpus = store.loadDomainCorpus(domain);
  const prompt = assemblePrompt({
    domain, direction, tone, text, context, boss, bossEntries,
    generalCorpus: domainCorpus,
    adopted: store.getAdopted(domain.id),
    history
  });
  const { result, source } = await decode(prompt, { domain, direction, tone, text, boss, domainCorpus });
  return { ...result, _source: source, _boss: boss ? { id: boss.id, name: boss.name, type: boss.type } : null };
}

const routes = {
  'GET /api/domains': async (req, res) => {
    json(res, 200, { domains: store.loadDomains(), provider: llmProvider() });
  },

  'POST /api/translate': async (req, res) => {
    const b = await readBody(req);
    if (!b.text || !b.text.trim()) return json(res, 400, { error: '原话不能为空' });
    const lenErr = tooLong({ text: b.text, context: b.context || '' });
    if (lenErr) return json(res, 400, { error: lenErr });
    const domain = store.getDomain(b.domainId);
    if (!domain) return json(res, 500, { error: '领域配置缺失' });
    const base = {
      domain,
      text: b.text.trim(), context: (b.context || '').trim(),
      direction: b.direction === 'reverse' ? 'reverse' : 'forward',
      tone: ['safe', 'neutral', 'brave'].includes(b.tone) ? b.tone : 'neutral'
    };
    // compare 模式：通用 vs 专属并排（demo第三幕）
    if (b.compare && b.bossId) {
      const [generic, custom] = await Promise.all([
        translateOnce({ ...base, bossId: null }),
        translateOnce({ ...base, bossId: b.bossId })
      ]);
      return json(res, 200, { compare: true, generic, custom });
    }
    const result = await translateOnce({ ...base, bossId: b.bossId || null });
    json(res, 200, result);
  },

  'GET /api/bosses': async (req, res, url) => {
    const domainId = url.searchParams.get('domainId');
    const { bosses } = store.loadBosses();
    const filtered = domainId
      ? bosses.filter(b => (b.domainId || 'workplace') === domainId)
      : bosses;
    const withLevel = filtered.map(b => {
      const n = store.getBossEntries(b.id).length;
      return { ...b, entryCount: n, level: Math.min(9, 1 + Math.floor(n / 2)) };
    });
    json(res, 200, { bosses: withLevel });
  },

  'POST /api/bosses': async (req, res) => {
    const b = await readBody(req);
    if (!b.name || !b.type) return json(res, 400, { error: 'name和type必填' });
    const boss = {
      id: 'boss_' + Math.random().toString(36).slice(2, 8),
      domainId: b.domainId || 'workplace',
      name: b.name, type: b.type,
      avatar: b.avatar || '👔', title: b.title || b.type,
      catchphrases: b.catchphrases || [],
      radar: b.radar || {},
      seedExamples: b.seedExamples || [],
      createdAt: new Date().toISOString()
    };
    store.addBoss(boss);
    json(res, 200, { boss });
  },

  'POST /api/feedback': async (req, res) => {
    const b = await readBody(req);
    if (!b.bossId) return json(res, 400, { error: '仅专属模式支持反馈' });
    store.addEntry({
      bossId: b.bossId,
      direction: b.direction || 'forward',
      原话: b.原话 || '',
      AI翻译: b.AI翻译 || '',
      被纠正: !b.准确,
      纠正内容: b.准确 ? null : (b.纠正内容 || ''),
      time: new Date().toISOString()
    });
    const n = store.getBossEntries(b.bossId).length;
    json(res, 200, { ok: true, entryCount: n, level: Math.min(9, 1 + Math.floor(n / 2)) });
  },

  'GET /api/chats': async (req, res, url) => {
    const sessions = store.listSessions(url.searchParams.get('domainId'), url.searchParams.get('bossId') || '');
    json(res, 200, {
      sessions: sessions.map(s => ({ id: s.id, title: s.title, bossId: s.bossId, updatedAt: s.updatedAt, count: s.messages.length }))
    });
  },

  'POST /api/chats': async (req, res) => {
    const b = await readBody(req);
    const domain = store.getDomain(b.domainId);
    if (!domain) return json(res, 400, { error: '领域配置缺失' });
    json(res, 200, { session: store.createSession({ domainId: domain.id, bossId: b.bossId || null }) });
  },

  'GET /api/forum': async (req, res, url) => {
    json(res, 200, { posts: store.listPosts(url.searchParams.get('domainId')) });
  },

  'POST /api/forum': async (req, res) => {
    const b = await readBody(req);
    if (!b.原话 || !b.潜台词) return json(res, 400, { error: '原话和潜台词必填' });
    const lenErr = tooLong({ 原话: b.原话, 潜台词: b.潜台词, 场景: b.场景 || '', 应对: b.应对 || '', author: b.author || '' });
    if (lenErr) return json(res, 400, { error: lenErr });
    const post = store.addPost({
      domainId: b.domainId || 'workplace',
      author: (b.author || '').trim() || '匿名网友',
      原话: b.原话.trim(), 场景: (b.场景 || '').trim(),
      潜台词: b.潜台词.trim(), 应对: (b.应对 || '').trim()
    });
    json(res, 200, { post });
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === BASE_PREFIX) {
    res.writeHead(308, { location: BASE_PREFIX + '/' + url.search });
    return res.end();
  }
  url.pathname = stripBasePath(url.pathname);
  // GET /api/bosses/:id/corpus
  const m = url.pathname.match(/^\/api\/bosses\/([^/]+)\/corpus$/);
  if (m && req.method === 'GET') {
    return json(res, 200, { entries: store.getBossEntries(m[1]).slice().reverse() });
  }
  // 带路径参数的会话/论坛路由
  try {
    const mChat = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (mChat && req.method === 'GET') {
      const s = store.getSession(mChat[1]);
      return s ? json(res, 200, { session: s }) : json(res, 404, { error: '会话不存在' });
    }
    const mMsg = url.pathname.match(/^\/api\/chats\/([^/]+)\/message$/);
    if (mMsg && req.method === 'POST') {
      const b = await readBody(req);
      const session = store.getSession(mMsg[1]);
      if (!session) return json(res, 404, { error: '会话不存在' });
      if (!b.text || !b.text.trim()) return json(res, 400, { error: '消息不能为空' });
      const lenErr = tooLong({ text: b.text });
      if (lenErr) return json(res, 400, { error: lenErr });
      const role = b.role === 'me' ? 'me' : 'them';
      const text = b.text.trim();
      const msg = { role, text, time: new Date().toISOString() };
      if (role === 'them') {
        // 对方的消息 → 结合会话历史解码
        const domain = store.getDomain(session.domainId);
        const decoded = await translateOnce({
          domain, text, context: '',
          direction: 'forward',
          tone: ['safe', 'neutral', 'brave'].includes(b.tone) ? b.tone : 'neutral',
          bossId: session.bossId,
          history: session.messages
        });
        msg.decoded = decoded;
      }
      const updated = store.appendMessage(session.id, msg);
      return json(res, 200, { message: msg, session: { id: updated.id, title: updated.title } });
    }
    const mLike = url.pathname.match(/^\/api\/forum\/([^/]+)\/like$/);
    if (mLike && req.method === 'POST') {
      const p = store.likePost(mLike[1]);
      return p ? json(res, 200, { post: p }) : json(res, 404, { error: '帖子不存在' });
    }
    const mAdopt = url.pathname.match(/^\/api\/forum\/([^/]+)\/(adopt|unadopt)$/);
    if (mAdopt && req.method === 'POST') {
      const p = mAdopt[2] === 'adopt' ? store.adoptPost(mAdopt[1]) : store.unadoptPost(mAdopt[1]);
      return p ? json(res, 200, { post: p }) : json(res, 404, { error: '帖子不存在' });
    }
  } catch (e) {
    console.error(e);
    return json(res, e.status === 413 ? 413 : 500, { error: e.status === 413 ? e.message : '服务内部错误' });
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { return await handler(req, res, url); }
    catch (e) { console.error(e); return json(res, e.status === 413 ? 413 : 500, { error: e.status === 413 ? e.message : '服务内部错误' }); }
  }
  // 静态文件
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  serveStatic(req, res, full);
});

// 静态资源：内存缓存（mtime 失效）+ ETag 协商缓存 + gzip
const staticCache = new Map(); // fullPath -> { mtimeMs, etag, raw, gz, type }
function serveStatic(req, res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
    const hit = staticCache.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs) return sendStatic(req, res, hit);
    fs.readFile(full, (err2, raw) => {
      if (err2) { res.writeHead(404); return res.end('404'); }
      const type = MIME[path.extname(full)] || 'application/octet-stream';
      const entry = {
        mtimeMs: st.mtimeMs,
        etag: `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`,
        raw,
        gz: /^(text\/|application\/json|image\/svg)/.test(type) ? zlib.gzipSync(raw) : null,
        type
      };
      staticCache.set(full, entry);
      sendStatic(req, res, entry);
    });
  });
}
function sendStatic(req, res, entry) {
  const headers = {
    'content-type': entry.type,
    'etag': entry.etag,
    'cache-control': 'no-cache'  // 每次协商，命中 ETag 时 304 不传 body
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const body = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '') ? entry.gz : entry.raw;
  if (body === entry.gz) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(body);
}

server.listen(PORT, () => {
  const provider = llmProvider();
  console.log(`Codec98 话术编解码器（多领域版）→ http://localhost:${PORT}`);
  console.log(`模式: ${provider ? `LLM在线（${provider}）` : '本地引擎（未配置API key）'}`);
});
