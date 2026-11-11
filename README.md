# 智能组卷助手 — 可部署 WEB 服务

录入电子档试卷，识别题目，自由组卷。独立服务，不依赖 Muse。

## 功能

- **录入识别**：粘贴文本 / 导入 `.txt/.md` / 上传试卷图片（最多 6 张），识别成题目
  - 未配置 LLM 时走内置规则解析：按题号拆题、按小节标题认题型（选择 / 填空 / 判断 / 简答 / 计算 / 解答）、抽 A–D 选项、读“参考答案”小节
  - 配置 `LLM_API_KEY` 后走大模型识别，图片识别也需要 LLM
  - **答案只保留原文给出的，绝不编造**；没有答案的题留空
- **题库**：按题型 / 难度 / 关键词筛选、搜索、编辑、删除、手动添加
- **组卷**：按题型数量智能随机抽题（题库不够会如实报缺口），或手动挑题；草稿可上下调序、改每题分值，总分自动汇总
- **我的试卷**：学生版（无答案）/ 教师版（含答案），下载 `.txt`、复制全文去 Word 排版打印
- 示例：点“载入示例卷”可直接体验（6 道数学题）

## 技术

- **零依赖**：只用 Node.js 标准库，无 `npm install`、无构建、无原生模块
- 数据：纯 JSON 文件 `./data/questions.json`、`papers.json`、`sources.json`
- 端口：`PORT` 环境变量，默认 `8000`，监听 `0.0.0.0`
- 子路径：同时接受 `/api/...` 和 `/app/api/...`，前端资源用相对路径，在根路径和 `/app/` 下都能跑

## 本地运行

```bash
node server.js
# 打开 http://127.0.0.1:8000/
```

可选：复制 `.env.example` 为 `.env`，或直接设环境变量：

```bash
LLM_API_KEY=sk-... LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini node server.js
```

## API（全部 JSON）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 题库/试卷计数 + LLM 是否配置 |
| POST | `/api/recognize-text` | `{text, subject, sourceName}` → `{questions}` |
| POST | `/api/recognize-images` | `{images:[base64/dataURL...], subject}`，无 LLM 时返回明确错误 |
| GET | `/api/questions?subject=&type=&difficulty=&q=&source=` | 查题库（也是导出题库的办法） |
| POST | `/api/questions` | 单题或 `{questions:[...]}` 批量入库 |
| PUT / DELETE | `/api/questions/:id` | 编辑 / 删除 |
| POST | `/api/smart-pick` | `{counts:{单选:2,...}, difficulty, knowledgePoint}` → `{picked, shortfall}` |
| GET / POST | `/api/papers` | 查卷 / 保存成卷 |
| GET / DELETE | `/api/papers/:id` | 查一份卷 / 删除 |
| GET | `/api/sources` | 来源列表 |

## Docker（备用）

```bash
docker compose up -d
# 打开 http://127.0.0.1:8000/
```

## 部署到 Uppcoder

见 `README_UPPCODER.md`。**注意：Spark 免费版只有 1 个常驻 Stack，目前已被 Kaveyl Wiki 占用，部署本服务要先处理这层冲突。**
