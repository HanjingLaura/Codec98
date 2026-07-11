'use strict';

// 数据层：JSON 文件读写（黑客松规格，单用户）
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const p = f => path.join(DATA, f);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(p(file), 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.writeFileSync(p(file), JSON.stringify(obj, null, 2), 'utf8');
}

// ---- 领域（版）配置 ----
const loadDomains = () => readJSON('domains.json', { domains: [] }).domains;
function getDomain(id) {
  const domains = loadDomains();
  return domains.find(d => d.id === id) || domains[0] || null;
}
// 该领域的通用语料包
function loadDomainCorpus(domain) {
  return readJSON(domain.corpusFile, {});
}

const loadBosses = () => readJSON('bosses.json', { bosses: [] });
const saveBosses = d => writeJSON('bosses.json', d);
const loadCorpus = () => readJSON('corpus.json', { entries: [] });
const saveCorpus = d => writeJSON('corpus.json', d);

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

module.exports = {
  loadDomains, getDomain, loadDomainCorpus,
  loadBosses, getBoss, getBossEntries, addEntry, addBoss
};
