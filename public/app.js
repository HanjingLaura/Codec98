'use strict';

/* ================= 状态 ================= */
const state = {
  domains: [],
  domain: null,       // 当前领域配置对象
  provider: null,     // 'dashscope' | 'anthropic' | null
  bosses: [],
  currentBossId: '',
  direction: 'forward',
  tone: 'neutral',
  decodeCount: 0,
  lastResult: null,   // {原话, AI翻译, bossId, direction}
};
const TONES = ['safe', 'neutral', 'brave'];
const TONE_NAMES = { safe: '稳妥', neutral: '不卑不亢', brave: '勇 🔥' };
const $ = id => document.getElementById(id);

/* ================= 8-bit 音效（WebAudio，无素材依赖） ================= */
let audioCtx = null;
function beep(freqs, dur = 0.07) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.04, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur);
      t += dur;
    }
  } catch (e) { /* 静音环境忽略 */ }
}
const sfxDing = () => beep([660, 880, 1320], 0.09);
const sfxCard = () => beep([220, 330, 440, 660, 880], 0.06);
const sfxClick = () => beep([440], 0.04);

/* ================= 初始化 ================= */
async function init() {
  const r = await fetch('/api/domains').then(r => r.json());
  state.domains = r.domains;
  state.provider = r.provider;
  $('taskbar-mode').textContent = r.provider ? `⚡ LLM在线（${r.provider}）` : '⚙ 演示模式';
  renderDomainBar();
  await switchDomain(state.domains[0].id, true);
  bindEvents();
  tickClock(); setInterval(tickClock, 1000);
}

/* ================= 领域切换（桌面快捷方式风格） ================= */
function renderDomainBar() {
  $('domain-bar').innerHTML = state.domains.map(d => `
    <button class="domain-icon" id="dom-${d.id}" onclick="switchDomain('${d.id}')">
      <span class="di-emoji">${d.icon}</span>
      <span class="di-label">${d.exe}</span>
      <span class="di-name">${d.name}</span>
    </button>`).join('');
}

window.switchDomain = async function (id, silent) {
  const d = state.domains.find(x => x.id === id);
  if (!d) return;
  state.domain = d;
  state.currentBossId = '';
  document.querySelectorAll('.domain-icon').forEach(el =>
    el.classList.toggle('active', el.id === 'dom-' + id));

  // 标题与文案
  $('app-titlebar').textContent = `${d.icon} ${d.appTitle} — ${d.exe}`;
  $('taskbar-app').textContent = d.appTitle;
  document.title = d.appTitle;
  $('tab-forward-text').textContent = `解码模式：${d.targetNoun}话 → 人话`;
  $('tab-reverse-text').textContent = `加密模式：人话 → 得体表达`;
  $('label-target').textContent = `目标${d.targetNoun}：`;
  $('quiz-titlebar').textContent = `🔬 ${d.targetNoun}类型鉴定程序 — TYPE_SCAN.EXE`;
  applyDirectionTexts();

  await loadBosses();
  if (!silent) sfxCard();
};

/* ================= 数据加载 ================= */
async function loadBosses(selectId) {
  const r = await fetch(`/api/bosses?domainId=${state.domain.id}`).then(r => r.json());
  state.bosses = r.bosses;
  const sel = $('boss-select');
  sel.innerHTML = `<option value="">通用模式（未指定${state.domain.targetNoun}）</option>` +
    r.bosses.map(b => `<option value="${b.id}">${b.avatar} ${b.name}（${b.title}）研究进度 Lv.${b.level}</option>`).join('');
  sel.value = selectId || '';
  state.currentBossId = selectId || '';
  updateBossButtons();
}

function bindEvents() {
  $('tab-forward').onclick = () => setDirection('forward');
  $('tab-reverse').onclick = () => setDirection('reverse');
  $('boss-select').onchange = e => { state.currentBossId = e.target.value; updateBossButtons(); sfxClick(); };
  $('tone-slider').oninput = e => {
    state.tone = TONES[+e.target.value];
    $('tone-label').textContent = '当前：' + TONE_NAMES[state.tone];
    sfxClick();
  };
  $('btn-decode').onclick = doDecode;
  $('btn-new-boss').onclick = openQuiz;
  $('btn-view-boss').onclick = () => showBossWindow(state.currentBossId);
  $('btn-submit-correct').onclick = submitCorrection;
  $('input-text').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doDecode(); };
}

