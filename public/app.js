'use strict';
// API base：同时兼容根路径 / 和 Uppcoder 的 /app/ 子路径。
// Uppcoder 把 /app/ 代理到本服务端口；若代理去掉前缀，pathname 就是 /，
// 若保留前缀，pathname 以 /app/ 开头。两种情况都要能调通。
const IS_APP = location.pathname === '/app' || location.pathname.startsWith('/app/');
const API = IS_APP? './api': './api';
// 注意：用相对路径./api 时，浏览器会基于当前页面 URL 解析：
// 在 / 时 -> /api，在 /app/ 时 -> /app/api。服务端两种都接受。
// 为稳妥，统一用 fetch(API + '/...')，其中 API 固定为 './api'。

const $ = (id) => document.getElementById(id);
let bank = [];
let draft = [];
let currentPaper = null;
let viewMode = 'student';
let pendingResults = [];
let imageDataUrls = [];

async function api(path, opts) {
const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json'},...(opts || {})});
const t = await r.text();
let j; try { j = JSON.parse(t);} catch { throw new Error('服务器返回异常：' + t.slice(0, 200));}
if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
return j;
}
function esc(s) { return String(s == null? '': s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));}
function fmtOptions(q) { return (q.options || []).map(o => o.key + '. ' + o.text).join(' ');}

// ---- tabs ----
document.querySelectorAll('.tabs button').forEach(b => {
b.onclick = () => {
document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
b.classList.add('active');
$('tab-' + b.dataset.tab).classList.add('active');
if (b.dataset.tab === 'bank') loadBank();
if (b.dataset.tab === 'compose') loadManualPick();
if (b.dataset.tab === 'papers') loadPapers();
};
});

// ---- health ----
api('/health').then(h => {
$('health').textContent = '● 运行正常 · 题库 ' + h.counts.questions + ' 题 · 试卷 ' + h.counts.papers + ' 份 · ' + (h.llmConfigured? 'LLM 已配置（' + h.llmModel + '）': 'LLM 未配置，走规则解析');
}).catch(e => { $('health').textContent = '● 后端连接失败：' + e.message;});

// ---- 录入 ----
$('imp-file').onchange = async (e) => {
const f = e.target.files[0]; if (!f) return;
$('imp-text').value = await f.text();
$('imp-source').value = $('imp-source').value || f.name.replace(/\.(txt|md)$/i, '');
$('imp-status').textContent = '已读入文件：' + f.name;
};
$('imp-images').onchange = async (e) => {
const files = [...e.target.files].slice(0, 6);
imageDataUrls = [];
$('img-preview').innerHTML = '';
for (const f of files) {
const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f);});
imageDataUrls.push(url);
const img = document.createElement('img'); img.src = url; $('img-preview').appendChild(img);
}
$('imp-status').textContent = '已选 ' + imageDataUrls.length + ' 张图片。图片识别需要配置 LLM_API_KEY，否则请用文本识别。';
};
$('btn-sample').onclick = async () => {
$('imp-text').value = SAMPLE_TEXT;
$('imp-subject').value = '数学';
$('imp-source').value = '示例数学卷';
$('imp-status').textContent = '已载入示例卷，点“识别题目（文本）”试试。';
};
const SAMPLE_TEXT = `2026 年数学期中测试卷（示例）
科目：数学　满分：100 分　时间：90 分钟

一、选择题（每小题 5 分，共 10 分）
1. 下列函数中，在区间 (0, +∞) 上单调递增的是（ ）
A. y = x²
B. y = 1/x
C. y = -x + 1
D. y = 2⁻ˣ
2. 已知集合 A = {1, 2, 3}，B = {2, 3, 4}，则 A ∩ B =（ ）
A. {1, 2}
B. {2, 3}
C. {1, 4}
D. {3, 4}

二、填空题（每小题 5 分，共 10 分）
3. 函数 f(x) = x² - 4x + 3 的最小值是 ____。
4. 若 log₂ x = 3，则 x = ____。

三、计算题（每小题 10 分，共 20 分）
5. 计算：(2x + 1)(x - 3) - (x - 1)²，并化简结果。
6. 解方程：x² - 5x + 6 = 0。

参考答案
1. A
2. B
3. -1
4. 8
5. x² - 3x - 4
6. x = 2 或 x = 3`;

