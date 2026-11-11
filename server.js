'use strict';
/**
 * 智能组卷助手 — Uppcoder-ready WEB 服务
 * 零依赖：只用 Node.js 标准库。无构建步骤，无原生模块。
 * 启动：node server.js  (PORT 环境变量，默认 8000)
 * 数据：./data/questions.json / papers.json / sources.json（纯 JSON 文件）
 * 部署要点：Uppcoder 把 /app/ 代理到本服务端口，根路径是开发环境页，
 * 所以本服务必须同时接受 /api/... 和 /app/api/...，静态资源用相对路径。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim();
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- JSON 文件存储 ----------
function loadJson(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('load', name, e.message); return fallback; }
}
function saveJson(name, data) {
  const p = path.join(DATA_DIR, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
let questions = loadJson('questions.json', []);
let papers = loadJson('papers.json', []);
let sources = loadJson('sources.json', []);
if (!Array.isArray(questions)) questions = [];
if (!Array.isArray(papers)) papers = [];
if (!Array.isArray(sources)) sources = [];

function newId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

// ---------- 规则解析器（无 LLM 时的默认识别通道） ----------
const DEFAULT_SCORE = { '单选': 5, '多选': 5, '判断': 5, '填空': 5, '简答': 10, '计算': 10, '解答': 10, '应用': 10 };
const SECTION_TYPES = [
  ['选择', '单选'], ['单选', '单选'], ['多选', '多选'],
  ['填空', '填空'], ['判断', '判断'],
  ['计算', '计算'], ['解答', '解答'], ['简答', '简答'], ['应用', '应用'], ['证明', '解答'],
];
function guessKnowledgePoint(stem, subject) {
  const text = stem || '';
  const map = [
    ['函数', '函数'], ['方程', '方程'], ['不等式', '不等式'], ['集合', '集合'],
    ['几何', '几何'], ['三角', '三角函数'], ['概率', '概率'], ['数列', '数列'],
    ['导数', '导数'], ['向量', '向量'], ['对数', '对数'], ['log', '对数'], ['指数', '指数'],
    ['化学', '化学'], ['物理', '物理'], ['英语', '英语'], ['语文', '语文'],
  ];
  for (const [kw, kp] of map) if (text.includes(kw)) return kp;
  return subject || '';
}
function parseAnswerSection(text) {
  // 返回 { mainText, answers: Map<number,string> }
  const lines = text.split(/\r?\n/);
  let splitIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(参考答案|答案|答案与解析|参考解析)\s*[:：]?\s*$/.test(lines[i])) { splitIdx = i; break; }
  }
  if (splitIdx < 0) return { mainText: text, answers: new Map() };
  const mainText = lines.slice(0, splitIdx).join('\n');
  const answers = new Map();
  const ansText = lines.slice(splitIdx + 1).join('\n');
  // 1. A / 1、A / 1．C / 第1题 A / 1 A
  const re = /(?:^|\n)\s*(?:第\s*)?(\d{1,2})\s*[\.、．）\)\s:：]+([A-D]|√|×|对|错|[^\n]{1,60})/g;
  let m;
  while ((m = re.exec(ansText)) !== null) {
    const n = parseInt(m[1], 10);
    const v = (m[2] || '').trim();
    if (v && !answers.has(n)) answers.set(n, v);
  }
  return { mainText, answers };
}

function extractOptions(chunk) {
  // 选项一般是 A. xxx B. xxx C. xxx D. xxx，可能同行也可能分行
  const flat = chunk.replace(/\s*\n\s*/g, ' ');
  const optRe = /([A-D])[\.、．）\)]\s*([^A-D]{1,120}?)(?=\s+[A-D][\.、．）\)]|\s*$)/g;
  const options = [];
  let m; let count = 0;
  while ((m = optRe.exec(flat)) !== null && count < 6) {
    const letter = m[1];
    let val = (m[2] || '').trim().replace(/\s+/g, ' ');
    // 去掉尾部残留的题干碎片
    if (!val) continue;
    // 避免把题干误当选项：选项值通常较短
    if (val.length > 80) val = val.slice(0, 80);
    if (options.some(o => o.key === letter)) continue;
    options.push({ key: letter, text: val });
    count++;
  }
  // 只有 A/B 两个不算选择题；至少要有 A、B、C 三个或 A、B 且带“（ ）”
  if (options.length < 2) return [];
  return options;
}