function applyDirectionTexts() {
  const d = state.domain, dir = state.direction;
  $('label-input').textContent = dir === 'forward'
    ? '📥 输入待解码的原话：'
    : '📤 输入你的真心话（我来帮你加密成得体表达）：';
  $('input-text').placeholder = dir === 'forward' ? d.inputPlaceholder : d.reversePlaceholder;
  $('row-context').style.display = dir === 'forward' ? '' : 'none';
  $('chk-compare').parentElement.style.display = dir === 'forward' ? '' : 'none';
}

function setDirection(d) {
  state.direction = d;
  $('tab-forward').setAttribute('aria-selected', d === 'forward');
  $('tab-reverse').setAttribute('aria-selected', d === 'reverse');
  applyDirectionTexts();
  sfxClick();
}

function updateBossButtons() {
  $('btn-view-boss').style.display = state.currentBossId ? '' : 'none';
}

/* ================= 解码主流程 ================= */
async function doDecode() {
  const text = $('input-text').value.trim();
  if (!text) return alert('请先输入内容');
  const compare = $('chk-compare').checked && state.currentBossId && state.direction === 'forward';

  showProgress();
  const body = {
    domainId: state.domain.id,
    text, context: $('input-context').value.trim(),
    direction: state.direction, tone: state.tone,
    bossId: state.currentBossId || null, compare
  };
  let data;
  try {
    data = await fetch('/api/translate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json());
  } catch (e) {
    hideProgress(); return alert('解码失败：' + e.message);
  }
  await progressFinish();
  hideProgress();
  sfxDing();

  state.decodeCount++;
  $('taskbar-status').textContent = `已解码 ${state.decodeCount} 条语录`;

  if (data.compare) renderCompare(text, data);
  else renderReport(text, data);
}

function showProgress() {
  $('progress-area').style.display = '';
  const bar = $('progress-bar'), txt = $('progress-text');
  bar.value = 8;
  const msgs = ['正在接入语料数据库…', '正在比对历史纠错记录…', '正在分析言外之意…', '正在生成应对方案…'];
  let i = 0;
  state._pt = setInterval(() => {
    bar.value = Math.min(88, bar.value + 12 + Math.random() * 10);
    txt.textContent = msgs[Math.min(msgs.length - 1, ++i)];
  }, 260);
}
function progressFinish() {
  return new Promise(res => { $('progress-bar').value = 100; setTimeout(res, 200); });
}
function hideProgress() { clearInterval(state._pt); $('progress-area').style.display = 'none'; }

/* ================= 渲染：解码报告 ================= */
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function meterHTML(result) {
  const [mA, mB] = state.domain.meters;
  const vA = result.指数A ?? 0, vB = result.指数B ?? 0;
  return `<div class="meter-row">
    <div class="meter"><div class="meter-title"><span>${mA.emoji} ${esc(mA.name)}</span><span>${vA}/100</span></div>
      <div class="meter-bar"><div class="meter-fill ${mA.color}" data-w="${vA}"></div></div></div>
    <div class="meter"><div class="meter-title"><span>${mB.emoji} ${esc(mB.name)}</span><span>${vB}/100</span></div>
      <div class="meter-bar"><div class="meter-fill ${mB.color}" data-w="${vB}"></div></div></div>
  </div>`;
}

function interpHTML(result, withCopy = true) {
  if (result.literal) {
    return `<div class="literal-box">✅ <b>系统判定：无言外之意</b><br>${esc(result.literalNote)}</div>`;
  }
  let html = (result.interpretations || []).map((itp, i) => `
    <div class="interp-box ${i > 0 ? 'secondary' : ''}">
      <span class="interp-label">${esc(itp.label)}</span>
      <div>🎯 <b>潜台词：</b>${esc(itp.潜台词)}</div>
      <div class="draft-box">💬 ${esc(itp.回复草稿)}
        ${withCopy ? `<div style="text-align:right;margin-top:4px"><button onclick="copyDraft(this)" data-draft="${esc(itp.回复草稿)}">📋 一键复制</button> <span class="copied-flash"></span></div>` : ''}
      </div>
    </div>`).join('');
  if (result.探口风建议) {
    html += `<div class="probe-box">🕵️ <b>探口风建议：</b>${esc(result.探口风建议)}</div>`;
  }
  return html;
}

function reportWindow(titleText, inner) {
  const area = $('result-area');
  const div = document.createElement('div');
  div.className = 'window report-window';
  div.innerHTML = `
    <div class="title-bar">
      <div class="title-bar-text">${titleText}</div>
      <div class="title-bar-controls"><button aria-label="Close" onclick="this.closest('.window').remove()"></button></div>
    </div>
    <div class="window-body">${inner}</div>`;
  area.prepend(div);
  requestAnimationFrame(() => {
    div.querySelectorAll('.meter-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
  });
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return div;
}

function srcTag(source) {
  return source === 'demo' ? '⚙ 演示模式输出' : `⚡ LLM 实时解码（${String(source).replace('llm:', '')}）`;
}

function renderReport(text, result) {
  state.lastResult = {
    原话: text,
    AI翻译: result.literal ? result.literalNote : (result.interpretations?.[0]?.潜台词 || ''),
    bossId: result._boss?.id || null,
    direction: state.direction
  };
  const bossTag = result._boss ? `｜目标：${esc(result._boss.name)}` : '｜通用模式';
  const dirName = state.direction === 'reverse' ? '📤 加密报告' : '📄 解码分析报告';
  const feedbackRow = result._boss && !result.literal ? `
    <div class="feedback-row">
      <button onclick="sendFeedback(true)">👍 翻译准</button>
      <button onclick="openCorrect()">✏️ 不准，我来纠正</button>
    </div>` : '';
  const inner = `
    <div class="report-original">「${esc(text)}」</div>
    ${interpHTML(result)}
    ${meterHTML(result)}
    ${feedbackRow}
    <div class="src-tag">${srcTag(result._source)}${bossTag}</div>`;
  reportWindow(dirName + ' — DECODE_REPORT.TXT', inner);
}

function renderCompare(text, data) {
  state.lastResult = {
    原话: text,
    AI翻译: data.custom.interpretations?.[0]?.潜台词 || '',
    bossId: data.custom._boss?.id || null,
    direction: 'forward'
  };
  const inner = `
    <div class="report-original">「${esc(text)}」</div>
    <div class="compare-grid">
      <div>
        <div class="compare-col-title">通用模式</div>
        ${interpHTML(data.generic, false)}
        ${meterHTML(data.generic)}
      </div>
      <div>
        <div class="compare-col-title custom">🎯 专属模式：${esc(data.custom._boss?.name || '')}</div>
        ${interpHTML(data.custom)}
        ${meterHTML(data.custom)}
        <div class="feedback-row">
          <button onclick="sendFeedback(true)">👍 翻译准</button>
          <button onclick="openCorrect()">✏️ 不准，我来纠正</button>
        </div>
      </div>
    </div>
    <div class="src-tag">${srcTag(data.custom._source)}｜并排对比</div>`;
  reportWindow('📊 通用 vs 专属 — 对比分析报告', inner);
}

window.copyDraft = function (btn) {
  navigator.clipboard.writeText(btn.dataset.draft).then(() => {
    const flash = btn.parentElement.querySelector('.copied-flash');
    flash.textContent = '已复制到剪贴板 ✓';
    sfxDing();
    setTimeout(() => flash.textContent = '', 1800);
  });
};

/* ================= 反馈闭环 ================= */
window.sendFeedback = async function (accurate) {
  if (!state.lastResult?.bossId) return;
  const r = await fetch('/api/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...state.lastResult, 准确: accurate })
  }).then(r => r.json());
  sfxDing();
  alert(accurate ? `✓ 已存入专属语料库（研究进度 Lv.${r.level}）` : '');
  loadBosses(state.currentBossId);
};

window.openCorrect = function () {
  $('correct-text').value = '';
  $('overlay').style.display = ''; $('win-correct').style.display = '';
  $('correct-text').focus();
};
window.closeCorrect = function () {
  $('overlay').style.display = 'none'; $('win-correct').style.display = 'none';
};
async function submitCorrection() {
  const content = $('correct-text').value.trim();
  if (!content) return alert('请填写实际含义');
  const r = await fetch('/api/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...state.lastResult, 准确: false, 纠正内容: content })
  }).then(r => r.json());
  closeCorrect(); sfxCard();
  alert(`✓ 更正已提交数据库，标记为最高优先级参考\n研究进度提升至 Lv.${r.level}，下次解码会吸收这条纠正`);
  loadBosses(state.currentBossId);
}

