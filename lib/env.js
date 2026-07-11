'use strict';
// 极简 .env 加载器（零依赖）：已存在的环境变量不覆盖
const fs = require('fs');
const path = require('path');

function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2] !== '' && !(m[1] in process.env && process.env[m[1]] !== '')) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* 无 .env 文件则跳过 */ }
}

module.exports = { loadEnv };
