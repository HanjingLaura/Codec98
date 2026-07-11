'use strict';

// Prompt 组装器 —— 全项目技术核心（多领域版）
// 拼接顺序：系统指令 → 通用语料包 → 目标人设 → 纠错案例 → 补充背景 → 待处理原话

const TONES = { safe: '稳妥', neutral: '不卑不亢', brave: '勇' };

function outputSchema(domain) {
  const [mA, mB] = domain.meters;
  return `你必须只输出一个JSON对象（不要markdown代码块），结构如下：
{
  "literal": false,            // 这句话是否大概率就是字面意思、没有言外之意
  "literalNote": "",           // literal为true时，一句话说明为什么，并给一个正常回复
  "interpretations": [          // literal为false时给1-2个解读，第一个是最可能的
    {
      "label": "最可能",        // 只能是"最可能"或"也有可能"，禁止出现任何百分比数字
      "潜台词": "...",
      "回复草稿": "..."          // 可直接复制发出去的完整回复，语气遵循指定档位
    }
  ],
  "探口风建议": "",             // 仅当两个解读可能性接近、难以判断时填写：一个低成本试探动作
  "指数A": 0,                   // ${mA.name}，0-100，娱乐化指标，允许夸张
  "指数B": 0                    // ${mB.name}，0-100，娱乐化指标，允许夸张
}`;
}

function forwardSystem(domain) {
  return `你是一位经验丰富的沟通解读助手。${domain.systemHintForward}

核心规则：
1. 先诚实判断这句话有没有言外之意。日常事务性表述大概率就是字面意思，此时literal=true，不要过度解读、不要制造焦虑。
2. 有言外之意时，给1-2个解读。这类话术天然有歧义，两个解读比硬给一个答案更诚实。
3. 每个解读必须附带"回复草稿"：一条可以直接复制发给对方的完整消息，不是抽象建议。禁止"你应该更主动"这类正确的废话。
4. 回复草稿必须在所有解读下都安全——即使解读猜错了，按这条回复行动也不会翻车、不会伤害关系。
5. 当两个解读可能性接近时，在"探口风建议"里给一个低成本的试探动作，这是高手的真实做法。
6. 严禁输出百分比置信度。
7. 解读内容保持专业克制，不阴谋论、不阴阳怪气；指数A（${domain.meters[0].name}）和指数B（${domain.meters[1].name}）是娱乐化仪表，可以夸张。

${outputSchema(domain)}`;
}

function reverseSystem(domain) {
  return `你是一位表达润色助手。${domain.systemHintReverse}用户输入一句真心话（可能直白、情绪化甚至有杀伤力），你改写成既传达真实立场、又不破坏关系的说法。

规则：
1. 保留用户真实意图的内核（反对就还是反对，拒绝就还是拒绝），只改包装，不改立场。
2. 语气遵循指定档位：稳妥=圆滑周全留有余地；不卑不亢=清晰直接但礼貌；勇=明确坚定敢于表达分歧（但仍然得体，不失控）。
3. 如果提供了对方人设，根据其类型调整策略。

你必须只输出一个JSON对象（不要markdown代码块）：
{
  "literal": false,
  "interpretations": [
    { "label": "润色版", "潜台词": "一句话点破这样说的策略考虑", "回复草稿": "改写后的完整表达" }
  ],
  "指数A": 0,
  "指数B": 0
}`;
}

function buildCorpusSection(generalCorpus, bossType) {
  const type = bossType && generalCorpus[bossType] ? bossType : null;
  const pools = type ? { [type]: generalCorpus[type] } : generalCorpus;
  const lines = ['# 参考语料（真实案例，学习其解读风格与应对思路）'];
  for (const [t, items] of Object.entries(pools)) {
    const take = type ? items : items.slice(0, 2);
    for (const it of take) {
      lines.push(`- [${t}] 原话:"${it.原话}" → 潜台词:"${it.潜台词}" → 应对:"${it.建议应对}"`);
    }
  }
  return lines.join('\n');
}

function buildBossSection(boss, domain) {
  if (!boss) return '';
  const seeds = (boss.seedExamples || [])
    .map(s => `  - "${s.原话}" 实际含义:"${s.真实含义}"`)
    .join('\n');
  return [
    `# 当前${domain.targetNoun}人设（本次解读必须针对这个具体的人）`,
    `类型:${boss.type}（${boss.title || ''}）`,
    `口头禅:${(boss.catchphrases || []).join('、') || '无'}`,
    seeds ? `本人经典语录:\n${seeds}` : ''
  ].filter(Boolean).join('\n');
}

function buildCorrectionsSection(entries) {
  const corrected = entries.filter(e => e.被纠正);
  if (!corrected.length) return '';
  const lines = ['# 用户亲自确认的纠错案例（最高优先级参考，比任何通用规律都重要）'];
  for (const e of corrected) {
    lines.push(`- 对方说:"${e.原话}"，AI当时翻译为:"${e.AI翻译}"，用户纠正:实际含义是"${e.纠正内容}"`);
  }
  const confirmed = entries.filter(e => !e.被纠正).slice(-10);
  if (confirmed.length) {
    lines.push('# 用户确认翻译准确的案例');
    for (const e of confirmed) lines.push(`- "${e.原话}" → "${e.AI翻译}"`);
  }
  return lines.join('\n');
}

function assemblePrompt({ domain, direction, tone, text, context, boss, bossEntries, generalCorpus }) {
  const system = direction === 'reverse' ? reverseSystem(domain) : forwardSystem(domain);
  const parts = [];
  if (direction !== 'reverse') parts.push(buildCorpusSection(generalCorpus, boss && boss.type));
  const bossSec = buildBossSection(boss, domain);
  if (bossSec) parts.push(bossSec);
  if (boss && bossEntries && bossEntries.length) {
    const corr = buildCorrectionsSection(bossEntries);
    if (corr) parts.push(corr);
  }
  if (context) parts.push(`# 补充背景（用户提供的上下文）\n${context}`);
  parts.push(`# 语气档位\n回复草稿使用「${TONES[tone] || TONES.neutral}」语气`);
  parts.push(
    direction === 'reverse'
      ? `# 用户的真心话（请改写）\n"${text}"`
      : `# 待解读的原话\n"${text}"`
  );
  return { system, user: parts.join('\n\n') };
}

module.exports = { assemblePrompt, TONES };
