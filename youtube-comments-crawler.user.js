// ==UserScript==
// @name         YouTube 评论抓取器
// @namespace    https://github.com/Apical-7280/youtube-comments-crawler
// @version      1.1.0
// @description  抓取 YouTube 视频页的全部评论：全量模式自动滚动并逐条展开回复，主评论模式只抓一级评论；支持断点续抓，导出 JSON / CSV
// @author       Apical-7280
// @license      MIT
// @homepageURL  https://github.com/Apical-7280/youtube-comments-crawler
// @supportURL   https://github.com/Apical-7280/youtube-comments-crawler/issues
// @updateURL    https://cdn.jsdelivr.net/gh/Apical-7280/youtube-comments-crawler@main/youtube-comments-crawler.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/Apical-7280/youtube-comments-crawler@main/youtube-comments-crawler.user.js
// @match        https://*.youtube.com/watch*
// @match        https://*.youtube.com/shorts/*
// @match        https://youtu.be/*
// @noframes
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * YouTube 评论抓取器
 *
 * 工作方式：
 *   1. 缓慢向下滚动评论区，逐条点开「N 条回复」按钮，直到全部回复展开且页面不再增高；
 *   2. 每轮只点击一个回复按钮并等待其展开，滚动步长为半个视口，接近人工浏览节奏；
 *   3. 抓取进度写入 localStorage，可按视频维度断点续抓；
 *   4. 抓取完成后自动下载 JSON，也可随时导出 JSON / CSV。
 *
 * 全部数据仅在浏览器本地处理，脚本不发起任何外部网络请求。
 *
 * 更新地址使用 jsDelivr 镜像（部分网络无法直连 raw.githubusercontent.com）：
 *   https://cdn.jsdelivr.net/gh/Apical-7280/youtube-comments-crawler@main/youtube-comments-crawler.user.js
 */
