'use strict';

// 公共论坛。所有访客读写同一块看板。
// 持久化顺序：Upstash Redis（若配置）→ Vercel Blob（若配置）→ 本地 JSON 文件。
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), 'codec98-board.json')
  : path.join(__dirname, '..', 'data', 'shared', 'board.json');
const REDIS_KEY = 'codec98:board';
const BLOB_PATH = 'codec98/board.json';
const MAX_POSTS = 300;

let cache = null;
let blobUrl = process.env.CODEC98_BOARD_URL || '';
let chain = Promise.resolve();

function empty() { return { posts: [] }; }

function uid() {
  return 'post_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && Array.isArray(data.posts)) return data;
  } catch { /* 首次运行还没有看板文件 */ }
  return empty();
}

function writeFile(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[board] 文件写入失败：' + e.message);
  }
}

function redisReady() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redis(command) {
  const resp = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!resp.ok) throw new Error('Redis ' + resp.status);
  return resp.json();
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || '';
}

function blobPublicUrl() {
  if (blobUrl) return blobUrl;
  const token = blobToken();
  const m = token.match(/^vercel_blob_rw_([a-z0-9]+)_[a-z0-9]+$/i);
  if (!m) return '';
  return `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com/${BLOB_PATH}`;
}

async function blobPut(data) {
  const token = blobToken();
  if (!token) return;
  const url = new URL('https://vercel.com/api/blob');
  url.searchParams.set('pathname', BLOB_PATH);
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer ' + token,
      'x-api-version': '7',
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1'
    },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error('Blob ' + resp.status);
  const saved = await resp.json();
  if (saved && saved.url) blobUrl = saved.url;
}

async function hydrate() {
  if (redisReady()) {
    try {
      const out = await redis(['GET', REDIS_KEY]);
      if (out && out.result) {
        const data = JSON.parse(out.result);
        if (data && Array.isArray(data.posts)) { cache = data; return cache; }
      }
    } catch (e) { console.error('[board] Redis 读取失败：' + e.message); }
  }
  const pub = blobPublicUrl();
  if (pub && blobToken()) {
    try {
      const resp = await fetch(pub, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.posts)) { cache = data; blobUrl = pub; return cache; }
      }
    } catch (e) { console.error('[board] Blob 读取失败：' + e.message); }
  }
  cache = readFile();
  return cache;
}

async function persist(data) {
  cache = data;
  writeFile(data);
  if (redisReady()) {
    try { await redis(['SET', REDIS_KEY, JSON.stringify(data)]); }
    catch (e) { console.error('[board] Redis 写入失败：' + e.message); }
  }
  if (blobToken()) {
    try { await blobPut(data); }
    catch (e) { console.error('[board] Blob 写入失败：' + e.message); }
  }
}

function run(fn) {
  const job = chain.then(async () => {
    if (!cache) await hydrate();
    return fn(cache);
  });
  chain = job.then(() => {}, () => {});
  return job;
}

function list(domainId) {
  return run(data => {
    const rows = domainId ? data.posts.filter(p => p.domainId === domainId) : data.posts.slice();
    return rows.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  });
}

function add(post) {
  return run(async data => {
    const full = {
      id: uid(),
      domainId: post.domainId || 'workplace',
      author: post.author || '匿名网友',
      原话: post.原话,
      场景: post.场景 || '',
      潜台词: post.潜台词,
      应对: post.应对 || '',
      likes: 0,
      time: new Date().toISOString()
    };
    data.posts.unshift(full);
    if (data.posts.length > MAX_POSTS) data.posts.length = MAX_POSTS;
    await persist(data);
    return full;
  });
}

function like(id) {
  return run(async data => {
    const post = data.posts.find(p => p.id === id);
    if (!post) return null;
    post.likes = (post.likes || 0) + 1;
    await persist(data);
    return post;
  });
}

module.exports = { list, add, like };