/* ================= 鉴定测试（5题 → 类型+雷达，题目来自领域配置） ================= */
function openQuiz() {
  sfxClick();
  const d = state.domain;
  const body = $('quiz-body');
  body.innerHTML = `
    <div class="field-row" style="margin-bottom:8px">
      <label>${d.targetNoun}称呼：</label><input type="text" id="quiz-name" placeholder="如：张总 / 宝贝 / 李经理" style="flex:1">
    </div>
    ${d.quiz.map((item, qi) => `
      <div class="quiz-q"><div class="q-title">${item.q}</div>
        ${item.opts.map(([label], oi) => `
          <div class="field-row"><input type="radio" id="q${qi}-o${oi}" name="q${qi}" value="${oi}"><label for="q${qi}-o${oi}">${label}</label></div>`).join('')}
      </div>`).join('')}
    <div class="field-row" style="margin-bottom:8px">
      <label>口头禅（可选，逗号分隔）：</label><input type="text" id="quiz-phrases" style="flex:1" placeholder="如：格局打开, 随便">
    </div>
    <div class="field-row" style="justify-content:flex-end">
      <button onclick="closeQuiz()">取消</button>
      <button class="default-btn" onclick="finishQuiz()">🔬 开始鉴定</button>
    </div>`;
  $('overlay').style.display = ''; $('win-quiz').style.display = '';
}
window.closeQuiz = function () {
  $('overlay').style.display = 'none'; $('win-quiz').style.display = 'none';
};

