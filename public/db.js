'use strict';

// Codec98 本机数据库：人物档案 / 纠错语料 / 会话 / 论坛都存在浏览器 IndexedDB。
// 换设备或清站点数据会丢，所以提供导出 / 导入备份。

const DB_NAME = 'codec98';
const DB_VERSION = 1;
const LIMITS = { 原话: 500, 潜台词: 500, 场景: 300, 应对: 500, author: 30, text: 2000, name: 40, title: 40 };
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function clip(s, n) {
  return typeof s === 'string' ? s.slice(0, n) : '';
}

function dbError(e) {
  if (e && e.name === 'QuotaExceededError') return new Error('本机存储空间不足，请先导出备份再清理');
  return e instanceof Error ? e : new Error(String(e && e.message || e || '本机数据库错误'));
}

function bossLevel(n) {
  return Math.min(9, 1 + Math.floor((n || 0) / 2));
}

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bosses')) {
        db.createObjectStore('bosses', { keyPath: 'id' }).createIndex('domainId', 'domainId', { unique: false });
      }
      if (!db.objectStoreNames.contains('corpus')) {
        db.createObjectStore('corpus', { keyPath: 'id' }).createIndex('bossId', 'bossId', { unique: false });
      }
      if (!db.objectStoreNames.contains('chats')) {
        db.createObjectStore('chats', { keyPath: 'id' }).createIndex('domainBoss', 'domainBoss', { unique: false });
      }
      if (!db.objectStoreNames.contains('forum')) {
        db.createObjectStore('forum', { keyPath: 'id' }).createIndex('domainId', 'domainId', { unique: false });
      }
      if (!db.objectStoreNames.contains('adopted')) {
        db.createObjectStore('adopted', { keyPath: 'id' }).createIndex('domainId', 'domainId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(dbError(req.error || new Error('无法打开本机数据库')));
    };
  });
  return dbPromise;
}

function withStore(name, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    try {
      const maybe = fn(store);
      if (maybe && typeof maybe.onsuccess !== 'undefined') {
        maybe.onsuccess = () => { result = maybe.result; };
        maybe.onerror = () => reject(maybe.error);
      } else {
        result = maybe;
      }
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(dbError(tx.error));
    tx.onabort = () => reject(dbError(tx.error || new Error('事务已中止')));
  }));
}

function getAll(name) {
  return withStore(name, 'readonly', s => s.getAll());
}

function putAll(name, rows) {
  return withStore(name, 'readwrite', s => {
    for (const row of rows) {
      if (row && row.id != null) s.put(row);
    }
  });
}

function clearStore(name) {
  return withStore(name, 'readwrite', s => s.clear());
}

function domainBossKey(domainId, bossId) {
  return (domainId || '') + '::' + (bossId || '');
}

async function getMeta(key, fallback) {
  const row = await withStore('meta', 'readonly', s => s.get(key));
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  return withStore('meta', 'readwrite', s => s.put({ key, value }));
}

async function ensureSeeded(seeds) {
  if (await getMeta('seeded', false)) return { seeded: false };
  // 上次写入中途失败时不要再生成新 id，否则种子语料会翻倍
  const existing = await getAll('bosses');
  if (existing.length) {
    await setMeta('seeded', true);
    return { seeded: false };
  }
  const bosses = (seeds.bosses || []).map((b, i) => ({ ...b, id: b.id || ('boss_seed_' + i) }));
  const corpus = (seeds.corpus || []).map((e, i) => ({ ...e, id: e.id || ('entry_seed_' + i + '_' + (e.bossId || 'x')) }));
  const forum = (seeds.forum || []).map((p, i) => ({
    ...p,
    id: p.id || ('post_seed_' + i),
    likes: p.likes || 0,
    adopted: false
  }));
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['bosses', 'corpus', 'forum', 'meta'], 'readwrite');
    const now = new Date().toISOString();
    for (const b of bosses) tx.objectStore('bosses').put(b);
    for (const e of corpus) tx.objectStore('corpus').put(e);
    for (const p of forum) tx.objectStore('forum').put(p);
    tx.objectStore('meta').put({ key: 'seeded', value: true });
    tx.objectStore('meta').put({ key: 'seededAt', value: now });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(dbError(tx.error));
  });
  return { seeded: true };
}

