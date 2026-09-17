'use strict';

// 数据层：JSON 文件读写（黑客松规格，单用户）
// 目录约定：
//   data/       —— 只读配置与种子（domains、通用语料、演示档案），随仓库分发
//   data/user/  —— 用户真实积累（档案/纠错语料/会话/论坛），本地持久化，已 gitignore
// 首次运行时把种子复制进 data/user/，之后所有写操作只落在 user 目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function resolveUserDir() {
  const tmpDir = path.join(os.tmpdir(), 'codec98-user');
  // Vercel 函数文件系统只读；没标 VERCEL 时也探测一下，避免生产被 main 覆盖后整站 500
  if (process.env.VERCEL) return tmpDir;
  const local = path.join(DATA, 'user');
  try {
    fs.mkdirSync(local, { recursive: true });
    fs.accessSync(local, fs.constants.W_OK);
    return local;
  } catch {
    return tmpDir;
  }
}

const USER = resolveUserDir();

// 用户可写文件 → 对应的种子文件
const SEEDS = {
  'bosses.json': 'bosses.json',
  'corpus.json': 'corpus.json',
  'forum.json': 'forum_seed.json'
};

(function ensureUserDir() {
  fs.mkdirSync(USER, { recursive: true });
  for (const [file, seed] of Object.entries(SEEDS)) {
    const dst = path.join(USER, file);
    const src = path.join(DATA, seed);
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
})();

// mtime 缓存：同一个文件在未被修改时不重复读盘/解析。
// /api/bosses 这类接口一次请求会读同一文件 N 次，无缓存时全是重复 IO。
const fileCache = new Map(); // fullPath -> { mtimeMs, data }
function readJSON(dir, file, fallback) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return fallback;
  try {
    const mtimeMs = fs.statSync(full).mtimeMs;
    const hit = fileCache.get(full);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    fileCache.set(full, { mtimeMs, data });
    return data;
  } catch (e) {
    // 文件损坏时保留现场再降级：直接返回 fallback 会在下次写入时把用户积累清空
    try { fs.copyFileSync(full, full + '.bak'); } catch { /* 备份失败不阻塞 */ }
    console.error(`[store] ${file} 解析失败，已备份为 ${file}.bak：${e.message}`);
    return fallback;
  }
}
const readData = (f, fb) => readJSON(DATA, f, fb);
const readUser = (f, fb) => readJSON(USER, f, fb);
function writeUser(file, obj) {
  const full = path.join(USER, file);
  // 先写临时文件再重命名：进程中途崩溃不会留下截断的 JSON
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, full);
  try { fileCache.set(full, { mtimeMs: fs.statSync(full).mtimeMs, data: obj }); }
  catch { fileCache.delete(full); }
}

const uid = prefix => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---- 领域（版）配置：只读 ----
const loadDomains = () => readData('domains.json', { domains: [] }).domains;
function getDomain(id) {
  const domains = loadDomains();
  return domains.find(d => d.id === id) || domains[0] || null;
}
// 该领域的通用语料包：只读
function loadDomainCorpus(domain) {
  return readData(domain.corpusFile, {});
}

// ---- 人物档案与纠错语料：用户积累 ----
const loadBosses = () => readUser('bosses.json', { bosses: [] });
const saveBosses = d => writeUser('bosses.json', d);
const loadCorpus = () => readUser('corpus.json', { entries: [] });
const saveCorpus = d => writeUser('corpus.json', d);

function getBoss(id) {
  return loadBosses().bosses.find(b => b.id === id) || null;
}
function getBossEntries(bossId) {
  return loadCorpus().entries.filter(e => e.bossId === bossId);
}
function addEntry(entry) {
  const c = loadCorpus();
  c.entries.push(entry);
  saveCorpus(c);
}
function addBoss(boss) {
  const d = loadBosses();
  d.bosses.push(boss);
  saveBosses(d);
}

// ---- 连续对话会话：用户积累 ----
const loadChats = () => readUser('chats.json', { sessions: [] });
const saveChats = d => writeUser('chats.json', d);

function listSessions(domainId, bossId) {
  return loadChats().sessions
    .filter(s => s.domainId === domainId && (s.bossId || '') === (bossId || ''))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
function getSession(id) {
  return loadChats().sessions.find(s => s.id === id) || null;
}
function createSession({ domainId, bossId, title }) {
  const d = loadChats();
  const session = {
    id: uid('chat'),
    domainId, bossId: bossId || null,
    title: title || '新会话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: []
  };
  d.sessions.push(session);
  saveChats(d);
  return session;
}
function appendMessage(sessionId, msg) {
  const d = loadChats();
  const s = d.sessions.find(x => x.id === sessionId);
  if (!s) return null;
  s.messages.push(msg);
  s.updatedAt = new Date().toISOString();
  // 会话标题取第一条消息前几个字，方便回看
  if (s.title === '新会话' && msg.text) s.title = msg.text.slice(0, 12);
  saveChats(d);
  return s;
}

// ---- 弦外之音BBS：用户积累（种子帖首次运行复制进来） ----
const loadForum = () => readUser('forum.json', { posts: [] });
const saveForum = d => writeUser('forum.json', d);

function listPosts(domainId) {
  const posts = loadForum().posts;
  // 复制后再排序：posts 可能是缓存里的原数组，原地 sort 会污染缓存
  const filtered = domainId ? posts.filter(p => p.domainId === domainId) : posts.slice();
  return filtered.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}
function addPost(post) {
  const d = loadForum();
  // 服务端字段放在展开之后：id/likes/adopted/time 不允许被调用方覆盖
  const full = { ...post, id: uid('post'), likes: 0, adopted: false, time: new Date().toISOString() };
  d.posts.unshift(full);
  saveForum(d);
  return full;
}
function likePost(id) {
  const d = loadForum();
  const p = d.posts.find(x => x.id === id);
  if (!p) return null;
  p.likes = (p.likes || 0) + 1;
  saveForum(d);
  return p;
}

// 收入语料库：帖子内容进入 adopted.json，之后该领域的每次解码都会注入
const loadAdopted = () => readUser('adopted.json', { entries: [] });
const saveAdopted = d => writeUser('adopted.json', d);

function adoptPost(id) {
  const d = loadForum();
  const p = d.posts.find(x => x.id === id);
  if (!p) return null;
  if (!p.adopted) {
    // 先写 adopted.json 再翻标记：中途失败时按钮仍在，重试即可自愈
    const a = loadAdopted();
    a.entries.push({
      postId: p.id, domainId: p.domainId,
      原话: p.原话, 场景: p.场景 || '', 潜台词: p.潜台词, 应对: p.应对 || '',
      source: 'forum', time: new Date().toISOString()
    });
    saveAdopted(a);
    p.adopted = true;
    saveForum(d);
  }
  return p;
}
function unadoptPost(id) {
  const d = loadForum();
  const p = d.posts.find(x => x.id === id);
  if (!p) return null;
  if (p.adopted) {
    const a = loadAdopted();
    a.entries = a.entries.filter(e => e.postId !== id);
    saveAdopted(a);
    p.adopted = false;
    saveForum(d);
  }
  return p;
}
function getAdopted(domainId) {
  return loadAdopted().entries.filter(e => e.domainId === domainId);
}

module.exports = {
  loadDomains, getDomain, loadDomainCorpus,
  loadBosses, getBoss, getBossEntries, addEntry, addBoss,
  listSessions, getSession, createSession, appendMessage,
  listPosts, addPost, likePost, adoptPost, unadoptPost, getAdopted
};