window.finishQuiz = async function () {
  const d = state.domain;
  const name = $('quiz-name').value.trim();
  if (!name) return alert(`请填写${d.targetNoun}称呼`);
  const votes = {};
  for (let qi = 0; qi < d.quiz.length; qi++) {
    const checked = document.querySelector(`input[name=q${qi}]:checked`);
    if (!checked) return alert('还有题没答完');
    const type = d.quiz[qi].opts[+checked.value][1];
    votes[type] = (votes[type] || 0) + 1;
  }
  const type = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  // 雷达维度由领域配置驱动
  const radar = {};
  for (const dim of d.radarDims) {
    if (dim.inverse) {
      const bad = dim.inverse.reduce((s, t) => s + (votes[t] || 0), 0);
      radar[dim.name] = Math.max(10, 70 - bad * 12);
    } else {
      radar[dim.name] = 15 + (votes[dim.fromType] || 0) * 16;
    }
  }
  const meta = d.types[type] || { avatar: '👤', title: type };
  const r = await fetch('/api/bosses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      domainId: d.id,
      name, type, avatar: meta.avatar, title: meta.title, radar,
      catchphrases: $('quiz-phrases').value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    })
  }).then(r => r.json());
  closeQuiz();
  await loadBosses(r.boss.id);
  sfxCard();
  showBossWindow(r.boss.id);
};

