# 部署到 Uppcoder（Spark 免费版）

## ⚠️ 先看这条：1 个 Stack 的冲突

Uppcoder Spark 免费版只有 **1 个常驻 Stack**，目前这个名额被 **Kaveyl Wiki** 占着。

所以部署本服务前必须二选一：

1. **删掉 / 停掉 Kaveyl 的 Stack，换成这个组卷服务**（Kaveyl 的笔记在 `/home/uppcoder/app/kaveyl-wiki/docs`，删 Stack 前先备份 docs 目录，否则笔记会丢）
2. **不换**：只在本地 / Debian 服务器上用 Docker 跑本服务（见 `README.md` 的 Docker 一节），Uppcoder 上继续留 Kaveyl

不要两个都想要——Spark 免费版给不了第二个常驻 Stack。

## 部署步骤

1. 把本目录推到 GitHub（新建仓库，如 `zujuan-uppcoder`，分支 `main`）
   ```bash
   cd ~/workspace/zujuan-uppcoder
   git init && git add . && git commit -m "智能组卷助手"
   git remote add origin https://github.com/<你的用户名>/zujuan-uppcoder.git
   git push -u origin main
   ```
   注意：`data/` 和 `.env` 已在 `.gitignore` 里，不会推上去。

2. Uppcoder 后台 → 新建 Stack → 选 **Blank / Node.js**（不要选 Docker，不要加数据库组件）
   - 仓库连上面那个 GitHub 仓库，分支 `main`
   - Node 版本选 24 或 26（本服务要求 Node ≥ 20，`engines` 已写）
   - **不要加数据库**：数据存在 `./data/*.json`，不需要数据库组件

3. 构建 / 启动设置
   - Build 命令：留空，或 `npm install`（本项目零依赖，装了也是空操作）
   - Start 命令：`node server.js`
   - 端口：`8000`（服务监听 `process.env.PORT || 8000`）

4. 访问地址
   - Uppcoder 会给一个公开域名，根路径 `/` 是开发环境页，**应用在 `/app/`**
   - 打开 `https://<你的域名>/app/` 即可用
   - 本服务已处理子路径：`/app/api/...` 和 `/api/...` 都能用，前端资源全是相对路径，不用改代码

5. 环境变量（可选，在 Stack 设置或终端里设）
   - `LLM_API_KEY`：不填也能用（规则解析 + 文本识别）；想用图片识别 / 大模型识别才填
   - `LLM_BASE_URL`：默认 `https://api.openai.com/v1`
   - `LLM_MODEL`：默认 `gpt-4o-mini`

## 数据持久化警告

- 题目和试卷存在容器里的 `./data/*.json`
- **容器重建 / 重新部署后数据会丢**，Uppcoder 免费版不保证持久化
- 备份办法（部署后定期做）：
  ```bash
  curl https://<你的域名>/app/api/questions > questions-backup.json
  curl https://<你的域名>/app/api/papers > papers-backup.json
  ```
  恢复：把备份文件放回服务器 `./data/questions.json`、`./data/papers.json` 后重启服务。

## 本地先验证（推仓库之前）

```bash
node server.js
curl http://127.0.0.1:8000/api/health
curl -X POST http://127.0.0.1:8000/api/recognize-text \
  -H 'Content-Type: application/json' \
  -d @- < sample-paper.txt
# 更简单的办法：直接用 sample-paper.txt 的内容当 text 字段发过去，
# 或在页面上点“载入示例卷” → “识别题目（文本）”
```