function parseQuestionsFromText(rawText, subject) {
  const subj = (subject || '').trim() || '数学';
  const { mainText, answers } = parseAnswerSection(rawText);
  const text = mainText.replace(/\r\n/g, '\n');
  // 找到每道题的起始位置：行首的 1. / 1、 / （1） / 1） 等
  const startRe = /(?:^|\n)\s*(?:（\s*(\d{1,2})\s*）|(\d{1,2})[\.、．）\)])\s+/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(text)) !== null) {
    const num = parseInt(m[1] || m[2], 10);
    // 排除页眉/分值行等误伤：题号应连续或递增，且后面有实质内容
    starts.push({ num, index: m.index, offset: m[0].length, raw: m[0] });
  }
  if (starts.length === 0) {
    // 整段当作一道题
    const stem = text.trim();
    if (!stem) return [];
    return [makeQuestion(1, stem, '简答', subj, answers)];
  }
  // 去重：同一题号只保留第一次
  const seen = new Set(); const uniq = [];
  for (const s of starts) { if (!seen.has(s.num)) { seen.add(s.num); uniq.push(s); } }
  const questionsOut = [];
  // 当前题型：按小节标题推进
  const lines = text.split('\n');
  for (let i = 0; i < uniq.length; i++) {
    const s = uniq[i];
    const startPos = s.index + s.raw.length - (s.raw.startsWith('\n') ? 1 : 0);
    // 实际题干起点：startRe 的 match 结束位置
    const matchEnd = text.indexOf(s.raw.trim().split(/\s+/).pop(), s.index); // 不可靠，回退
    void matchEnd;
    const contentStart = s.index + s.raw.length;
    const contentEnd = (i + 1 < uniq.length) ? uniq[i + 1].index : text.length;
    let chunk = text.slice(contentStart, contentEnd).trim();
    if (!chunk) continue;
    // 小节标题：取本段之前最近的含题型关键词的行
    const before = text.slice(0, s.index);
    const beforeLines = before.split('\n').slice(-6);
    let sectionType = null;
    for (let j = beforeLines.length - 1; j >= 0; j--) {
      const line = beforeLines[j] || '';
      for (const [kw, t] of SECTION_TYPES) {
        if (line.includes(kw) && /题/.test(line)) { sectionType = t; break; }
      }
      if (sectionType) break;
    }
    questionsOut.push(buildOne(s.num, chunk, sectionType, subj, answers));
  }
  return questionsOut;
}
function makeQuestion(num, stem, type, subj, answers) {
  return buildOne(num, stem, type, subj, answers);
}
function stripSectionHeaders(chunk) {
  return chunk.split('\n').filter(line => !/^\s*[一二三四五六七八九十]+[、．.）\)]\s*(选择|填空|判断|简答|计算|解答|应用|证明)/.test(line) && !/^\s*(选择题|填空题|判断题|简答题|计算题|解答题|应用题)/.test(line)).join('\n');
}
function buildOne(num, chunk, sectionType, subj, answers) {
  chunk = stripSectionHeaders(chunk);
  const options = extractOptions(chunk);
  let stem = chunk;
  let type = sectionType || null;
  if (options.length >= 2) {
    // 把选项从题干里剥离
    const idxA = stem.search(/\bA[\.、．）\)]/);
    if (idxA > 0) stem = stem.slice(0, idxA).trim();
    if (!type) type = '单选';
    // 多选提示
    if (/多选|不定项|多选题/.test(chunk)) type = '多选';
  }
  if (!type) {
    if (/____|___|（\s*）\s*[。，；,、]|填空/.test(stem)) type = '填空';
    else if (/判断|对错|正确.*错误|√|×/.test(stem)) type = '判断';
    else if (/计算|化简|求值|解方程|解不等式/.test(stem)) type = '计算';
    else if (stem.length > 120) type = '简答';
    else type = '简答';
  }
  // 填空题题干保留下划线；选择题题干去掉末尾的（ ）
  stem = stem.replace(/\s+/g, ' ').trim();
  let answer = answers.get(num) || '';
  // 判断题答案归一化
  if (type === '判断' && answer) {
    if (answer === '√' || answer === '对' || /正确/.test(answer)) answer = '对';
    if (answer === '×' || answer === '错' || /错误/.test(answer)) answer = '错';
  }
  return {
    type,
    stem,
    options: options.length >= 2 ? options : [],
    answer,
    score: DEFAULT_SCORE[type] || 5,
    difficulty: '中等',
    subject: subj,
    knowledgePoint: guessKnowledgePoint(stem, subj),
    source: '',
    _num: num,
  };
}