(function () {
  'use strict';

  const SCRIPT_VERSION = '1.1.0';
  const STORAGE_KEY = 'yt_comments_store_v1';
  const KEY_SCHEME_COMMENT = 'comment'; // 新键方案：作者 + 时间 + 正文
  const KEY_SCHEME_TEXT = 'text';       // v1 旧键方案：仅正文（载入旧数据时自动标记）
  const TICK_INTERVAL_MS = 1500;        // 每轮滚动与采集的间隔
  const MAX_IDLE_TICKS = 10;            // 连续无新增且无待展开回复的轮数，达到即判定抓取完成
  const MAX_TICKS = 40000;              // 循环轮数上限
  const CLICK_COOLDOWN_MS = 6000;       // 同一按钮两次点击的最小间隔，避免重复展开
  const EXPAND_WAIT_TICKS = 2;          // 点击回复按钮后等待展开的轮数
  const SCROLL_RATIO = 0.5;             // 每轮滚动距离占视口高度的比例
  const COMMENT_TEXT_SELECTOR = 'span.ytAttributedStringHost.ytAttributedStringWhiteSpacePreWrap[dir="auto"][role="text"]';
  const COLLAPSED_TEXT_SELECTORS = ['ytd-comment-renderer #expand-content', '#expand-content'];
  const PERSIST_INTERVAL_MS = 15000;    // 增量落盘的最小间隔（避免每轮都序列化整个存储）
  const PERSIST_ITEM_THRESHOLD = 50;    // 新增条数达到该值即立刻落盘
  const STORAGE_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;  // 本地存储软上限，超过后提示导出

  // 在 Node 中加载本文件（单元测试）时为 true，浏览器中恒为 false
  const IS_NODE = typeof process === 'object' && process !== null
    && typeof process.versions === 'object' && process.versions !== null
    && typeof process.versions.node === 'string';

  let scrapeTimer = null;
  let activeRun = null;    // { store, video }：抓取期间内存中的权威状态
  let storageNotice = '';  // '' 正常 / 'near' 接近配额 / 'failed' 写入失败

  /* ------------------------------ 通用工具 ------------------------------ */

  const clean = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // 评论正文保留换行，仅压缩行内空白
  const cleanBody = (text) => (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\r?\n[ \t]*/g, '\n')
    .trim();

  // v1 的数据以评论正文作为键；载入时标记为旧键方案并继续沿用旧键，避免新旧键并存产生重复记录
  const migrateStore = (store) => {
    const videos = (store && store.videos) || {};
    Object.keys(videos).forEach((videoId) => {
      const video = videos[videoId];
      if (video && !video.keyScheme) video.keyScheme = KEY_SCHEME_TEXT;
    });
    return store;
  };

  const readStore = () => {
    try {
      return migrateStore(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || { videos: {} });
    } catch (error) {
      return { videos: {} };
    }
  };

  const writeStore = (store) => {
    try {
      const serialized = JSON.stringify(store);
      localStorage.setItem(STORAGE_KEY, serialized);
      storageNotice = serialized.length > STORAGE_SOFT_LIMIT_BYTES ? 'near' : '';
      return true;
    } catch (error) {
      storageNotice = 'failed';
      console.warn('[YouTube 评论抓取器] localStorage 写入失败，进度仅保留在内存中，建议立即导出 JSON', error);
      return false;
    }
  };

  const getVideoId = (url) => {
    const href = url || (typeof location !== 'undefined' ? location.href : '');
    if (!href) return '';

    let parsed;
    try {
      parsed = new URL(href);
    } catch (error) {
      return '';
    }

    const watchMatch = parsed.search.match(/[?&]v=([\w-]{5,})/);
    if (watchMatch) return watchMatch[1];

    const shortMatch = parsed.pathname.match(/\/shorts\/([\w-]{5,})/);
    if (shortMatch) return shortMatch[1];

    // youtu.be/ID：视频 id 位于路径根部（旧实现未覆盖，声明了 @match 却无法抓取）
    if (/(^|\.)youtu\.be$/.test(parsed.hostname)) {
      const idMatch = parsed.pathname.match(/^\/([\w-]{5,})/);
      if (idMatch) return idMatch[1];
    }

    return '';
  };

  const getPageTitle = () => clean(document.title.replace(/ - YouTube\s*$/, ''));

  /* --------------------------- 回复展开按钮识别 ---------------------------
     按钮文案可能是：36 条回复 / 36条回复 / 1,000 条回复 / 显示更多回复 / 更多回复 /
     36 replies / View more replies / Show more replies / More replies。
     必须排除「回复」（会弹出输入框）与「隐藏回复」（会收起已展开的回复）。
  ----------------------------------------------------------------------- */

  const isExpandRepliesLabel = (label) => {
    const text = clean(label);
    if (!text) return false;
    if (/^\d[\d,，、]*\s*条?\s*回复$/.test(text)) return true;
    if (/^(查看|显示)?\s*(\d[\d,]*|更多)\s*条?\s*回复$/.test(text)) return true;
    if (/^\d[\d,]*\s*repl(?:y|ies)$/i.test(text)) return true;
    if (/^(view|show)?\s*more\s+replies$/i.test(text)) return true;
    return false;
  };

  // 按钮文案优先取 textContent，为空时才回退到 aria-label。
  // 两者不可拼接后再判断，否则会得到「36 条回复36 条回复」这类文本，正则永远无法匹配。
  const getButtonLabel = (button) => {
    const text = clean(button.textContent || '');
    if (text) return text;
    return clean(button.getAttribute('aria-label') || '');
  };

  // 仅处理真实可见且部分位于视口内的按钮。
  // YouTube 展开回复后只是隐藏按钮而非移除节点，对隐藏按钮点击无效，也可能误采数据。
  const isButtonActionable = (button) => {
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportHeight = window.innerHeight || 800;
    return rect.top < viewportHeight && rect.bottom > 0;
  };

  const collectExpandButtons = (root = document) => {
    const result = [];
    const buttons = root.querySelectorAll('button');

    buttons.forEach((button) => {
      if (isExpandRepliesLabel(getButtonLabel(button)) && isButtonActionable(button)) {
        result.push(button);
      }
    });

    return result;
  };

  // 点击视口内第一个可点击的回复按钮，返回其文案；没有可点击按钮时返回空字符串。
  // 使用原生 click()：实测对「N 条回复」按钮（含外层 #more-replies 与子线程 #more-replies-sub-thread）有效，
  // 改为 pointer / mouse 事件序列反而会触发「展开又收起」。
  const clickOneReplyButton = () => {
    const now = Date.now();
    const buttons = collectExpandButtons();

    for (let i = 0; i < buttons.length; i += 1) {
      const button = buttons[i];
      const mark = button.dataset.ytcMark;
      if (mark === 'dead') continue;
      if (mark && now - Number(mark) < CLICK_COOLDOWN_MS) continue;

      button.dataset.ytcMark = String(now);
      const label = getButtonLabel(button);
      try {
        button.click();
      } catch (error) {
        // 忽略已被页面移除的节点
      }
      return label;
    }

    return '';
  };

  // 仍待展开的按钮数量（未点击过，或已过冷却可再次点击）
  const countPendingReplies = () => {
    const now = Date.now();
    let count = 0;

    collectExpandButtons().forEach((button) => {
      const mark = button.dataset.ytcMark;
      if (mark === 'dead') return;
      if (!mark || now - Number(mark) >= CLICK_COOLDOWN_MS) count += 1;
    });

    return count;
  };

  // 刚点击过、仍在冷却中的按钮数量，此时不继续下滑
  const countCoolingReplies = () => {
    const now = Date.now();
    let count = 0;

    collectExpandButtons().forEach((button) => {
      const mark = button.dataset.ytcMark;
      if (mark && mark !== 'dead' && now - Number(mark) < CLICK_COOLDOWN_MS) count += 1;
    });

    return count;
  };

  // 点击后超过两倍冷却时间仍未展开的按钮判为无效，不再重复点击，避免陷入死循环
  const sweepStaleButtons = () => {
    const now = Date.now();

    collectExpandButtons().forEach((button) => {
      const mark = button.dataset.ytcMark;
      if (!mark || mark === 'dead') return;
      if (now - Number(mark) > CLICK_COOLDOWN_MS * 2) button.dataset.ytcMark = 'dead';
    });
  };

  // 展开被折叠的长评论（全量模式下的补充处理，不影响正文完整性）
  const expandCollapsedComments = (limit, root = document) => {
    const now = Date.now();
    let count = 0;

    for (let i = 0; i < COLLAPSED_TEXT_SELECTORS.length && count < limit; i += 1) {
      const nodes = root.querySelectorAll(COLLAPSED_TEXT_SELECTORS[i]);
      for (let j = 0; j < nodes.length && count < limit; j += 1) {
        const node = nodes[j];
        if (node.dataset) {
          // 使用独立标记，避免与回复按钮的 ytcMark 命名空间混用
          const mark = node.dataset.ytcExpandMark;
          if (mark && now - Number(mark) < CLICK_COOLDOWN_MS) continue;
          node.dataset.ytcExpandMark = String(now);
        }
        try {
          node.click();
        } catch (error) {
          // 忽略已被页面移除的节点
        }
        count += 1;
      }
    }

    return count;
  };

  /* ------------------------------ 评论提取 ------------------------------
     评论与回复正文位于 ytd-comment-thread-renderer 内、yt-attributed-string 中的
     span.ytAttributedStringHost.ytAttributedStringWhiteSpacePreWrap。
     「回复 / N 条回复 / 隐藏回复」等按钮文案也使用同类 span（祖先在 yt-button-shape 内），必须排除。
     mainOnly 为 true 时，每个线程只取第一条正文，即主评论。
  ----------------------------------------------------------------------- */

  // 作者、发布时间、点赞数位于评论渲染器内部；取不到时留空，不影响正文抓取
  const readCommentMeta = (span) => {
    const renderer = (span.closest
      && (span.closest('ytd-comment-renderer') || span.closest('ytd-comment-thread-renderer'))) || null;

    const pick = (selector) => {
      if (!renderer || !renderer.querySelector) return '';
      const node = renderer.querySelector(selector);
      return clean(node ? node.textContent : '');
    };

    return {
      author: pick('#author-text'),
      publishedAt: pick('#published-time-text') || pick('.published-time-text'),
      likes: pick('#vote-count-middle'),
      isReply: !!(span.closest && span.closest('ytd-comment-replies-renderer')),
    };
  };

  // 评论唯一键：作者 + 时间 + 正文。
  // 仅以正文为键会把不同用户的相同内容（纯 emoji、「谢谢分享」等）静默合并成一条。
  // 取不到作者与时间时退回正文，与旧行为一致。
  const buildCommentKey = (comment) => {
    const text = comment.text || '';
    if (!comment.author && !comment.publishedAt) return text;
    return [comment.author, comment.publishedAt, text].join('\u0000');
  };

  const collectComments = (mainOnly, root = document) => {
    const result = [];

    const isBodySpan = (span) => !span.closest('yt-button-shape, yt-spec-button-shape, ytd-button-renderer, button');

    const pushSpan = (span) => {
      const text = cleanBody(span.textContent);
      if (!text) return;
      const meta = readCommentMeta(span);
      result.push({
        text,
        author: meta.author,
        publishedAt: meta.publishedAt,
        likes: meta.likes,
        isReply: meta.isReply,
      });
    };

    const threads = root.querySelectorAll('ytd-comment-thread-renderer');
    if (threads.length > 0) {
      threads.forEach((thread) => {
        const spans = thread.querySelectorAll(COMMENT_TEXT_SELECTOR);
        let first = true;

        spans.forEach((span) => {
          if (!isBodySpan(span)) return;
          if (mainOnly && !first) return;
          pushSpan(span);
          first = false;
        });
      });
      return result;
    }

    // 兜底：只采集评论区容器内的同类节点，排除评论区头部，避免误抓推荐列表等区域的文本。
    // 主评论模式下排除回复容器内的节点（旧实现漏掉了这一步，会把回复一并抓走）。
    const spans = root.querySelectorAll('ytd-comments ' + COMMENT_TEXT_SELECTOR);
    spans.forEach((span) => {
      if (span.closest('ytd-comments-header-renderer, ytd-comments #header')) return;
      if (!isBodySpan(span)) return;
      if (mainOnly && span.closest('ytd-comment-replies-renderer')) return;
      pushSpan(span);
    });

    return result;
  };

  /* ------------------------------ 本地进度 ------------------------------ */

  const ensureVideo = (store, videoId) => {
    let video = store.videos[videoId];
    if (!video) {
      video = {
        videoId,
        videoUrl: location.href.split('?')[0],
        title: getPageTitle(),
        state: 'idle',
        mode: 'all',
        keyScheme: KEY_SCHEME_COMMENT,
        items: {},
        order: [],
        updatedAt: Date.now(),
      };
      store.videos[videoId] = video;
    }
    return video;
  };

  // 抓取期间优先读取内存中的权威状态，避免落盘节流导致导出落后于实际进度
  const findVideo = (videoId) => {
    if (activeRun && activeRun.store.videos[videoId]) return activeRun.store.videos[videoId];
    return (readStore().videos || {})[videoId] || null;
  };

  // 导出字段：text 仍为首字段，其余为新增字段；v1 旧数据缺少这些字段时留空
  const toExportItem = (item) => ({
    text: item.text || '',
    author: item.author || '',
    publishedAt: item.publishedAt || '',
    likes: item.likes || '',
    isReply: !!item.isReply,
  });

  const buildPayload = (video) => {
    const items = (video.order || []).map((key) => toExportItem(video.items[key] || {}));
    return {
      crawledAt: new Date().toISOString(),
      videoId: video.videoId,
      videoUrl: video.videoUrl,
      videoTitle: video.title,
      total: items.length,
      items,
    };
  };

  const CSV_HEADER = ['text', 'author', 'publishedAt', 'likes', 'isReply'];

  const buildCsv = (items) => {
    const escapeCell = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    const rows = [CSV_HEADER.join(',')];
    items.forEach((item) => {
      const record = toExportItem(item);
      rows.push(CSV_HEADER.map((field) => escapeCell(record[field])).join(','));
    });
    return rows.join('\r\n');
  };

  /* ------------------------------ 文件导出 ------------------------------ */

  const downloadBlob = (blob, fileName) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 3000);
  };

  const saveJson = (data, fileName) => {
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), fileName);
  };

  const saveCsv = (items, fileName) => {
    downloadBlob(new Blob(['\ufeff' + buildCsv(items)], { type: 'text/csv;charset=utf-8' }), fileName);
  };

  /* ------------------------------ 抓取主循环 ------------------------------ */

  // store 与 current 由调用方传入内存中的权威状态，避免重新读盘丢掉尚未落盘的数据
  const stopScrape = (setStatus, store, current, state, message) => {
    clearInterval(scrapeTimer);
    scrapeTimer = null;

    if (current) {
      current.state = state;
      current.updatedAt = Date.now();
    }
    if (store) writeStore(store);

    activeRun = null;

    const count = current ? current.order.length : 0;
    setStatus(message + (count && state === 'done' ? `，已自动下载 JSON（${count} 条）` : ''));
    if (count && state === 'done') saveJson(buildPayload(current), `youtube_comments_${current.videoId}.json`);
  };

  const startScrape = (setStatus, reset, mainOnly) => {
    clearInterval(scrapeTimer);
    scrapeTimer = null;

    // 切换任务前先把上一个任务尚未落盘的内存状态写回
    if (activeRun && activeRun.video) {
      activeRun.video.updatedAt = Date.now();
      writeStore(activeRun.store);
      activeRun = null;
    }

    const videoId = getVideoId();
    if (!videoId) {
      setStatus('当前页面未识别到视频 id，无法抓取');
      return;
    }

    const expandReplies = !mainOnly;
    const store = readStore();
    const video = ensureVideo(store, videoId);

    if (reset) {
      video.items = {};
      video.order = [];
      video.keyScheme = KEY_SCHEME_COMMENT;
    }
    video.state = 'running';
    video.mode = expandReplies ? 'all' : 'main';
    video.videoUrl = location.href.split('?')[0];
    if (getPageTitle()) video.title = getPageTitle();
    video.updatedAt = Date.now();
    writeStore(store);

    // 内存中的权威状态：每轮不再读盘，避免落盘节流期间读到旧数据而丢进度
    activeRun = { store, video };

    let tick = 0;
    let idle = 0;
    let lastHeight = 0;
    let emptyRounds = 0;
    let waitForExpand = 0;
    let lastPersistAt = Date.now();
    let lastPersistCount = video.order.length;

    setStatus(expandReplies ? '开始抓取全部评论' : '开始抓取主评论');

    // 落盘节流：新增达到阈值或距上次落盘超过间隔时才序列化整个存储
    const persistIfNeeded = () => {
      const pendingItems = video.order.length - lastPersistCount;
      if (pendingItems <= 0) return;
      if (pendingItems < PERSIST_ITEM_THRESHOLD && Date.now() - lastPersistAt < PERSIST_INTERVAL_MS) return;

      video.updatedAt = Date.now();
      const saved = writeStore(store);
      lastPersistAt = Date.now();
      if (saved) lastPersistCount = video.order.length;
    };

    scrapeTimer = setInterval(() => {
      tick += 1;

      const current = video;
      const before = current.order.length;

      // 每轮最多点击一个回复按钮：点击后先等待展开，再处理下一个。
      // 批量点击多个按钮会呈现异常的操作节奏，页面也来不及响应。
      let clickedLabel = '';
      if (expandReplies) {
        clickedLabel = clickOneReplyButton();
        if (clickedLabel) {
          current.expandCount = (current.expandCount || 0) + 1;
          waitForExpand = EXPAND_WAIT_TICKS;
        }
        sweepStaleButtons();
        expandCollapsedComments(2);
      }

      collectComments(mainOnly).forEach((comment) => {
        const key = current.keyScheme === KEY_SCHEME_TEXT ? comment.text : buildCommentKey(comment);
        if (!current.items[key]) {
          current.items[key] = comment;
          current.order.push(key);
        }
      });

      const after = current.order.length;
      const height = document.documentElement.scrollHeight;
      idle = (after === before && height === lastHeight) ? idle + 1 : 0;
      lastHeight = height;
      emptyRounds = after === 0 ? emptyRounds + 1 : 0;
      persistIfNeeded();

      const pending = expandReplies ? countPendingReplies() : 0;
      const cooling = expandReplies ? countCoolingReplies() : 0;

      if (clickedLabel) {
        setStatus(`已点击「${clickedLabel}」（累计 ${current.expandCount || 0} 个），等待展开`);
      } else if (after > before) {
        setStatus(`已抓取 ${after} 条（本轮新增 ${after - before} 条）`);
      } else if (expandReplies && pending > 0) {
        setStatus(`已抓取 ${after} 条，展开回复中（剩余 ${pending} 个）`);
      } else {
        setStatus(`已抓取 ${after} 条，等待加载`);
      }

      if (after === 0 && emptyRounds === 3) setStatus('正在滚动到评论区');
      if (after === 0 && emptyRounds >= 12) {
        stopScrape(setStatus, store, current, 'error', '始终没有发现评论：评论可能已关闭、页面未加载评论区，或需要登录后再试');
        return;
      }
      if (tick >= MAX_TICKS) {
        stopScrape(setStatus, store, current, 'stopped', '已达循环轮数上限，已暂停，可点击「开始全量抓取」继续');
        return;
      }

      // 无新增、页面不再增高，且（全量模式下）所有回复按钮均已点开，才判定抓取完成
      if (idle >= MAX_IDLE_TICKS) {
        if (expandReplies && pending > 0) {
          idle = 0;
        } else {
          stopScrape(setStatus, store, current, 'done', expandReplies
            ? `抓取完成，回复已全部展开并到达底部（共 ${after} 条）`
            : `抓取完成，主评论已抓完（共 ${after} 条）`);
          return;
        }
      }

      // 滚动策略：点击后先等待展开；视口内仍有待点击或冷却中的按钮时原地等待；
      // 当前屏处理完毕后，向下滚动半个视口。
      if (waitForExpand > 0) {
        waitForExpand -= 1;
      } else if (expandReplies && pending + cooling > 0) {
        // 保持原地，等待展开完成
      } else {
        const viewportHeight = window.innerHeight || 800;
        window.scrollTo(0, Math.min(
          Math.max(0, document.documentElement.scrollHeight - viewportHeight),
          window.scrollY + viewportHeight * SCROLL_RATIO
        ));
      }
    }, TICK_INTERVAL_MS);
  };

  const haltScrape = (setStatus) => {
    clearInterval(scrapeTimer);
    scrapeTimer = null;

    const videoId = getVideoId();
    let video = null;

    if (activeRun && activeRun.store.videos[videoId]) {
      // 停止时使用内存中的权威状态，保证最后几轮尚未落盘的评论也被保存
      video = activeRun.store.videos[videoId];
      video.state = 'stopped';
      video.updatedAt = Date.now();
      writeStore(activeRun.store);
      activeRun = null;
    } else {
      const store = readStore();
      video = store.videos[videoId] || null;
      if (video) {
        video.state = 'stopped';
        video.updatedAt = Date.now();
        writeStore(store);
      }
    }

    setStatus(`已停止，已抓取 ${video ? video.order.length : 0} 条，进度已保留，可点击「开始全量抓取」继续`);
  };

  /* ------------------------------ 控制面板 ------------------------------ */

  const mount = () => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (document.body) {
        clearInterval(timer);
        setTimeout(buildPanel, 100);
      } else if (tries > 400) {
        clearInterval(timer);
        console.warn('[YouTube 评论抓取器] 页面 body 在 20 秒内未出现，脚本终止挂载');
      }
    }, 50);
  };

  function buildPanel() {
    // YouTube 启用了 Trusted Types，禁止 innerHTML 赋值，界面必须通过 DOM API 构建
    const appendDiv = (parent, text, css) => {
      const div = document.createElement('div');
      div.textContent = text;
      div.style.cssText = css;
      parent.appendChild(div);
      return div;
    };

    const appendButton = (parent, text, color, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.style.cssText = 'display:block;width:100%;margin:4px 0;padding:7px;'
        + `background:${color};color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;`;
      button.addEventListener('click', onClick);
      parent.appendChild(button);
      return button;
    };

    const panel = document.createElement('section');
    panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:99999;background:#fff;'
      + 'border:1px solid #d8d8d8;border-radius:8px;padding:12px 14px;font:13px/1.6 system-ui;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.15);max-width:380px;color:#333;';

    appendDiv(panel, `YouTube 评论抓取器 v${SCRIPT_VERSION}`, 'font-weight:600;margin-bottom:8px;');
    const videoLine = appendDiv(panel, '', 'font-size:12px;color:#888;margin-bottom:6px;');
    const statusLine = appendDiv(panel, '就绪', 'margin-bottom:6px;color:#666;');
    const hintLine = appendDiv(panel, '', 'color:#999;font-size:12px;margin-top:6px;');

    const setStatus = (text) => {
      statusLine.textContent = text;
    };

    appendButton(panel, '开始全量抓取', '#576b95', () => startScrape(setStatus, false, false));
    appendButton(panel, '开始抓取主评论', '#07c160', () => {
      setStatus('仅抓取主评论，已清空本视频的历史数据');
      startScrape(setStatus, true, true);
    });
    appendButton(panel, '清空并重新全量抓取', '#fba53b', () => startScrape(setStatus, true, false));
    appendButton(panel, '停止', '#fa5151', () => haltScrape(setStatus));
    appendButton(panel, '导出 JSON', '#10aeff', () => {
      const videoId = getVideoId();
      const video = findVideo(videoId);
      if (!video || video.order.length === 0) {
        setStatus('本视频尚未抓到任何评论');
        return;
      }
      saveJson(buildPayload(video), `youtube_comments_${videoId}.json`);
      setStatus(`已导出 JSON（${video.order.length} 条）`);
    });
    appendButton(panel, '导出 CSV', '#fba53b', () => {
      const videoId = getVideoId();
      const video = findVideo(videoId);
      if (!video || video.order.length === 0) {
        setStatus('本视频尚未抓到任何评论');
        return;
      }
      const items = video.order.map((key) => video.items[key]);
      saveCsv(items, `youtube_comments_${videoId}.csv`);
      setStatus(`已导出 CSV（${items.length} 条）`);
    });

    document.body.appendChild(panel);

    // 断点续抓：页面加载或 SPA 切换到其它视频时，若该视频上次仍在运行则按原模式自动继续
    let lastVideoId = getVideoId();

    const resumeIfNeeded = () => {
      const video = findVideo(getVideoId());
      if (video && video.state === 'running') {
        setStatus(`检测到未完成的抓取任务（已抓 ${video.order.length} 条），正在自动继续`);
        startScrape(setStatus, false, video.mode === 'main');
      }
    };

    resumeIfNeeded();

    setInterval(() => {
      const videoId = getVideoId();
      if (videoId && videoId !== lastVideoId) {
        lastVideoId = videoId;
        const video = findVideo(videoId);
        setStatus(video && video.state === 'running'
          ? '已切换到本视频，正在自动继续'
          : '已切换到新视频，点击「开始全量抓取」或「开始抓取主评论」开始');
        resumeIfNeeded();
      }
    }, 1000);

    setInterval(() => {
      const threadCount = document.querySelectorAll('ytd-comment-thread-renderer').length;
      const video = findVideo(getVideoId());
      const stored = video ? video.order.length : 0;
      const mode = video ? (video.mode === 'main' ? '（主评论）' : '（全量）') : '';
      const base = `当前页已渲染评论线程 ${threadCount} 个，本视频已存 ${stored} 条${mode}`;

      videoLine.textContent = `视频 id：${getVideoId() || '未识别，无法抓取'}`;

      if (storageNotice === 'failed') {
        hintLine.textContent = `${base}｜本地存储写入失败，进度仅存于内存，请立即导出 JSON`;
        hintLine.style.color = '#fa5151';
      } else if (storageNotice === 'near') {
        hintLine.textContent = `${base}｜本地存储接近上限，建议导出后清理`;
        hintLine.style.color = '#fba53b';
      } else {
        hintLine.textContent = base;
        hintLine.style.color = '#999';
      }
    }, 1500);
  }

  // 单元测试入口：在 Node 中 require 本文件时可访问内部函数；浏览器中始终走 mount()
  if (IS_NODE && typeof module === 'object' && module !== null && module.exports) {
    module.exports = {
      SCRIPT_VERSION,
      STORAGE_KEY,
      STORAGE_SOFT_LIMIT_BYTES,
      KEY_SCHEME_COMMENT,
      KEY_SCHEME_TEXT,
      clean,
      cleanBody,
      isExpandRepliesLabel,
      getButtonLabel,
      getVideoId,
      collectExpandButtons,
      expandCollapsedComments,
      readCommentMeta,
      buildCommentKey,
      collectComments,
      migrateStore,
      readStore,
      writeStore,
      ensureVideo,
      toExportItem,
      buildPayload,
      buildCsv,
      getStorageNotice: () => storageNotice,
    };
  } else {
    mount();
  }
})();