async function doRecognize(kind) {
const subject = $('imp-subject').value || '数学';
const source = $('imp-source').value || '未命名试卷';
$('imp-status').textContent = '识别中…';
try {
let out;
if (kind === 'text') {
const text = $('imp-text').value;
if (!text.trim()) { $('imp-status').textContent = '请先粘贴试卷文本或导入文件。'; return;}
out = await api('/recognize-text', { method: 'POST', body: JSON.stringify({ text, subject, sourceName: source})});
} else {
if (!imageDataUrls.length) { $('imp-status').textContent = '请先上传试卷图片。'; return;}
out = await api('/recognize-images', { method: 'POST', body: JSON.stringify({ images: imageDataUrls, subject, sourceName: source})});
}
pendingResults = (out.questions || []).map(q => ({...q, source, _sel: true}));
$('imp-status').textContent = '识别完成：' + out.count + ' 题（' + (out.engine === 'llm'? '大模型': '规则解析') + '）' + (out.note? ' — ' + out.note: '');
renderResults();
} catch (e) {
$('imp-status').textContent = '识别失败：' + e.message + (e.message.includes('LLM_API_KEY')? '\n提示：请配置 LLM_API_KEY，或把试卷内容粘贴为文本再识别。': '');
}
}
$('btn-recognize-text').onclick = () => doRecognize('text');
$('btn-recognize-img').onclick = () => doRecognize('img');

function renderResults() {
$('result-card').hidden =!pendingResults.length;
$('result-note').textContent = '答案只保留原文给出的；没有答案的题留空，不要编。请核对后再入库。';
$('result-list').innerHTML = pendingResults.map((q, i) => `
<div class="q">
<label><input type="checkbox" data-i="${i}" ${q._sel? 'checked': ''}> 入库这题</label>
<span class="meta"> #${i + 1} · ${esc(q.type || '')} · ${esc(q.subject || '')} · ${esc(q.difficulty || '')} · ${esc(q.knowledgePoint || '')}</span>
<div class="row">
<select data-f="type" data-i="${i}">${['单选', '多选', '填空', '判断', '简答', '计算', '解答', '应用'].map(t => `<option ${q.type === t? 'selected': ''}>${t}</option>`).join('')}</select>
<input data-f="score" data-i="${i}" type="number" value="${q.score || 5}" style="width:80px" placeholder="分值">
<select data-f="difficulty" data-i="${i}">${['简单', '中等', '较难'].map(t => `<option ${q.difficulty === t? 'selected': ''}>${t}</option>`).join('')}</select>
<input data-f="knowledgePoint" data-i="${i}" value="${esc(q.knowledgePoint || '')}" placeholder="知识点">
</div>
<textarea data-f="stem" data-i="${i}" rows="2">${esc(q.stem || '')}</textarea>
${(q.options || []).length? `<div class="opts">${esc(fmtOptions(q))}</div>`: ''}
<input data-f="answer" data-i="${i}" value="${esc(q.answer || '')}" placeholder="答案（原文没有就留空）">
</div>`).join('');
$('result-list').querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = () => pendingResults[+c.dataset.i]._sel = c.checked);
$('result-list').querySelectorAll('[data-f]').forEach(el => el.onchange = () => {
const q = pendingResults[+el.dataset.i];
q[el.dataset.f] = el.dataset.f === 'score'? Number(el.value) || 5: el.value;
});
}
$('btn-select-all').onclick = () => { pendingResults.forEach(q => q._sel = true); renderResults();};
$('btn-save-selected').onclick = async () => {
const sel = pendingResults.filter(q => q._sel).map(({ _sel,...rest}) => rest);
if (!sel.length) { $('imp-status').textContent = '请至少勾选一道题。'; return;}
const out = await api('/questions', { method: 'POST', body: JSON.stringify({ questions: sel})});
$('imp-status').textContent = '已入库 ' + out.added + ' 题。去“题库”查看，或去“组卷”组卷。';
pendingResults = []; $('result-card').hidden = true;
};