// ---------- LLM（可选） ----------
async function callLLMJSON(systemPrompt, userContent) {
  // userContent: string 或 [{type:'text',...},{type:'image_url',...}]
  const url = LLM_BASE_URL + '/chat/completions';
  const body = JSON.stringify({
    model: LLM_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_API_KEY },
    body,
  });
  if (!res.ok) throw new Error('LLM 请求失败 HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const jsonText = extractJson(content);
  return JSON.parse(jsonText);
}
function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  const aStart = s.indexOf('['); const aEnd = s.lastIndexOf(']');
  if (aStart >= 0 && aEnd > aStart) return s.slice(aStart, aEnd + 1);
  return s;
}
const LLM_SYSTEM = [
  '你是一个试卷识别助手。把用户提供的试卷内容拆成一道道题目，只输出 JSON。',
  '输出格式：{"questions":[{"type":"单选|多选|填空|判断|简答|计算|解答|应用","stem":"题干原文","options":[{"key":"A","text":"..."}],"answer":"","score":5,"difficulty":"简单|中等|较难","subject":"科目","knowledgePoint":"知识点"}]}',
  '严格规则：答案（answer）只能填原文中明确给出的答案；原文没有答案就留空字符串，绝不编造、绝不猜测。',
  '选项只在选择题里给；填空题题干保留 ____；不要改写题干原文。',
].join('\n');

