# 每日养分 · 个人工作台（GitHub Pages 版 · 纯前端）

纯前端静态工作台，部署在 GitHub Pages。本仓库**只包含前端静态文件**，不含任何抓取/后端代码。

## 架构
- 本仓库（`main` 分支根目录）即 GitHub Pages 实际服务的内容：`index.html` / `app.js` / `styles.css` / `heat-core.js` / `seed.json` 等。
- 内容的抓取与热度计算在**别处**（WorkBuddy 云端自动化）每日运行，生成最新的 `seed.json` 后推送回本仓库，GitHub Pages 随即更新。
- 因此公开仓库中没有任何服务端/抓取逻辑，仅前端。

## 每日更新
WorkBuddy 云端自动化每日 07:00（北京时间）运行抓取脚本生成 `seed.json`，推送到本仓库 `main` 分支，Pages 自动生效。也可在本地 `git pull` 后手动推送最新 `seed.json` 立即更新。

## 本地预览
```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 说明：原 CloudStudio 免费静态托管偶发 502，已迁移至 GitHub Pages 以获得稳定访问；抓取逻辑保留在私有工作区，不公开。