// ---- 题库 ----
async function loadBank() {
const params = new URLSearchParams();
if ($('f-type').value) params.set('type', $('f-type').value);
if ($('f-diff').value) params.set('difficulty', $('f-diff').value);
if ($('f-q').value.trim()) params.set('q', $('f-q').value.trim());
const out = await api('/questions?' + params.toString());
bank = out.questions || [];
$('bank-count').textContent = '共 ' + out.total + ' 题';
$('bank-list').innerHTML = bank.length? bank.map(q => `
<div class="q">
<div class="meta">${esc(q.type)} · ${esc(q.subject)} · ${esc(q.difficulty)} · ${q.score} 分 · ${esc(q.knowledgePoint || '')} · 来源：${esc(q.source || '')}</div>
<div class="stem">${esc(q.stem)}</div>
${q.options && q.options.length? `<div class="opts">${esc(fmtOptions(q))}</div>`: ''}
<div class="meta">答案：${esc(q.answer || '（原文未给）')}</div>
<div class="row"><button class="btn" onclick="editQ('${q.id}')">编辑</button>
<button class="btn danger" onclick="delQ('${q.id}')">删除</button>
<button class="btn ghost" onclick="addToDraft('${q.id}')">＋ 加入组卷草稿</button></div>
</div>`).join(''): '<p class="hint">题库还是空的。先去“录入识别”录一张卷，或点“手动添加”。</p>';
}
$('btn-filter').onclick = loadBank;
$('btn-add-manual').onclick = () => { $('manual-form').hidden = false; $('m-id').value = '';};
$('btn-cancel-manual').onclick = () => { $('manual-form').hidden = true;};
$('btn-save-manual').onclick = async () => {
const opts = $('m-options').value.split('|').map(s => s.trim()).filter(Boolean).map(s => {
const m = s.match(/^([A-D])[\.、．）\)\s]*(.*)$/); return m? { key: m[1], text: m[2]}: { key: '', text: s};
}).filter(o => o.key);
const rec = { type: $('m-type').value, subject: $('m-subject').value || '数学', score: Number($('m-score').value) || 5, difficulty: $('m-diff').value, knowledgePoint: $('m-kp').value, stem: $('m-stem').value.trim(), options: opts, answer: $('m-answer').value};
if (!rec.stem) { alert('请填写题干'); return;}
if ($('m-id').value) await api('/questions/' + $('m-id').value, { method: 'PUT', body: JSON.stringify(rec)});
else await api('/questions', { method: 'POST', body: JSON.stringify(rec)});
$('manual-form').hidden = true; loadBank();
};
window.editQ = (id) => {
const q = bank.find(x => x.id === id); if (!q) return;
$('manual-form').hidden = false;
$('m-id').value = q.id; $('m-type').value = q.type; $('m-subject').value = q.subject;
$('m-score').value = q.score; $('m-diff').value = q.difficulty; $('m-kp').value = q.knowledgePoint || '';
$('m-stem').value = q.stem; $('m-options').value = (q.options || []).map(o => o.key + '.' + o.text).join('|');
$('m-answer').value = q.answer || '';
window.scrollTo({ top: 0, behavior: 'smooth'});
};
window.delQ = async (id) => { if (!confirm('确定删除这道题？')) return; await api('/questions/' + id, { method: 'DELETE'}); loadBank();};
window.addToDraft = (id) => {
const q = bank.find(x => x.id === id); if (!q) return;
draft.push({...q, questionId: q.id}); renderDraft();
alert('已加入组卷草稿（共 ' + draft.length + ' 题）');
};