// ---------- HTTP 工具 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > (maxBytes || 10 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function normalizePath(rawPath) {
  // Uppcoder 把 /app/ 代理到本服务：/app/api/... 和 /api/... 都要能用
  let p = decodeURIComponent(rawPath || '/');
  if (p === '/app' || p === '/app/') return '/';
  if (p.startsWith('/app/')) p = p.slice(4);
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = normalizePath(u.pathname);
    const method = req.method;

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, service: 'zujuan-uppcoder', time: nowIso(), llmConfigured: !!LLM_API_KEY, llmModel: LLM_MODEL, counts: { questions: questions.length, papers: papers.length, sources: sources.length } });
      }
      // POST /api/recognize-text
      if (method === 'POST' && pathname === '/api/recognize-text') {
        const body = JSON.parse(await readBody(req) || '{}');
        const text = (body.text || '').toString();
        const subject = (body.subject || '数学').toString();
        if (!text.trim()) return sendJson(res, 400, { ok: false, error: '请先粘贴试卷文本或导入 .txt/.md 文件' });
        let parsed = [];
        let engine = 'rule';
        if (LLM_API_KEY) {
          try {
            const out = await callLLMJSON(LLM_SYSTEM, '科目：' + subject + '\n\n试卷内容：\n' + text);
            if (Array.isArray(out.questions) && out.questions.length) { parsed = out.questions; engine = 'llm'; }
          } catch (e) { console.error('LLM 失败，回退规则解析:', e.message); }
        }
        if (!parsed.length) parsed = parseQuestionsFromText(text, subject);
        parsed = parsed.map(q => ({ ...q, source: body.sourceName || '粘贴文本', _num: undefined }));
        return sendJson(res, 200, { ok: true, engine, llmConfigured: !!LLM_API_KEY, questions: parsed, count: parsed.length, note: engine === 'rule' ? '未配置 LLM_API_KEY，使用内置规则解析；答案只保留原文给出的。' : '已用大模型识别；答案只保留原文给出的。' });
      }
      // POST /api/recognize-images
      if (method === 'POST' && pathname === '/api/recognize-images') {
        const body = JSON.parse(await readBody(req) || '{}');
        const images = Array.isArray(body.images) ? body.images : [];
        const subject = (body.subject || '数学').toString();
        if (!images.length) return sendJson(res, 400, { ok: false, error: '请先上传试卷图片（最多 6 张）' });
        if (images.length > 6) return sendJson(res, 400, { ok: false, error: '最多 6 张图片' });
        if (!LLM_API_KEY) {
          return sendJson(res, 400, { ok: false, error: '图片识别需要大模型（LLM_API_KEY 未配置）', hint: '请先配置 LLM_API_KEY，或把试卷内容粘贴为文本再识别；PDF 请先截图或导出为图片再上传。', engine: 'none' });
        }
        const content = [{ type: 'text', text: '科目：' + subject + '。请识别这几张试卷图片中的全部题目，按 JSON 格式输出。' }];
        for (const img of images.slice(0, 6)) {
          const dataUrl = String(img).startsWith('data:') ? String(img) : 'data:image/jpeg;base64,' + String(img);
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
        try {
          const out = await callLLMJSON(LLM_SYSTEM, content);
          const parsed = (out.questions || []).map(q => ({ ...q, source: body.sourceName || '图片识别' }));
          return sendJson(res, 200, { ok: true, engine: 'llm', questions: parsed, count: parsed.length });
        } catch (e) {
          console.error('图片识别失败:', e.message);
          return sendJson(res, 502, { ok: false, error: '大模型识别失败：' + e.message });
        }
      }
      // GET /api/questions
      if (method === 'GET' && pathname === '/api/questions') {
        const subject = u.searchParams.get('subject') || '';
        const type = u.searchParams.get('type') || '';
        const difficulty = u.searchParams.get('difficulty') || '';
        const source = u.searchParams.get('source') || '';
        const q = (u.searchParams.get('q') || '').toLowerCase();
        let list = questions.slice();
        if (subject) list = list.filter(x => x.subject === subject);
        if (type) list = list.filter(x => x.type === type);
        if (difficulty) list = list.filter(x => x.difficulty === difficulty);
        if (source) list = list.filter(x => x.source === source);
        if (q) list = list.filter(x => ((x.stem || '') + (x.knowledgePoint || '') + (x.subject || '')).toLowerCase().includes(q));
        return sendJson(res, 200, { ok: true, total: list.length, questions: list });
      }
      // POST /api/questions
      if (method === 'POST' && pathname === '/api/questions') {
        const body = JSON.parse(await readBody(req) || '{}');
        const incoming = Array.isArray(body.questions) ? body.questions : [body];
        const added = [];
        for (const item of incoming) {
          if (!item || !(item.stem || '').toString().trim()) continue;
          const rec = {
            id: newId(),
            type: item.type || '简答',
            stem: String(item.stem).trim(),
            options: Array.isArray(item.options) ? item.options : [],
            answer: item.answer || '',
            score: Number(item.score) || 5,
            difficulty: item.difficulty || '中等',
            subject: item.subject || '数学',
            knowledgePoint: item.knowledgePoint || '',
            source: item.source || '手动添加',
            createdAt: nowIso(),
          };
          questions.push(rec); added.push(rec);
        }
        saveJson('questions.json', questions);
        return sendJson(res, 200, { ok: true, added: added.length, questions: added });
      }
      // PUT / DELETE /api/questions/:id
      if ((method === 'PUT' || method === 'DELETE') && pathname.startsWith('/api/questions/')) {
        const id = pathname.slice('/api/questions/'.length);
        const idx = questions.findIndex(x => x.id === id);
        if (idx < 0) return sendJson(res, 404, { ok: false, error: '题目不存在' });
        if (method === 'DELETE') {
          questions.splice(idx, 1); saveJson('questions.json', questions);
          return sendJson(res, 200, { ok: true });
        }
        const body = JSON.parse(await readBody(req) || '{}');
        questions[idx] = { ...questions[idx], ...body, id: questions[idx].id };
        saveJson('questions.json', questions);
        return sendJson(res, 200, { ok: true, question: questions[idx] });
      }
      // POST /api/smart-pick
      if (method === 'POST' && pathname === '/api/smart-pick') {
        const body = JSON.parse(await readBody(req) || '{}');
        const counts = body.counts || {};
        const difficulty = body.difficulty || '';
        const knowledgePoint = (body.knowledgePoint || '').trim();
        const picked = []; const shortfall = {};
        for (const [type, wantRaw] of Object.entries(counts)) {
          const want = Number(wantRaw) || 0;
          if (want <= 0) continue;
          let pool = questions.filter(x => x.type === type);
          if (difficulty) pool = pool.filter(x => x.difficulty === difficulty);
          if (knowledgePoint) pool = pool.filter(x => (x.knowledgePoint || '').includes(knowledgePoint));
          // 洗牌后取
          const shuffled = pool.slice().sort(() => Math.random() - 0.5);
          const take = shuffled.slice(0, want);
          picked.push(...take);
          if (take.length < want) shortfall[type] = { wanted: want, got: take.length, missing: want - take.length };
        }
        return sendJson(res, 200, { ok: true, picked, shortfall, pickedCount: picked.length });
      }
      // GET / POST /api/papers
      if (method === 'GET' && pathname === '/api/papers') {
        return sendJson(res, 200, { ok: true, total: papers.length, papers });
      }
      if (method === 'POST' && pathname === '/api/papers') {
        const body = JSON.parse(await readBody(req) || '{}');
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) return sendJson(res, 400, { ok: false, error: '试卷至少要有一道题' });
        const paper = {
          id: newId(),
          title: body.title || '未命名试卷',
          subject: body.subject || '数学',
          examTime: body.examTime || '',
          totalScore: items.reduce((s, it) => s + (Number(it.score) || 0), 0),
          items: items.map((it, i) => ({ order: i + 1, questionId: it.questionId || it.id || '', type: it.type || '简答', stem: it.stem || '', options: it.options || [], answer: it.answer || '', score: Number(it.score) || 5, difficulty: it.difficulty || '中等', knowledgePoint: it.knowledgePoint || '' })),
          createdAt: nowIso(),
        };
        papers.unshift(paper); saveJson('papers.json', papers);
        return sendJson(res, 200, { ok: true, paper });
      }
      if (method === 'GET' && pathname.startsWith('/api/papers/')) {
        const id = pathname.slice('/api/papers/'.length);
        const p = papers.find(x => x.id === id);
        if (!p) return sendJson(res, 404, { ok: false, error: '试卷不存在' });
        return sendJson(res, 200, { ok: true, paper: p });
      }
      if (method === 'DELETE' && pathname.startsWith('/api/papers/')) {
        const id = pathname.slice('/api/papers/'.length);
        const idx = papers.findIndex(x => x.id === id);
        if (idx < 0) return sendJson(res, 404, { ok: false, error: '试卷不存在' });
        papers.splice(idx, 1); saveJson('papers.json', papers);
        return sendJson(res, 200, { ok: true });
      }
      // GET /api/sources
      if (method === 'GET' && pathname === '/api/sources') {
        const set = new Set(questions.map(x => x.source).filter(Boolean));
        return sendJson(res, 200, { ok: true, sources: [...set] });
      }
      return sendJson(res, 404, { ok: false, error: '未知接口：' + pathname });
    }

    // ---- 静态文件 ----
    let filePath = pathname === '/' ? '/index.html' : pathname;
    // 防止目录穿越
    const safe = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    let full = path.join(PUBLIC_DIR, safe);
    if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full)) {
      // 未知路径回 index.html（单页应用）
      full = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('智能组卷助手已启动 http://' + HOST + ':' + PORT + '/  (LLM: ' + (LLM_API_KEY ? '已配置 ' + LLM_MODEL : '未配置，走规则解析') + ')');
});