async function listBosses(domainId) {
  const bosses = (await getAll('bosses')).filter(b => !domainId || (b.domainId || 'workplace') === domainId);
  const entries = await getAll('corpus');
  return bosses.map(b => {
    const n = entries.filter(e => e.bossId === b.id).length;
    return { ...b, entryCount: n, level: bossLevel(n) };
  });
}

function getBoss(id) {
  return withStore('bosses', 'readonly', s => s.get(id));
}

function addBoss(boss) {
  const full = {
    id: boss.id || uid('boss'),
    domainId: boss.domainId || 'workplace',
    name: clip(boss.name, LIMITS.name),
    type: clip(boss.type, LIMITS.title) || '未分类',
    avatar: clip(boss.avatar, 8) || '👔',
    title: clip(boss.title || boss.type, LIMITS.title),
    catchphrases: (boss.catchphrases || []).slice(0, 12).map(s => clip(String(s), 40)),
    radar: boss.radar || {},
    seedExamples: boss.seedExamples || [],
    createdAt: boss.createdAt || new Date().toISOString()
  };
  return withStore('bosses', 'readwrite', s => s.put(full)).then(() => full);
}

function getBossEntries(bossId) {
  return getAll('corpus').then(rows => rows.filter(e => e.bossId === bossId));
}

function addEntry(entry) {
  const full = {
    id: entry.id || uid('entry'),
    bossId: entry.bossId,
    direction: entry.direction || 'forward',
    原话: clip(entry.原话, LIMITS.原话),
    AI翻译: clip(entry.AI翻译, 500),
    被纠正: !!entry.被纠正,
    纠正内容: entry.纠正内容 ? clip(entry.纠正内容, 500) : null,
    time: entry.time || new Date().toISOString()
  };
  return withStore('corpus', 'readwrite', s => s.put(full)).then(async () => {
    const n = (await getBossEntries(full.bossId)).length;
    return { entry: full, entryCount: n, level: bossLevel(n) };
  });
}

async function listSessions(domainId, bossId) {
  const key = domainBossKey(domainId, bossId);
  const sessions = (await getAll('chats'))
    .filter(s => s.domainBoss === key)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return sessions.map(s => ({
    id: s.id,
    title: s.title,
    bossId: s.bossId,
    updatedAt: s.updatedAt,
    count: (s.messages || []).length
  }));
}

function getSession(id) {
  return withStore('chats', 'readonly', s => s.get(id));
}

function createSession({ domainId, bossId, title }) {
  const session = {
    id: uid('chat'),
    domainId,
    bossId: bossId || null,
    domainBoss: domainBossKey(domainId, bossId),
    title: title || '新会话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: []
  };
  return withStore('chats', 'readwrite', s => s.put(session)).then(() => session);
}

async function appendMessage(sessionId, msg) {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.messages = session.messages || [];
  session.messages.push(msg);
  session.updatedAt = new Date().toISOString();
  if (session.title === '新会话' && msg.text) session.title = msg.text.slice(0, 12);
  await withStore('chats', 'readwrite', s => s.put(session));
  return session;
}

async function listPosts(domainId) {
  const posts = await getAll('forum');
  const filtered = domainId ? posts.filter(p => p.domainId === domainId) : posts.slice();
  return filtered.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}

function addPost(post) {
  const full = {
    id: uid('post'),
    domainId: post.domainId || 'workplace',
    author: clip((post.author || '').trim(), LIMITS.author) || '匿名网友',
    原话: clip(post.原话, LIMITS.原话),
    场景: clip(post.场景, LIMITS.场景),
    潜台词: clip(post.潜台词, LIMITS.潜台词),
    应对: clip(post.应对, LIMITS.应对),
    likes: 0,
    adopted: false,
    time: new Date().toISOString(),
    mine: true
  };
  return withStore('forum', 'readwrite', s => s.put(full)).then(() => full);
}

function likePost(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('forum', 'readwrite');
    const req = tx.objectStore('forum').get(id);
    req.onsuccess = () => {
      const post = req.result;
      if (!post) { resolve(null); return; }
      post.likes = (post.likes || 0) + 1;
      tx.objectStore('forum').put(post);
      resolve(post);
    };
    req.onerror = () => reject(dbError(req.error));
    tx.onerror = () => reject(dbError(tx.error));
  }));
}

