# YouTube 评论抓取器

一个运行在浏览器中的用户脚本（UserScript），用于抓取 YouTube 视频页的全部评论正文，支持展开所有回复、按视频断点续抓，并导出为 JSON 或 CSV。

适用于需要收集评论语料、做舆情或内容分析的场景。脚本在页面本地完成采集与导出，不向任何第三方服务器发送数据。

## 功能

- **全量模式**：自动缓慢滚动评论区，逐条点开「N 条回复」，直到全部回复展开且页面不再增高
- **主评论模式**：只抓取一级评论，不展开回复，速度快、结果干净
- 按视频维度记录抓取进度，中断或刷新后可继续
- 支持导出 JSON 与 CSV（CSV 带 BOM，Excel 打开不乱码）
- 抓取完成后自动下载 JSON
- 支持 `watch`、`shorts`、`youtu.be` 三种地址形式

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 点击安装脚本：[youtube-comments-crawler.user.js](https://github.com/Apical-7280/youtube-comments-crawler/raw/main/youtube-comments-crawler.user.js)
3. 也可以在脚本管理器中新建脚本，粘贴仓库中的源码

若 `raw.githubusercontent.com` 无法访问，可使用 jsDelivr 镜像安装：

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
    { "text": "第一条评论正文" },
    { "text": "第二条评论正文\n可以包含换行" }
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

### CSV

单列 `text`，每条评论一行，单元格使用双引号包裹，UTF-8 BOM 编码。

## 实现说明

- 每轮只点击一个回复按钮，点击后先等待 2 轮让其展开，再处理下一个；批量点击会因页面响应不及而失败
- 滚动步长为视口高度的 0.5 倍，间隔 1.5 秒，接近人工浏览节奏
- 同一按钮两次点击之间有 6 秒冷却；点击后超过 12 秒仍未展开的按钮标记为无效，不再重试
- 判定抓取结束的条件：连续 10 轮既没有新增评论、页面高度也不再变化，且没有待展开的回复按钮
- 抓取进度存放于 localStorage，键名 `yt_comments_store_v1`，按视频 id 分别保存
- 因 YouTube 启用 Trusted Types，界面通过 DOM API 构建，不使用 innerHTML
- 声明 `@grant none`，脚本不发起任何外部网络请求

## 注意事项

- 评论可见性受视频与账号设置影响：仅登录可见的评论需要先登录
- YouTube 会按需加载评论区，脚本会自动滚动触发加载，请保持页面在前台
- 页面结构由 YouTube 官方维护，若前端改版可能导致解析失效
- 请遵守 YouTube 服务条款，控制抓取频率，仅将数据用于合规用途

## 兼容性

| 浏览器 | 脚本管理器 | 状态 |
| --- | --- | --- |
| Chrome / Edge | Tampermonkey | 已验证 |
| Chrome / Edge | Violentmonkey | 理论可用 |

## 许可

[MIT](LICENSE)
