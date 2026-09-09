# YouTube 评论抓取器

一个运行在浏览器中的用户脚本（UserScript），用于抓取 YouTube 视频页的全部评论正文、作者、发布时间与点赞数，支持展开所有回复、按视频断点续抓，并导出为 JSON 或 CSV。

适用于需要收集评论语料、做舆情或内容分析的场景。脚本在页面本地完成采集与导出，不向任何第三方服务器发送数据。

## 功能

- **全量模式**：自动缓慢滚动评论区，逐条点开「N 条回复」，直到全部回复展开且页面不再增高
- **主评论模式**：只抓取一级评论，不展开回复，速度快、结果干净
- 导出每条评论的作者、发布时间、点赞数与「是否为回复」标记
- 去重以「作者 + 时间 + 正文」为准，不同用户的相同内容不会被合并
- 按视频维度记录抓取进度，中断或刷新后可继续
- 支持导出 JSON 与 CSV（CSV 带 BOM，Excel 打开不乱码）
- 抓取完成后自动下载 JSON
- 支持 `watch`、`shorts`、`youtu.be` 三种地址形式
- 进度节流落盘，写入失败或接近配额时面板会给出显式提示

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 点击安装脚本：[youtube-comments-crawler.user.js](https://github.com/Apical-7280/youtube-comments-crawler/raw/main/youtube-comments-crawler.user.js)
3. 也可以在脚本管理器中新建脚本，粘贴仓库中的源码

若 `raw.githubusercontent.com` 无法访问，可使用 jsDelivr 镜像安装（脚本的自动更新地址同样指向该镜像）：

```
https://cdn.jsdelivr.net/gh/Apical-7280/youtube-comments-crawler@main/youtube-comments-crawler.user.js
```

镜像为缓存加速服务，版本更新可能有数小时延迟；能直连 GitHub 时建议使用上方原始地址。

## 使用

1. 打开任意 YouTube 视频页面，等待评论区开始加载
2. 页面右上角会出现控制面板：

   | 按钮 | 作用 |
   | --- | --- |
   | 开始全量抓取 | 滚动并展开全部回复，抓取所有评论 |
   | 开始抓取主评论 | 清空本视频历史数据，只抓一级评论 |
   | 清空并重新全量抓取 | 清空本视频历史数据，重新全量抓取 |
   | 停止 | 暂停抓取并保留进度 |
   | 导出 JSON | 导出当前已抓取的数据 |
   | 导出 CSV | 导出当前已抓取的数据 |

3. 抓取过程中面板实时显示已抓条数、待展开回复数量与当前状态
4. 全量抓取完成后会自动下载 `youtube_comments_<视频 id>.json`

抓取期间可以正常操作浏览器，但请勿关闭或刷新页面。若中途中断，重新打开同一视频页面后脚本会自动继续。

## 输出格式

### JSON

```json
{
  "crawledAt": "2026-09-10T02:11:07.123Z",
  "videoId": "dQw4w9WgXcQ",
  "videoUrl": "https://www.youtube.com/watch",
  "videoTitle": "示例视频标题",
  "total": 2,
  "items": [
    {
      "text": "第一条评论正文",
      "author": "Alice",
      "publishedAt": "3 天前",
      "likes": "12",
      "isReply": false
    },
    {
      "text": "第二条评论正文\n可以包含换行",
      "author": "Bob",
      "publishedAt": "2 天前",
      "likes": "3",
      "isReply": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `crawledAt` | 导出时间（ISO 8601） |
| `videoId` | 视频 id |
| `videoUrl` | 视频页地址（不含查询参数） |
| `videoTitle` | 视频标题 |
| `total` | 评论条数 |
| `items[].text` | 评论或回复正文，保留换行 |
| `items[].author` | 作者显示名，取不到时为空串 |
| `items[].publishedAt` | 发布时间原文（如「3 天前」），取不到时为空串 |
| `items[].likes` | 点赞数原文（如「1.2K」），不做数值换算 |
| `items[].isReply` | 是否为回复；一级评论为 `false` |

### CSV

列顺序为 `text,author,publishedAt,likes,isReply`，每条评论一行，单元格使用双引号包裹，UTF-8 BOM 编码。`text` 仍为首列，按位置读取第一列的旧脚本可以继续工作。

## 实现说明

- 每轮只点击一个回复按钮，点击后先等待 2 轮让其展开，再处理下一个；批量点击会因页面响应不及而失败
- 滚动步长为视口高度的 0.5 倍，间隔 1.5 秒，接近人工浏览节奏
- 同一按钮两次点击之间有 6 秒冷却；点击后超过 12 秒仍未展开的按钮标记为无效，不再重试
- 判定抓取结束的条件：连续 10 轮既没有新增评论、页面高度也不再变化，且没有待展开的回复按钮
- 评论去重键为「作者 + 时间 + 正文」。1.0.0 抓取的历史数据仍按原「仅正文」键继续工作（载入时自动标记为旧键方案），不会与新记录产生重复
- 进度落盘节流：新增 50 条或距上次落盘 15 秒时写入一次；写入失败或序列化后超过 4 MB 时面板给出提示，此时进度仅保留在内存中，建议立即导出
- 抓取进度存放于 localStorage，键名 `yt_comments_store_v1`，按视频 id 分别保存
- 因 YouTube 启用 Trusted Types，界面通过 DOM API 构建，不使用 innerHTML
- 声明 `@grant none`，脚本不发起任何外部网络请求

## 开发与测试

评论解析（正文/回复区分、作者与时间提取、去重键、按钮文案识别）由 fixtures + jsdom 的单元测试覆盖：

```bash
npm install
npm test
```

- `tests/parser.test.js`：25 项断言，覆盖评论与回复提取、去重键、回复按钮文案识别、可见性过滤、视频 id 解析、导出格式与本地存储异常
- `tests/fixtures/comment-threads.html`、`tests/fixtures/comment-fallback.html`：评论区结构快照（脱敏）。YouTube 前端改版后，可用它们对照实际页面，快速定位是哪个选择器失效

## 注意事项

- 评论可见性受视频与账号设置影响：仅登录可见的评论需要先登录
- YouTube 会按需加载评论区，脚本会自动滚动触发加载，请保持页面在前台
- 点赞数与发布时间为页面展示原文，不做数值换算（不同语言环境的格式不同）
- 页面结构由 YouTube 官方维护，若前端改版可能导致解析失效
- 请遵守 YouTube 服务条款，控制抓取频率，仅将数据用于合规用途

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 兼容性

| 浏览器 | 脚本管理器 | 状态 |
| --- | --- | --- |
| Chrome / Edge | Tampermonkey | 已验证 |
| Chrome / Edge | Violentmonkey | 理论可用 |

## 许可

[MIT](LICENSE)
