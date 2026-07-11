'use strict';

// LLM 调用层：优先百炼(DashScope)，其次 Anthropic，都没有时降级到内置演示响应器
// —— 保证 demo 在任何网络/账号条件下都能跑

async function callDashScope(system, user) {
  // 百炼 OpenAI 兼容模式
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME || 'qwen-plus',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' }
    })
  });
  if (!resp.ok) throw new Error(`DashScope ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return extractJSON(data.choices[0].message.content);
}

async function callAnthropic(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME || 'claude-sonnet-5',
      max_tokens: 1024,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return extractJSON(data.content.map(b => b.text || '').join(''));
}

function extractJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM未返回JSON: ' + String(text).slice(0, 200));
  return JSON.parse(m[0]);
}

function llmProvider() {
  if (process.env.DASHSCOPE_API_KEY) return 'dashscope';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// ---------------- 演示降级响应器 ----------------
// 覆盖各领域 demo 剧本的关键输入，其余输入用该领域语料库模糊匹配兜底

function literalCheck(text) {
  return /^[^，。]*((\d+|[一二三四五六七八九十]+)[点号日月]|上午|下午|明天|周[一二三四五六日]|会议室|开会|发我|收到|带上|记得|到楼下|出发)[^？?]*$/.test(text)
    && !/看情况|想想|机会|格局|辛苦|历练|分寸|生气|随便|冷/.test(text);
}

// 剧本案例：按领域组织。回复草稿可以是 {safe,neutral,brave} 三档对象
const DEMO_CASES = {
  workplace: [
    {
      match: t => /再想想|不着急/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '方案不满意，但不想直接否定你，给你台阶自己想明白', 回复草稿: { safe: '好的领导，我再打磨一下细节，这两天整理一版给您过目。', neutral: '好的，我下午整理一版调整思路，明天上午占用您10分钟当面对一下方向可以吗？', brave: '收到。不过与其我自己猜，不如您直接说说主要不满意哪一块？我好有的放矢地改。' } },
          { label: '也有可能', 潜台词: '他自己也还没完全想清楚要什么，想留时间给自己也想想', 回复草稿: { safe: '好的，那我先把现有版本的补充材料准备一下，您需要随时找我。', neutral: '好的，我先补充一版竞品参考发您，或许对咱们确定方向有帮助。', brave: '好，那我明天先发您一版方向清单，咱们勾选式确定，效率高一些。' } }
        ],
        探口风建议: '两种可能性都存在。建议先发一版轻量的补充材料探探反应：他若细看回复，多半是第一种；若只回"好"，可能自己也没想好。',
        指数A: 15, 指数B: 30
      },
      boss: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '结合张总的历史记录：他说"不着急"通常意味着这事优先级在他心里已经降级，方案大概率不会被推进，但他不会明说', 回复草稿: { safe: '好的张总，我先放一放，随时等您的节奏。', neutral: '好的张总。这个方案我先归档一版，另外手头X项目我优先推进，您看这样安排可以吗？', brave: '张总，直说吧——这个方案是方向不对还是时机不对？如果短期不做了，我把精力挪到X上。' } },
          { label: '也有可能', 潜台词: '他准备把这个方案的思路挪给别的项目用，先让你继续深化', 回复草稿: { safe: '好的，我持续完善着，有新版本随时同步您。', neutral: '好的，我把方案里可复用的模块单独整理出来，说不定别的项目用得上。', brave: '明白，那我把核心模块拆出来做成通用版——如果别的项目要用，记得署我名字啊张总。' } }
        ],
        探口风建议: '',
        指数A: 35, 指数B: 45
      }
    },
    {
      match: t => /看情况|好好干/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '"看情况"是把承诺权收回去的标准话术：既不拒绝你，也不给你任何可追责的承诺', 回复草稿: { safe: '好的，我先把手头的事做扎实。', neutral: '明白。那我年底前把关键成果整理成一页纸给您，方便到时候"看情况"的时候有据可依。', brave: '收到。那"情况"具体看哪几项？我想对着标准干活，年底也好复盘。' } },
          { label: '也有可能', 潜台词: '确实还没到能拍板的时间点，公司层面的盘子没定', 回复草稿: { safe: '好的，我继续保持节奏。', neutral: '理解，那我先把自己这块的数据做漂亮，等公司定盘子。', brave: '明白。那等盘子定了，我想第一时间跟您对一次——我对结果是有期待的。' } }
        ],
        探口风建议: '过一两周用一个具体小事试探：申请一个小资源或小调整。痛快批=事情有戏；开始打太极=第一种解读，早做打算。',
        指数A: 60, 指数B: 25
      },
      boss: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '根据你的纠错记录：张总说"看情况"=没戏（去年年终奖是一箱橙子）。这句话的实际含义是：别对年底抱期待，但活儿照干', 回复草稿: { safe: '好的张总，我先把手头的事做扎实。', neutral: '明白。不过想跟您约个时间聊聊我的考核标准——到年底"情况"具体看哪几项，我心里也好有个数。', brave: '张总，去年也是"看情况"（笑）。今年咱们把标准写下来行吗？达到什么数，对应什么结果。' } }
        ],
        探口风建议: '',
        指数A: 91, 指数B: 20
      }
    },
    {
      match: t => /垃圾|没人用|烂|傻|不想干/.test(t),
      reverse: {
        literal: false,
        interpretations: [
          { label: '润色版', 潜台词: '把"否定需求"包装成"风险管理建议"，立场没变，但从抱怨者变成了操心项目的人', 回复草稿: { safe: '这个方向挺有想法的，我建议咱们先做个小范围的用户验证，确认需求真实存在再投入开发，这样更稳妥一些。', neutral: '我对这个需求的真实用户价值有些疑问。建议先花三天做个最小验证，如果数据支持咱们再全量投入，避免资源浪费。', brave: '我直说：我认为这个需求不成立，目前没有证据表明用户需要它。如果一定要做，我建议先定一个验证指标——达不到就停，我不希望团队白忙一个月。' } }
        ],
        指数A: 3, 指数B: 8
      }
    },
    {
      match: t => /千载难逢|机会只给你|大机会/.test(t),
      boss: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '根据纠错记录：这是张总的口头禅，本季度已"千载难逢"四次。翻译：又有新活儿了，而且大概率没资源', 回复草稿: { safe: '谢谢张总想着我！您先说说具体是什么事？', neutral: '谢谢张总。我先了解一下：这个机会需要投入多少时间、有没有配套的资源？我评估一下再答复您。', brave: '张总，这是本季度第四个千载难逢了（笑）。这次的"机会"有预算和人手吗？有我就接，没有咱们商量商量优先级。' } }
        ],
        探口风建议: '',
        指数A: 96, 指数B: 30
      }
    }
  ],
  romance: [
    {
      match: t => /没生气|没事$|我没事/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '气到需要单独声明。真没生气的人不会用这个句式——现在是哄的窗口期，且窗口在缩小', 回复草稿: { safe: '好吧……那我去给你买杯奶茶，你要芋泥的还是杨枝甘露？', neutral: '你说没生气，但我感觉你不太开心。是我刚才哪句话说得不对？你告诉我，我改。', brave: '行了，"没生气"三个字就是生气的意思，这我还是懂的。说吧，我哪里惹到你了，我道歉，态度端正的那种。' } },
          { label: '也有可能', 潜台词: '真的没生气，只是累了或在想别的事，此时过度追问反而会把没气问出气来', 回复草稿: { safe: '好，那你先休息，我把水给你放床头了。', neutral: '好。你要是累了就先歇着，想聊天了叫我。', brave: '那就好。你要是单纯累了，我闭麦陪着；要是有事，随时开口。' } }
        ],
        探口风建议: '发个TA平时喜欢的表情包或小视频探一下：秒回或有笑意=第二种，已读不回或回"嗯"=第一种，速去哄。',
        指数A: 55, 指数B: 10
      }
    },
    {
      match: t => /都行|随便/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '不是真随便，是"我想看看你懂不懂我"。开放题会做错，要把它变成选择题', 回复草稿: { safe: '那我定咯：上次你说不错的那家川菜，还是楼下新开的日料？二选一！', neutral: '"随便"可难倒我了（笑）。缩小范围：辣的还是清淡的？', brave: '不许随便！我数三声，说不出来就吃我选的火锅，到时候不许嫌辣。三、二——' } }
        ],
        探口风建议: '',
        指数A: 40, 指数B: 20
      }
    },
    {
      match: t => /分手|不想理你|拉黑/.test(t),
      reverse: {
        literal: false,
        interpretations: [
          { label: '润色版', 潜台词: '把"威胁式分手"翻译成"表达受伤+要一个改变"——你要的其实不是分手，是被重视', 回复草稿: { safe: '刚才那件事让我挺难受的，我需要你知道这一点。我们晚上聊聊好吗？', neutral: '我现在很难受，而且类似的事发生不止一次了。我不想用吵架解决，但我需要它真的改变。今晚我们认真谈一次。', brave: '我说真的：这件事踩到我的底线了。我不说气话也不冷战，但我要你给我一个明确的说法——这段关系我很在乎，所以我才谈，而不是转身走。' } }
        ],
        指数A: 15, 指数B: 5
      }
    }
  ],
  client: [
    {
      match: t => /预算有限|曝光|资源置换/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '翻译：想少花钱或不花钱。"曝光"是白嫖的官方货币，且无法兑现房租', 回复草稿: { safe: '感谢认可！我们也很看重长期合作。这样，我整理一份基础报价和可选的置换方案发您，您看哪种组合合适？', neutral: '理解预算压力。曝光类合作我们也接，但需要把置换资源写进合同：具体渠道、频次、量级。我下午发您一份两种模式的报价单。', brave: '曝光我们就不算进报价了——曝光不能交房租（笑）。基础费用X是底线，置换资源可以谈折扣但不能替代现金。您内部对一下，能接受咱们今天就推进。' } },
          { label: '也有可能', 潜台词: '预算确实卡死了，但项目和后续合作是真实的，值得评估性价比', 回复草稿: { safe: '明白～您方便说个预算区间吗？我看看在这个范围内能做到什么程度，给您几个选项。', neutral: '这样：您给个实际预算数，我按这个数倒推交付范围，多退少不补，咱们都省事。', brave: '直接点：预算多少？数字合理我就接，顺便把后续合作签进框架里——口头的"以后"我见得多了（笑）。' } }
        ],
        探口风建议: '让对方先报预算数字是最好的试金石：肯报数=真有预算只是紧；死活不报数、只谈"机会"=白嫖预警，报价单发完就止损。',
        指数A: 88, 指数B: 30
      }
    },
    {
      match: t => /差点意思|再改一下|感觉不对/.test(t),
      generic: {
        literal: false,
        interpretations: [
          { label: '最可能', 潜台词: '"感觉"=对方自己也说不清要什么。此时盲改就是开盲盒，改到第七版会回到第一版', 回复草稿: { safe: '好的！为了改得准，我拉了三组不同方向的参考图，您指一下更偏向哪种感觉？', neutral: '收到。不过"差点意思"我需要定位一下：是配色、版式还是整体风格？我发三个参考方向您选，选完我一次改到位。', brave: '咱们换个高效的方式：您从这三个参考里挑一个"对的感觉"，我按它改。不然一轮轮试感觉，改稿次数很快就超了，后面按合同就要计费了（笑）。' } }
        ],
        探口风建议: '',
        指数A: 40, 指数B: 90
      }
    },
    {
      match: t => /加钱|不加钱|尾款再不/.test(t),
      reverse: {
        literal: false,
        interpretations: [
          { label: '润色版', 潜台词: '把"下最后通牒"包装成"流程升级"——立场不退，但给对方台阶和明确路径', 回复草稿: { safe: '目前的修改已经超出了合同约定的范围，再往后调整我们需要按增项走。我把明细整理给您，您审批一下？', neutral: '提醒一下进度：合同内的修改次数已用完。您这次的调整属于增项，费用是X，确认后我立刻开工。', brave: '明确同步：免费修改额度已用完，新的改动一律按增项报价，先付后改。这不是为难您，是我对所有客户统一的规矩——规矩清楚，合作才长久。' } }
        ],
        指数A: 20, 指数B: 15
      }
    }
  ]
};

function fuzzyFromCorpus(text, domainCorpus, bossType) {
  const pools = bossType && domainCorpus[bossType]
    ? [[bossType, domainCorpus[bossType]]]
    : Object.entries(domainCorpus);
  let best = null, bestScore = 0;
  for (const [type, items] of pools) {
    for (const it of items) {
      const kws = it.原话.replace(/[，。？！,.?!]/g, '').split('');
      const overlap = kws.filter(ch => text.includes(ch)).length / kws.length;
      if (overlap > bestScore) { bestScore = overlap; best = { ...it, type }; }
    }
  }
  if (best && bestScore > 0.45) {
    return {
      literal: false,
      interpretations: [{ label: '最可能', 潜台词: best.潜台词, 回复草稿: best.建议应对 }],
      探口风建议: '',
      指数A: best.指数A ?? best.画饼指数 ?? 20,
      指数B: best.指数B ?? best.甩锅风险 ?? 20
    };
  }
  return null;
}

function pickTone(result, tone) {
  const clone = JSON.parse(JSON.stringify(result));
  for (const itp of clone.interpretations || []) {
    if (itp.回复草稿 && typeof itp.回复草稿 === 'object') {
      itp.回复草稿 = itp.回复草稿[tone] || itp.回复草稿.neutral;
    }
  }
  return clone;
}

function demoRespond({ domain, direction, tone, text, boss, domainCorpus }) {
  const cases = DEMO_CASES[domain.id] || [];
  if (direction === 'reverse') {
    const hit = cases.find(c => c.reverse && c.match(text));
    if (hit) return pickTone(hit.reverse, tone);
    return pickTone({
      literal: false,
      interpretations: [{ label: '润色版', 潜台词: '把直接的情绪表达转为聚焦事实与诉求的说法', 回复草稿: { safe: '关于这件事我有一些不同的想法，方便的时候想跟你聊聊。', neutral: `我对这件事有些想法想同步：${text.slice(0, 20)}……我的建议是我们先把彼此的期望说清楚。`, brave: '我明确表达一下我的立场和感受，希望我们能认真谈一次，把这件事说透。' } }],
      指数A: 5, 指数B: 10
    }, tone);
  }
  if (domain.id === 'workplace' && literalCheck(text)) {
    return { literal: true, literalNote: '这句话大概率就是字面意思，属于正常沟通，不用过度解读。正常回复即可。', interpretations: [], 指数A: 0, 指数B: 0 };
  }
  const hit = cases.find(c => c.match(text));
  if (hit) {
    if (boss && hit.boss) return pickTone(hit.boss, tone);
    if (hit.generic) return pickTone(hit.generic, tone);
    // 人物专属剧本不在通用模式下泄露，落到语料库模糊匹配
  }
  const fuzzy = fuzzyFromCorpus(text, domainCorpus, boss && boss.type);
  if (fuzzy) return pickTone(fuzzy, tone);
  return {
    literal: false,
    interpretations: [{ label: '最可能', 潜台词: '这句话的含义高度依赖上下文，目前信息不足以准确判断', 回复草稿: '建议先用一个低成本动作探探口风，根据对方反应再决定应对。' }],
    探口风建议: '在"补充背景"里填写这句话的场合（什么时候说的、之前发生了什么），解码准确率会显著提升。',
    指数A: 20, 指数B: 20
  };
}

async function decode(promptParts, rawInput) {
  const provider = llmProvider();
  if (provider) {
    try {
      const result = provider === 'dashscope'
        ? await callDashScope(promptParts.system, promptParts.user)
        : await callAnthropic(promptParts.system, promptParts.user);
      return { result, source: 'llm:' + provider };
    } catch (e) {
      console.error(`[llm:${provider}] API失败，降级演示模式:`, e.message);
    }
  }
  return { result: demoRespond(rawInput), source: 'demo' };
}

module.exports = { decode, llmProvider };
