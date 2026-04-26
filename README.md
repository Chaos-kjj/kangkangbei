# Cloudflare Pages 部署说明

这个目录只包含可以公开部署的前端静态文件：

- `index.html`
- `reader-text-cleaner.js`
- `reader-epub-parser.js`
- `manifest.webmanifest`
- `sw.js`
- `icon.svg`
- `icon-180.png`
- `icon-192.png`
- `icon-512.png`
- `.nojekyll`

不要把项目根目录里的 `server.js`、`api/`、`node_modules/`、`.bat`、`.lnk`、`cloudflared.exe` 上传到公开仓库。

## Cloudflare Pages 设置

如果 GitHub 仓库根目录就是本目录里的这些文件：

- Framework preset: `None`
- Build command: `exit 0`
- Output directory: `/`
- Environment variables: 不需要

如果你把整个项目上传到 GitHub，并让 Cloudflare 从项目根目录构建：

- Framework preset: `None`
- Build command: `exit 0`
- Output directory: `deploy`
- Environment variables: 不需要

AI 功能使用页面右上角的 API 设置，API Key 只保存在当前浏览器本地，不要写进代码或仓库。

## 简短流程

1. 新建 GitHub 仓库。
2. 上传本目录里的文件到仓库根目录，或者上传整个项目并把输出目录设为 `deploy`。
3. 在 Cloudflare Pages 里连接这个 GitHub 仓库。
4. 按上面的设置部署。
5. 部署完成后用 `https://你的项目.pages.dev` 打开；iPhone 上可用 Safari 分享按钮添加到主屏幕。