// ---- 组卷 ----
async function loadManualPick() {
const out = await api('/questions');
$('manual-pick-list').innerHTML = (out.questions || []).map(q => `
<label><input type="checkbox" data-id="${q.id}"> [${esc(q.type)}·${q.score}分] ${esc(q.stem.slice(0, 60))}</label>`).join('') || '<p class="hint">题库为空。</p>';
$('manual-pick-list').querySelectorAll('input').forEach(c => c.onchange = () => {
const q = (out.questions || []).find(x => x.id === c.dataset.id);
if (c.checked) draft.push({...q, questionId: q.id});
else draft = draft.filter(d => d.questionId!== q.id || d.stem!== q.stem);
renderDraft();
});
}
function renderDraft() {
$('draft-total').textContent = draft.reduce((s, d) => s + (Number(d.score) || 0), 0);
$('draft-list').innerHTML = draft.map((d, i) => `
<div class="q"><div class="meta">#${i + 1} · ${esc(d.type)} · ${esc(d.difficulty || '')}</div>
<div class="stem">${esc(d.stem)}</div>
<div class="row">分值 <input type="number" value="${d.score}" style="width:70px" onchange="draft[${i}].score=Number(this.value)||5;renderDraft()">
<button class="btn" onclick="moveDraft(${i},-1)">↑</button><button class="btn" onclick="moveDraft(${i},1)">↓</button>
<button class="btn danger" onclick="draft.splice(${i},1);renderDraft()">移除</button></div></div>`).join('') || '<p class="hint">草稿为空。用智能抽题或手动挑题加入。</p>';
}
window.moveDraft = (i, dir) => { const j = i + dir; if (j < 0 || j >= draft.length) return; [draft[i], draft[j]] = [draft[j], draft[i]]; renderDraft();};
$('btn-smart-pick').onclick = async () => {
const counts = {};
document.querySelectorAll('#pick-counts input').forEach(el => { const n = Number(el.value) || 0; if (n > 0) counts[el.dataset.type] = n;});
if (!Object.keys(counts).length) { $('pick-status').textContent = '请至少设置一种题型的数量。'; return;}
const out = await api('/smart-pick', { method: 'POST', body: JSON.stringify({ counts, difficulty: $('pick-diff').value, knowledgePoint: $('pick-kp').value.trim()})});
out.picked.forEach(q => draft.push({...q, questionId: q.id}));
const short = Object.entries(out.shortfall || {}).map(([t, s]) => t + ' 要 ' + s.wanted + ' 题只抽到 ' + s.got + ' 题（缺 ' + s.missing + ' 题）').join('；');
$('pick-status').textContent = '抽到 ' + out.pickedCount + ' 题，已加入草稿。' + (short? '\n题库不足：' + short + '。请先多录几张卷。': '');
renderDraft();
};
$('btn-clear-draft').onclick = () => { draft = []; renderDraft();};
$('btn-save-paper').onclick = async () => {
if (!draft.length) { $('compose-status').textContent = '草稿为空，先抽题或手动挑题。'; return;}
const out = await api('/papers', { method: 'POST', body: JSON.stringify({ title: $('paper-title').value || '未命名试卷', subject: $('paper-subject').value || '数学', examTime: $('paper-time').value, items: draft})});
$('compose-status').textContent = '已保存成卷：' + out.paper.title + '，总分 ' + out.paper.totalScore + ' 分。去“我的试卷”查看。';
draft = []; renderDraft();
};

// ---- 我的试卷 ----
async function loadPapers() {
const out = await api('/papers');
$('papers-list').innerHTML = (out.papers || []).map(p => `
<div class="q"><div class="stem">${esc(p.title)}</div>
<div class="meta">${esc(p.subject)} · ${esc(p.examTime || '')} · 总分 ${p.totalScore} 分 · ${p.items.length} 题 · ${new Date(p.createdAt).toLocaleString()}</div>
<div class="row"><button class="btn" onclick="viewPaper('${p.id}')">查看</button>
<button class="btn danger" onclick="delPaper('${p.id}')">删除</button></div></div>`).join('') || '<p class="hint">还没有试卷。去“组卷”组一张吧。</p>';
$('paper-view').hidden = true;
}
window.delPaper = async (id) => { if (!confirm('确定删除这份试卷？')) return; await api('/papers/' + id, { method: 'DELETE'}); loadPapers();};
window.viewPaper = async (id) => {
const out = await api('/papers/' + id);
currentPaper = out.paper; renderPaperText();
$('paper-view').hidden = false;
};
function paperText(p, teacher) {
const lines = [p.title, p.subject + (p.examTime? '　考试时间：' + p.examTime: '') + '　总分：' + p.totalScore + ' 分', ''];
let lastType = '';
p.items.forEach((it, i) => {
if (it.type!== lastType) { lines.push(''); lastType = it.type;}
lines.push((i + 1) + '. ' + it.stem + '（' + it.score + ' 分）');
if (it.options && it.options.length) lines.push(' ' + fmtOptions(it));
if (teacher && it.answer) lines.push(' 答案：' + it.answer);
lines.push('');
});
return lines.join('\n');
}
function renderPaperText() { if (currentPaper) $('paper-text').textContent = paperText(currentPaper, viewMode === 'teacher');}
$('btn-view-student').onclick = () => { viewMode = 'student'; renderPaperText();};
$('btn-view-teacher').onclick = () => { viewMode = 'teacher'; renderPaperText();};
$('btn-download-txt').onclick = () => {
if (!currentPaper) return;
const blob = new Blob([paperText(currentPaper, viewMode === 'teacher')], { type: 'text/plain;charset=utf-8'});
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = currentPaper.title + '.txt'; a.click();
};
$('btn-copy-paper').onclick = async () => {
if (!currentPaper) return;
await navigator.clipboard.writeText(paperText(currentPaper, viewMode === 'teacher'));
alert('已复制全文，可粘贴到 Word 排版打印。');
};
loadBank();