function adoptPost(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(['forum', 'adopted'], 'readwrite');
    const req = tx.objectStore('forum').get(id);
    req.onsuccess = () => {
      const post = req.result;
      if (!post) { resolve(null); return; }
      if (!post.adopted) {
        tx.objectStore('adopted').put({
          id: uid('adopt'),
          postId: post.id,
          domainId: post.domainId,
          原话: post.原话,
          场景: post.场景 || '',
          潜台词: post.潜台词,
          应对: post.应对 || '',
          source: 'forum',
          time: new Date().toISOString()
        });
        post.adopted = true;
        tx.objectStore('forum').put(post);
      }
      resolve(post);
    };
    req.onerror = () => reject(dbError(req.error));
    tx.onerror = () => reject(dbError(tx.error));
  }));
}

function unadoptPost(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(['forum', 'adopted'], 'readwrite');
    const forum = tx.objectStore('forum');
    const adopted = tx.objectStore('adopted');
    const req = forum.get(id);
    req.onsuccess = () => {
      const post = req.result;
      if (!post) { resolve(null); return; }
      if (post.adopted) {
        adopted.openCursor().onsuccess = ev => {
          const cursor = ev.target.result;
          if (!cursor) return;
          if (cursor.value.postId === id) cursor.delete();
          cursor.continue();
        };
        post.adopted = false;
        forum.put(post);
      }
      resolve(post);
    };
    req.onerror = () => reject(dbError(req.error));
    tx.onerror = () => reject(dbError(tx.error));
  }));
}

function getAdopted(domainId) {
  return getAll('adopted').then(rows => rows.filter(e => !domainId || e.domainId === domainId));
}

async function stats() {
  const [bosses, corpus, chats, forum, adopted] = await Promise.all([
    getAll('bosses'), getAll('corpus'), getAll('chats'), getAll('forum'), getAll('adopted')
  ]);
  return {
    bosses: bosses.length,
    corpus: corpus.length,
    chats: chats.length,
    messages: chats.reduce((n, s) => n + (s.messages || []).length, 0),
    forum: forum.length,
    adopted: adopted.length,
    decodeCount: await getMeta('decodeCount', 0)
  };
}

async function exportAll() {
  const [bosses, corpus, chats, forum, adopted, meta] = await Promise.all([
    getAll('bosses'), getAll('corpus'), getAll('chats'), getAll('forum'), getAll('adopted'), getAll('meta')
  ]);
  return {
    app: 'codec98',
    version: 1,
    exportedAt: new Date().toISOString(),
    bosses, corpus, chats, forum, adopted, meta
  };
}

function assertBundle(bundle) {
  if (!bundle || bundle.app !== 'codec98' || bundle.version !== 1) {
    throw new Error('不是 Codec98 备份文件');
  }
  for (const name of ['bosses', 'corpus', 'chats', 'forum', 'adopted', 'meta']) {
    if (bundle[name] != null && !Array.isArray(bundle[name])) throw new Error('备份损坏：' + name);
  }
  if ((bundle.bosses || []).some(b => !b || !b.id || typeof b.name !== 'string')) {
    throw new Error('备份里的人物档案不完整');
  }
}

async function importAll(bundle) {
  assertBundle(bundle);
  for (const name of ['bosses', 'corpus', 'chats', 'forum', 'adopted', 'meta']) {
    await clearStore(name);
    if (Array.isArray(bundle[name]) && bundle[name].length) await putAll(name, bundle[name]);
  }
  await setMeta('seeded', true);
}

async function resetToSeeds(seeds) {
  for (const name of ['bosses', 'corpus', 'chats', 'forum', 'adopted', 'meta']) {
    await clearStore(name);
  }
  await ensureSeeded(seeds);
}

window.CodecDB = {
  uid, bossLevel, ensureSeeded, IMPORT_MAX_BYTES,
  listBosses, getBoss, addBoss,
  getBossEntries, addEntry,
  listSessions, getSession, createSession, appendMessage,
  listPosts, addPost, likePost, adoptPost, unadoptPost, getAdopted,
  getMeta, setMeta, stats, exportAll, importAll, resetToSeeds
};