/* ================= 目标人物档案卡 ================= */
function radarSVG(radar) {
  const keys = Object.keys(radar);
  if (!keys.length) return '';
  const cx = 90, cy = 90, R = 70, n = keys.length;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const rings = [0.33, 0.66, 1].map(f =>
    `<polygon points="${keys.map((_, i) => pt(i, R * f).join(',')).join(' ')}" fill="none" stroke="#aaa" stroke-width="1"/>`).join('');
  const axes = keys.map((_, i) => { const [x, y] = pt(i, R); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#bbb"/>`; }).join('');
  const shape = keys.map((k, i) => pt(i, R * (radar[k] / 100)).join(',')).join(' ');
  const labels = keys.map((k, i) => {
    const [x, y] = pt(i, R + 14);
    return `<text x="${x}" y="${y}" font-size="10" text-anchor="middle" dominant-baseline="middle">${k}</text>`;
  }).join('');
  return `<svg width="180" height="180" viewBox="0 0 180 180">
    ${rings}${axes}
    <polygon points="${shape}" fill="rgba(170,0,0,.35)" stroke="#aa0000" stroke-width="2"/>
    ${labels}</svg>`;
}

async function showBossWindow(bossId) {
  const boss = state.bosses.find(b => b.id === bossId);
  if (!boss) return;
  const corpus = await fetch(`/api/bosses/${bossId}/corpus`).then(r => r.json());
  const corrected = corpus.entries.filter(e => e.被纠正);
  $('boss-card-body').innerHTML = `
    <div class="boss-card">
      <div class="stamp">CONFIDENTIAL</div>
      <div class="boss-head">
        <div class="boss-avatar">${boss.avatar}</div>
        <div>
          <div class="boss-name">${esc(boss.name)}</div>
          <span class="boss-title-tag">${esc(boss.type)} · ${esc(boss.title)}</span>
          <div class="boss-level">研究进度 <span class="lv">Lv.${boss.level}</span>（已积累 ${boss.entryCount} 条语料，${corrected.length} 条人工纠正）</div>
        </div>
      </div>
      <div class="radar-wrap">
        ${radarSVG(boss.radar || {})}
        <div class="radar-legend">
          ${Object.entries(boss.radar || {}).map(([k, v]) => `${k}：<b>${v}</b><br>`).join('')}
          ${boss.catchphrases?.length ? `<br>🗣️ 口头禅：${boss.catchphrases.map(esc).join('、')}` : ''}
        </div>
      </div>
      ${corpus.entries.length ? `
        <fieldset><legend>📚 研究记录（纠错优先展示）</legend>
        <div class="corpus-list">
          ${[...corrected, ...corpus.entries.filter(e => !e.被纠正)].slice(0, 12).map(e => `
            <div class="corpus-entry">
              <span class="orig-q">「${esc(e.原话)}」</span><br>
              ${e.被纠正
                ? `<span class="corrected">✏️ 人工纠正：${esc(e.纠正内容)}</span>`
                : `✓ AI翻译已确认：${esc(e.AI翻译)}`}
            </div>`).join('')}
        </div></fieldset>` : '<p>还没有研究记录，去解码几句话吧。</p>'}
    </div>`;
  $('overlay').style.display = ''; $('win-boss').style.display = '';
  sfxCard();
}
window.hideBossWindow = function () {
  $('overlay').style.display = 'none'; $('win-boss').style.display = 'none';
};

/* ================= 开机封面（BIOS 自检 → 欢迎窗口） ================= */
const BOOT_LINES = [
  ['CODEC98 BIOS v1.0 — 话术编解码固件', ''],
  ['Memory Test: 640K', 'OK'],
  ['Loading CORPUS.DAT ...........', 'OK'],
  ['Loading BOSS_DECODER.EXE .....', 'OK'],
  ['Loading LOVE_DECODER.EXE .....', 'OK'],
  ['Loading CLIENT_DECODER.EXE ...', 'OK'],
  ['Loading JARGON_DECODER.EXE ...', 'OK'],
  ['潜台词引擎初始化 .............', 'OK'],
];

function runBootSequence() {
  const log = $('boot-log');
  let i = 0, skipped = false;

  const showWindow = () => {
    if ($('boot-window').style.display !== 'none') return;
    $('boot-window').style.display = '';
    $('btn-enter').focus();
  };
  const skip = () => { skipped = true; showWindow(); };

  const typeNext = () => {
    if (skipped) return;
    if (i >= BOOT_LINES.length) { setTimeout(showWindow, 250); return; }
    const [text, status] = BOOT_LINES[i++];
    log.innerHTML = log.innerHTML.replace('<span class="cursor">_</span>', '')
      + esc(text) + (status ? ` [<span class="ok">${status}</span>]` : '') + '\n'
      + '<span class="cursor">_</span>';
    setTimeout(typeNext, 120 + Math.random() * 130);
  };
  typeNext();

  // 日志阶段点击任意处跳过；Enter / 按钮进入桌面
  log.onclick = skip;
  $('btn-enter').onclick = enterDesktop;
  document.addEventListener('keydown', function onEnter(e) {
    if (!document.getElementById('boot-screen')) { document.removeEventListener('keydown', onEnter); return; }
    if (e.key !== 'Enter') return;
    if ($('boot-window').style.display === 'none') { skip(); return; }
    document.removeEventListener('keydown', onEnter);
    enterDesktop();
  });
}

function enterDesktop() {
  sfxDing(); // 首次用户手势，顺带解锁 WebAudio
  const boot = $('boot-screen');
  boot.classList.add('fade-out');
  setTimeout(() => boot.remove(), 500);
}

/* ================= 任务栏时钟 ================= */
function tickClock() {
  const d = new Date();
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

runBootSequence(); // 封面先跑，数据加载在其背后并行完成
init();
