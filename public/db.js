'use strict';

// Codec98 本机数据库：人物档案 / 纠错语料 / 会话 / 论坛都存在浏览器 IndexedDB。
// 换设备或清站点数据会丢，所以提供导出 / 导入备份。

const DB_NAME = 'codec98';
const DB_VERSION = 1;

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function bossLevel(n) {
  return Math.min(9, 1 + Math.floor((n || 0) / 2));
}

function openDB() {
  return new Promise((resolve, reject) => {
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开本机数据库'));
  });
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
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务已中止'));
  }));
}

function getAll(name) {
  return withStore(name, 'readonly', s => s.getAll());
}

function putAll(name, rows) {
  return withStore(name, 'readwrite', s => {
    for (const row of rows) s.put(row);
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
  const bosses = (seeds.bosses || []).map(b => ({ ...b, id: b.id || uid('boss') }));
  const corpus = (seeds.corpus || []).map(e => ({ ...e, id: e.id || uid('entry') }));
  const forum = (seeds.forum || []).map(p => ({
    ...p,
    id: p.id || uid('post'),
    likes: p.likes || 0,
    adopted: false
  }));
  if (bosses.length) await putAll('bosses', bosses);
  if (corpus.length) await putAll('corpus', corpus);
  if (forum.length) await putAll('forum', forum);
  await setMeta('seeded', true);
  await setMeta('seededAt', new Date().toISOString());
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
    name: boss.name,
    type: boss.type,
    avatar: boss.avatar || '👔',
    title: boss.title || boss.type,
    catchphrases: boss.catchphrases || [],
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
    原话: entry.原话 || '',
    AI翻译: entry.AI翻译 || '',
    被纠正: !!entry.被纠正,
    纠正内容: entry.纠正内容 || null,
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
    author: (post.author || '').trim() || '匿名网友',
    原话: post.原话,
    场景: post.场景 || '',
    潜台词: post.潜台词,
    应对: post.应对 || '',
    likes: 0,
    adopted: false,
    time: new Date().toISOString(),
    mine: true
  };
  return withStore('forum', 'readwrite', s => s.put(full)).then(() => full);
}

async function likePost(id) {
  const post = await withStore('forum', 'readonly', s => s.get(id));
  if (!post) return null;
  post.likes = (post.likes || 0) + 1;
  await withStore('forum', 'readwrite', s => s.put(post));
  return post;
}

async function adoptPost(id) {
  const post = await withStore('forum', 'readonly', s => s.get(id));
  if (!post) return null;
  if (!post.adopted) {
    const entry = {
      id: uid('adopt'),
      postId: post.id,
      domainId: post.domainId,
      原话: post.原话,
      场景: post.场景 || '',
      潜台词: post.潜台词,
      应对: post.应对 || '',
      source: 'forum',
      time: new Date().toISOString()
    };
    await withStore('adopted', 'readwrite', s => s.put(entry));
    post.adopted = true;
    await withStore('forum', 'readwrite', s => s.put(post));
  }
  return post;
}

async function unadoptPost(id) {
  const post = await withStore('forum', 'readonly', s => s.get(id));
  if (!post) return null;
  if (post.adopted) {
    const rows = await getAll('adopted');
    const hit = rows.find(e => e.postId === id);
    if (hit) await withStore('adopted', 'readwrite', s => s.delete(hit.id));
    post.adopted = false;
    await withStore('forum', 'readwrite', s => s.put(post));
  }
  return post;
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

async function importAll(bundle) {
  if (!bundle || bundle.app !== 'codec98' || !Array.isArray(bundle.bosses)) {
    throw new Error('不是 Codec98 备份文件');
  }
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
  uid, bossLevel, ensureSeeded,
  listBosses, getBoss, addBoss,
  getBossEntries, addEntry,
  listSessions, getSession, createSession, appendMessage,
  listPosts, addPost, likePost, adoptPost, unadoptPost, getAdopted,
  getMeta, setMeta, stats, exportAll, importAll, resetToSeeds
};
