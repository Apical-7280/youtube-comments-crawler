// ==UserScript==
// @name         YouTube 评论抓取器
// @namespace    https://github.com/Apical-7280/youtube-comments-crawler
// @version      1.0.0
// @description  抓取 YouTube 视频页的全部评论：全量模式自动滚动并逐条展开回复，主评论模式只抓一级评论；支持断点续抓，导出 JSON / CSV
// @author       Apical-7280
// @license      MIT
// @homepageURL  https://github.com/Apical-7280/youtube-comments-crawler
// @supportURL   https://github.com/Apical-7280/youtube-comments-crawler/issues
// @updateURL    https://raw.githubusercontent.com/Apical-7280/youtube-comments-crawler/main/youtube-comments-crawler.user.js
// @downloadURL  https://raw.githubusercontent.com/Apical-7280/youtube-comments-crawler/main/youtube-comments-crawler.user.js
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
 */
(function () {
  'use strict';

  const SCRIPT_VERSION = '1.0.0';
  const STORAGE_KEY = 'yt_comments_store_v1';
  const TICK_INTERVAL_MS = 1500;        // 每轮滚动与采集的间隔
  const MAX_IDLE_TICKS = 10;            // 连续无新增且无待展开回复的轮数，达到即判定抓取完成
  const MAX_TICKS = 40000;              // 循环轮数上限
  const CLICK_COOLDOWN_MS = 6000;       // 同一按钮两次点击的最小间隔，避免重复展开
  const EXPAND_WAIT_TICKS = 2;          // 点击回复按钮后等待展开的轮数
  const SCROLL_RATIO = 0.5;             // 每轮滚动距离占视口高度的比例
  const COMMENT_TEXT_SELECTOR = 'span.ytAttributedStringHost.ytAttributedStringWhiteSpacePreWrap[dir="auto"][role="text"]';
  const COLLAPSED_TEXT_SELECTORS = ['ytd-comment-renderer #expand-content', '#expand-content'];

  let scrapeTimer = null;

  /* ------------------------------ 通用工具 ------------------------------ */

  const clean = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // 评论正文保留换行，仅压缩行内空白
  const cleanBody = (text) => (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\r?\n[ \t]*/g, '\n')
    .trim();

  const readStore = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || { videos: {} };
    } catch (error) {
      return { videos: {} };
    }
  };

  const writeStore = (store) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      console.warn('[YouTube 评论抓取器] localStorage 写入失败，进度仅保留在内存中', error);
    }
  };

  const getVideoId = () => {
    const watchMatch = location.search.match(/[?&]v=([\w-]{5,})/);
    if (watchMatch) return watchMatch[1];
    const shortMatch = location.pathname.match(/\/shorts\/([\w-]{5,})/);
    return shortMatch ? shortMatch[1] : '';
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
    if (/^\d[\d,]*\s*replies?$/i.test(text)) return true;
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

  const collectExpandButtons = () => {
    const result = [];
    const buttons = document.querySelectorAll('button');

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
  const expandCollapsedComments = (limit) => {
    const now = Date.now();
    let count = 0;

    for (let i = 0; i < COLLAPSED_TEXT_SELECTORS.length && count < limit; i += 1) {
      const nodes = document.querySelectorAll(COLLAPSED_TEXT_SELECTORS[i]);
      for (let j = 0; j < nodes.length && count < limit; j += 1) {
        const node = nodes[j];
        if (node.dataset) {
          const mark = node.dataset.ytcMark;
          if (mark && now - Number(mark) < CLICK_COOLDOWN_MS) continue;
          node.dataset.ytcMark = String(now);
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

  const collectComments = (mainOnly) => {
    const result = [];

    const isBodySpan = (span) => !span.closest('yt-button-shape, yt-spec-button-shape, ytd-button-renderer, button');

    const pushSpan = (span) => {
      const text = cleanBody(span.textContent);
      if (text) result.push({ text });
    };

    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
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

    // 兜底：只采集评论区容器内的同类节点，排除评论区头部，避免误抓推荐列表等区域的文本
    const spans = document.querySelectorAll('ytd-comments ' + COMMENT_TEXT_SELECTOR);
    spans.forEach((span) => {
      if (span.closest('ytd-comments-header-renderer, ytd-comments #header')) return;
      if (!isBodySpan(span)) return;
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
        items: {},
        order: [],
        updatedAt: Date.now(),
      };
      store.videos[videoId] = video;
    }
    return video;
  };

  const findVideo = (videoId) => (readStore().videos || {})[videoId] || null;

  // 仅导出评论正文
  const buildPayload = (video) => {
    const items = (video.order || []).map((key) => ({ text: video.items[key].text }));
    return {
      crawledAt: new Date().toISOString(),
      videoId: video.videoId,
      videoUrl: video.videoUrl,
      videoTitle: video.title,
      total: items.length,
      items,
    };
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
    const escapeCell = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    const rows = ['text'];
    items.forEach((item) => rows.push(escapeCell(item.text)));
    downloadBlob(new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), fileName);
  };

  /* ------------------------------ 抓取主循环 ------------------------------ */

  const stopScrape = (setStatus, video, state, message) => {
    clearInterval(scrapeTimer);
    scrapeTimer = null;

    const store = readStore();
    const current = (video && store.videos[video.videoId]) || ensureVideo(store, getVideoId());
    current.state = state;
    current.updatedAt = Date.now();
    writeStore(store);

    const count = current.order.length;
    setStatus(message + (count && state === 'done' ? `，已自动下载 JSON（${count} 条）` : ''));
    if (count && state === 'done') saveJson(buildPayload(current), `youtube_comments_${current.videoId}.json`);
  };

  const startScrape = (setStatus, reset, mainOnly) => {
    clearInterval(scrapeTimer);
    scrapeTimer = null;

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
    }
    video.state = 'running';
    video.mode = expandReplies ? 'all' : 'main';
    video.videoUrl = location.href.split('?')[0];
    if (getPageTitle()) video.title = getPageTitle();
    video.updatedAt = Date.now();
    writeStore(store);

    let tick = 0;
    let idle = 0;
    let lastHeight = 0;
    let emptyRounds = 0;
    let waitForExpand = 0;

    setStatus(expandReplies ? '开始抓取全部评论' : '开始抓取主评论');

    scrapeTimer = setInterval(() => {
      tick += 1;

      const latest = readStore();
      const current = ensureVideo(latest, videoId);
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
        const key = comment.text;
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
      current.updatedAt = Date.now();
      writeStore(latest);

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
        stopScrape(setStatus, current, 'error', '始终没有发现评论：评论可能已关闭、页面未加载评论区，或需要登录后再试');
        return;
      }
      if (tick >= MAX_TICKS) {
        stopScrape(setStatus, current, 'stopped', '已达循环轮数上限，已暂停，可点击「开始全量抓取」继续');
        return;
      }

      // 无新增、页面不再增高，且（全量模式下）所有回复按钮均已点开，才判定抓取完成
      if (idle >= MAX_IDLE_TICKS) {
        if (expandReplies && pending > 0) {
          idle = 0;
        } else {
          stopScrape(setStatus, current, 'done', expandReplies
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
    const store = readStore();
    const video = store.videos[videoId];

    if (video) {
      video.state = 'stopped';
      video.updatedAt = Date.now();
      writeStore(store);
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
      videoLine.textContent = `视频 id：${getVideoId() || '未识别，无法抓取'}`;
      hintLine.textContent = `当前页已渲染评论线程 ${threadCount} 个，本视频已存 ${stored} 条${mode}`;
    }, 1500);
  }

  mount();
})();
