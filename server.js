'use strict';

// Codec98 话术编解码器（多领域版）—— 零依赖 Node HTTP 服务
// API:
//   GET  /api/domains
//   POST /api/translate  {domainId, text, context?, direction, tone, bossId?, compare?}
//   GET  /api/bosses?domainId=xxx
//   POST /api/bosses     {domainId, name, type, catchphrases[], seedExamples[], radar{}}
//   POST /api/feedback   {bossId, direction, 原话, AI翻译, 准确, 纠正内容?}
//   GET  /api/bosses/:id/corpus

require('./lib/env').loadEnv();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { assemblePrompt } = require('./lib/prompt');
const { decode, llmProvider } = require('./lib/llm');
const store = require('./lib/store');

const PORT = process.env.PORT || 3210;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
  });
}

async function translateOnce({ domain, text, context, direction, tone, bossId }) {
  const boss = bossId ? store.getBoss(bossId) : null;
  const bossEntries = boss ? store.getBossEntries(boss.id) : [];
  const domainCorpus = store.loadDomainCorpus(domain);
  const prompt = assemblePrompt({
    domain, direction, tone, text, context, boss, bossEntries,
    generalCorpus: domainCorpus
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
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // GET /api/bosses/:id/corpus
  const m = url.pathname.match(/^\/api\/bosses\/([^/]+)\/corpus$/);
  if (m && req.method === 'GET') {
    return json(res, 200, { entries: store.getBossEntries(m[1]).slice().reverse() });
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { return await handler(req, res, url); }
    catch (e) { console.error(e); return json(res, 500, { error: e.message }); }
  }
  // 静态文件
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const provider = llmProvider();
  console.log(`Codec98 话术编解码器（多领域版）→ http://localhost:${PORT}`);
  console.log(`模式: ${provider ? `LLM在线（${provider}）` : '演示降级（无API key，本地兜底）'}`);
});
