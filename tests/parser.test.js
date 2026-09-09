'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const fixturePath = (fileName) => path.join(__dirname, 'fixtures', fileName);
const readFixture = (fileName) => fs.readFileSync(fixturePath(fileName), 'utf8');

const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

const dom = new JSDOM(readFixture('comment-threads.html'), { url: WATCH_URL });
setGlobal('window', dom.window);
setGlobal('document', dom.window.document);
setGlobal('location', dom.window.location);
setGlobal('localStorage', dom.window.localStorage);

const script = require('../youtube-comments-crawler.user.js');

// 切换到另一份 fixture，执行完恢复原 document
const withFixture = (fileName, run) => {
  const next = new JSDOM(readFixture(fileName), { url: WATCH_URL });
  const previous = globalThis.document;
  setGlobal('document', next.window.document);
  try {
    return run(next.window.document);
  } finally {
    setGlobal('document', previous);
  }
};

describe('collectComments：线程结构', () => {
  const all = script.collectComments(false);

  test('抓取主评论与回复，共三条', () => {
    assert.equal(all.length, 3);
  });

  test('提取作者、发布时间、点赞数与回复标记', () => {
    assert.deepEqual(all.map((item) => item.author), ['Alice', 'Bob', 'Carol']);
    assert.deepEqual(all.map((item) => item.publishedAt), ['3 days ago', '2 days ago', '1 day ago']);
    assert.deepEqual(all.map((item) => item.likes), ['12', '3', '1.2K']);
    assert.deepEqual(all.map((item) => item.isReply), [false, true, false]);
  });

  test('按钮文案与评论区标题不会被当成正文', () => {
    assert.ok(all.every((item) => item.text === 'Great video'));
  });

  test('正文相同的三条评论生成三个不同的键（旧实现只按正文，会合并成一条）', () => {
    assert.equal(new Set(all.map((item) => script.buildCommentKey(item))).size, 3);
    assert.equal(new Set(all.map((item) => item.text)).size, 1);
  });

  test('主评论模式每个线程只取第一条', () => {
    const mainOnly = script.collectComments(true);
    assert.deepEqual(mainOnly.map((item) => item.author), ['Alice', 'Carol']);
  });
});

describe('collectComments：兜底分支（无线程容器）', () => {
  test('抓取评论区内的全部正文', () => {
    withFixture('comment-fallback.html', () => {
      const items = script.collectComments(false);
      assert.deepEqual(items.map((item) => item.text), ['Fallback main', 'Fallback reply']);
    });
  });

  test('主评论模式排除回复容器内的节点', () => {
    withFixture('comment-fallback.html', () => {
      const items = script.collectComments(true);
      assert.deepEqual(items.map((item) => item.text), ['Fallback main']);
    });
  });
});

describe('buildCommentKey', () => {
  test('作者或时间不同即为不同评论', () => {
    const base = { text: 'same text', author: 'A', publishedAt: '1 day ago' };
    assert.notEqual(script.buildCommentKey(base), script.buildCommentKey({ ...base, author: 'B' }));
    assert.notEqual(script.buildCommentKey(base), script.buildCommentKey({ ...base, publishedAt: '2 days ago' }));
  });

  test('缺作者与时间时退回正文（与 v1 行为一致）', () => {
    assert.equal(script.buildCommentKey({ text: 'only text' }), 'only text');
  });
});

describe('isExpandRepliesLabel', () => {
  const positives = [
    '36 条回复', '36条回复', '1,000 条回复', '显示更多回复', '更多回复',
    '36 replies', '1 reply', 'View more replies', 'Show more replies', 'More replies',
  ];
  const negatives = ['回复', '隐藏回复', 'Reply', '36 条评论', '', 'Subscribe'];

  test('识别可展开的回复按钮', () => {
    positives.forEach((label) => assert.equal(script.isExpandRepliesLabel(label), true, label));
  });

  test('排除「回复」「隐藏回复」等其它按钮', () => {
    negatives.forEach((label) => assert.equal(script.isExpandRepliesLabel(label), false, label));
  });
});

describe('getButtonLabel', () => {
  test('优先取 textContent，避免与 aria-label 拼接', () => {
    const button = dom.window.document.createElement('button');
    button.textContent = '36 replies';
    button.setAttribute('aria-label', 'Expand 36 replies');
    assert.equal(script.getButtonLabel(button), '36 replies');
  });

  test('textContent 为空时回退 aria-label', () => {
    const button = dom.window.document.createElement('button');
    button.setAttribute('aria-label', '36 条回复');
    assert.equal(script.getButtonLabel(button), '36 条回复');
  });
});

describe('collectExpandButtons：可见性过滤', () => {
  test('只返回可见且在视口内的按钮', () => {
    const doc = dom.window.document;
    const visible = doc.createElement('button');
    visible.textContent = '36 replies';
    visible.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, bottom: 30 });

    const hidden = doc.createElement('button');
    hidden.textContent = '12 replies';
    hidden.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0 });

    doc.body.appendChild(visible);
    doc.body.appendChild(hidden);

    try {
      const found = script.collectExpandButtons();
      assert.equal(found.length, 1);
      assert.equal(found[0], visible);
    } finally {
      visible.remove();
      hidden.remove();
    }
  });
});

describe('getVideoId', () => {
  test('watch / shorts / youtu.be 均可识别', () => {
    assert.equal(script.getVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(script.getVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
    assert.equal(script.getVideoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
    assert.equal(script.getVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(script.getVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  });

  test('非视频页与非法地址返回空串', () => {
    assert.equal(script.getVideoId('https://www.youtube.com/feed/subscriptions'), '');
    assert.equal(script.getVideoId('https://www.youtube.com/watch'), '');
    assert.equal(script.getVideoId('not a url'), '');
  });

  test('不传参数或传空值时回退到当前页面地址', () => {
    assert.equal(script.getVideoId(), 'dQw4w9WgXcQ');
    assert.equal(script.getVideoId(''), 'dQw4w9WgXcQ');
  });
});

describe('cleanBody', () => {
  test('保留换行并压缩行内空白', () => {
    assert.equal(script.cleanBody('  a\t b \n  c  '), 'a b\nc');
    assert.equal(script.cleanBody('x\u00a0y'), 'x y');
  });
});

describe('导出', () => {
  test('JSON 字段：text 仍为首字段，其余为新增字段', () => {
    const video = {
      videoId: 'abc12345',
      videoUrl: 'https://www.youtube.com/watch?v=abc12345',
      title: 'T',
      order: ['k1', 'k2'],
      items: {
        k1: { text: 'hi', author: 'A', publishedAt: '1 day ago', likes: '2', isReply: false },
        k2: { text: 'legacy' },
      },
    };

    const payload = script.buildPayload(video);
    assert.equal(payload.total, 2);
    assert.deepEqual(payload.items[0], {
      text: 'hi', author: 'A', publishedAt: '1 day ago', likes: '2', isReply: false,
    });
    assert.deepEqual(payload.items[1], {
      text: 'legacy', author: '', publishedAt: '', likes: '', isReply: false,
    });
  });

  test('CSV 首列为 text，含表头与引号转义', () => {
    const csv = script.buildCsv([{ text: 'say "hi"\nnext', author: 'A' }]);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'text,author,publishedAt,likes,isReply');
    assert.equal(lines[1], '"say ""hi""\nnext","A","","","false"');
  });
});

describe('本地进度与迁移', () => {
  test('v1 旧数据被标记为 text 键方案，避免与新版键并存重复', () => {
    const legacy = {
      videos: { old: { videoId: 'old', items: { 'some text': { text: 'some text' } }, order: ['some text'] } },
    };
    script.migrateStore(legacy);
    assert.equal(legacy.videos.old.keyScheme, script.KEY_SCHEME_TEXT);
  });

  test('已带键方案的视频不被改写', () => {
    const store = { videos: { v: { keyScheme: script.KEY_SCHEME_COMMENT } } };
    script.migrateStore(store);
    assert.equal(store.videos.v.keyScheme, script.KEY_SCHEME_COMMENT);
  });

  test('新建视频使用新键方案', () => {
    const store = { videos: {} };
    const video = script.ensureVideo(store, 'vid12345');
    assert.equal(video.keyScheme, script.KEY_SCHEME_COMMENT);
    assert.deepEqual(video.order, []);
  });

  test('写入后可读回，超过软上限时给出接近配额提示', () => {
    assert.equal(script.writeStore({ videos: {} }), true);
    assert.deepEqual(script.readStore(), { videos: {} });
    assert.equal(script.getStorageNotice(), '');

    script.writeStore({
      videos: { big: { items: { k: { text: 'x'.repeat(script.STORAGE_SOFT_LIMIT_BYTES + 1024) } } } },
    });
    assert.equal(script.getStorageNotice(), 'near');

    script.writeStore({ videos: {} });
    assert.equal(script.getStorageNotice(), '');
  });

  test('写入失败时返回 false 并给出失败提示', () => {
    const proto = dom.window.Storage.prototype;
    const originalSetItem = proto.setItem;
    const originalWarn = console.warn;
    console.warn = () => {};
    proto.setItem = () => { throw new Error('QuotaExceededError'); };

    try {
      assert.equal(script.writeStore({ videos: {} }), false);
      assert.equal(script.getStorageNotice(), 'failed');
    } finally {
      proto.setItem = originalSetItem;
      console.warn = originalWarn;
    }
  });
});
