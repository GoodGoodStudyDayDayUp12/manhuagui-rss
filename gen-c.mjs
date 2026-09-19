#!/usr/bin/env node
// gen-c.mjs


import https from 'node:https';
import fs from 'node:fs';

const DATA_URL = 'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json';
const PAGE_URL = 'https://www.gov.cn/zhengce/zuixin/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------------- 工具 ---------------- */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const cdata = (s) => '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';

/** 政府网日期是北京时间，按 +08:00 解析 */
const parseDate = (d) => {
  if (!d) return null;
  const t = new Date(`${String(d).trim()}T00:00:00+08:00`);
  return Number.isNaN(t.getTime()) ? null : t;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Encoding': 'identity',
          Referer: PAGE_URL,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).href, depth + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.setTimeout(25000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function fetchJson(url, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return JSON.parse(await get(url));
    } catch (e) {
      last = e;
      if (e.statusCode === 403 || e.statusCode === 404) break;
      if (i < retries) {
        console.warn(`[warn] 第 ${i + 1} 次抓取失败（${e.message}），稍后重试…`);
        await sleep(800 * Math.pow(2, i));
      }
    }
  }
  throw last;
}

/* ---------------- 正文抓取 ---------------- */
const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const cleanText = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').trim();

/** 从 startIdx（指向 <div）开始按 div 深度截取整个元素 */
function sliceDiv(html, startIdx) {
  let depth = 0;
  let j = startIdx;
  while (j < html.length) {
    const o = html.indexOf('<div', j);
    const c = html.indexOf('</div>', j);
    if (c === -1) break;
    if (o !== -1 && o < c) {
      depth++;
      j = o + 4;
    } else {
      depth--;
      j = c + 6;
      if (depth === 0) return html.slice(startIdx, j);
    }
  }
  return html.slice(startIdx);
}

/** 清洗正文：只保留基本排版标签（加粗、标题、列表、表格、链接、图片），去掉所有属性里的样式类名 */
const KEEP_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'a', 'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const ATTR_KEEP = { a: ['href'], img: ['src', 'alt'] };

function sanitizeContent(raw) {
  let s = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<o:p[\s\S]*?<\/o:p>/gi, '');

  // 逐个标签处理：白名单外的标签剥掉（保留内部文字），白名单内的只留必要属性
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)(\/?)>/g, (m, close, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!KEEP_TAGS.has(name)) return '';
    if (close) return `</${name}>`;

    let kept = '';
    const keepList = ATTR_KEEP[name] || [];
    for (const attr of keepList) {
      const re = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const mm = attrs.match(re);
      const val = (mm && (mm[2] ?? mm[3] ?? mm[4])) || '';
      const v = val.trim();
      if (!v) continue;
      if (name === 'a' && !/^(https?:|mailto:|\/)/i.test(v)) continue;
      kept += ` ${attr}="${v.replace(/"/g, '&quot;')}"`;
    }
    return VOID_TAGS.has(name) ? `<${name}${kept}/>` : `<${name}${kept}>`;
  });

  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    // 去掉空段落
    .replace(/<p>(?:<br\/?>|\s)*<\/p>/gi, '')
    .replace(/<p>&#160;<\/p>/gi, '')
    .trim();

  // 开头若残留无标签文字，包进 <p>
  if (s && !s.startsWith('<')) s = '<p>' + s;
  return s;
}

/** 纯文本长度（用于截断判断） */
const textLength = (html) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().length;

/** 超出字数上限时，按 </p> 边界截断并补省略号 */
function truncateHtml(html, max) {
  if (max <= 0 || textLength(html) <= max) return html;
  const parts = html.split(/(?<=<\/p>)/);
  let out = '';
  let len = 0;
  for (const p of parts) {
    const l = textLength(p);
    if (len + l > max) break;
    out += p;
    len += l;
  }
  return (out || html.slice(0, max)) + '<p>……（全文请点原文链接）</p>';
}

/** 解析公文页面：元数据表 + 正文（保留基本排版） */
function extractArticle(html) {
  const meta = {};
  for (const m of html.matchAll(/<b>([^<]+?)：<\/b><\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const key = m[1].replace(/\s+/g, '');
    const val = cleanText(m[2]);
    if (val) meta[key] = val;
  }

  const i = html.indexOf('id="UCAP-CONTENT"');
  if (i === -1) return { meta, contentHtml: '' };
  const block = sliceDiv(html, html.lastIndexOf('<div', i));
  return { meta, contentHtml: sanitizeContent(block) };
}

function loadContentCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c === 'object') return c;
  } catch {
    /* 首次运行 */
  }
  return {};
}

function saveContentCache(file, cache) {
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[warn] 正文缓存写入失败：${e.message}`);
  }
}

/* ---------------- 生成 RSS ---------------- */
function buildFeed(items, { selfUrl, filterDesc, guidVersion = '' }) {
  const now = new Date();
  const newest = items[0]?.date || now;
  const itemXml = items
    .map((it) => {
      const head =
        `<p><strong>${esc(it.title)}</strong></p>` +
        `<p>${esc(it.dateRaw)}　来源：中国政府网` +
        (it.meta['发文机关'] ? `　发文机关：${esc(it.meta['发文机关'])}` : '') +
        (it.meta['发文字号'] ? `　${esc(it.meta['发文字号'])}` : '') +
        `</p>`;

      const body = it.contentHtml ? '<hr/>' + it.contentHtml : '';

      const foot = `<hr/><p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;
      const desc = head + body + foot;

      const extraCategories =
        (it.meta['发文机关'] ? `\n      <category>${esc(it.meta['发文机关'])}</category>` : '') +
        (it.meta['主题分类'] ? `\n      <category>${esc(it.meta['主题分类'])}</category>` : '');

      const guidValue = guidVersion ? `${it.url}#${guidVersion}` : it.url;
      const guidAttr = guidVersion ? ' isPermaLink="false"' : ' isPermaLink="true"';

      return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      <guid${guidAttr}>${esc(guidValue)}</guid>
      <description>${cdata(desc)}</description>
${extraCategories}${it.date ? `\n      <pubDate>${it.date.toUTCString()}</pubDate>` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>订阅源 C</title>
    <link>${esc(PAGE_URL)}</link>
    <description>${esc(
      `订阅源 C${filterDesc ? '；' + filterDesc : ''}`
    )}</description>
    <language>zh-CN</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <pubDate>${newest.toUTCString()}</pubDate>
    <generator>rss 1.0.0</generator>
    <ttl>60</ttl>
    ${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${itemXml}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = {
    limit: 50,
    out: 'feed-c.xml',
    since: null,
    filter: null,
    all: false,
    self: null,
    force: false,
    withContent: false,
    contentLimit: 20,
    contentMax: 12000,
    contentCache: '.s-c.json',
    refreshContent: false,
    guidVersion: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--limit': opts.limit = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--since': opts.since = next(); break;
      case '--filter': opts.filter = next(); break;
      case '--self': opts.self = next(); break;
      case '--all': opts.all = true; break;
      case '--force': opts.force = true; break;
      case '--guid-version': opts.guidVersion = next(); break;
      case '--with-content': opts.withContent = true; break;
      case '--content-limit': opts.contentLimit = Number(next()); break;
      case '--content-max': opts.contentMax = Number(next()); break;
      case '--content-cache': opts.contentCache = next(); break;
      case '--refresh-content': opts.refreshContent = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `gen-c.mjs

用法: node gen-c.mjs [选项]

选项:
  --out <文件>       输出文件（默认 feed-c.xml）
  --limit <n>        输出条数（默认 50）
  --all              输出全部
  --since <日期>     该日期之后
  --filter <正则>    标题过滤
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号（改它可让阅读器把全部条目当新条目重新导入）
  --force            强制重写文件
  --with-content     抓取正文与元数据
  --content-limit <n> 前 n 条抓正文（默认 20）
  --content-max <n>  每条正文字数上限（默认 12000）
  --content-cache <文件> 正文缓存（默认 .s-c.json）
  --refresh-content  忽略缓存
  -h, --help
`;

/* ---------------- 主流程 ---------------- */
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  console.log(`抓取数据源：${DATA_URL}`);
  const raw = await fetchJson(DATA_URL);
  const arr = Array.isArray(raw) ? raw : raw.list || raw.data || raw.result || [];
  if (!arr.length) throw new Error('数据源里没有条目，接口结构可能已变化');
  console.log(`接口返回 ${arr.length} 条`);

  let items = arr
    .map((r) => ({
      title: String(r.TITLE || r.title || '').trim(),
      subTitle: String(r.SUB_TITLE || '').trim(),
      url: String(r.URL || r.url || '').trim(),
      dateRaw: String(r.DOCRELPUBTIME || r.pubtime || r.date || '').trim(),
      date: parseDate(r.DOCRELPUBTIME || r.pubtime || r.date),
    }))
    .filter((it) => it.title && it.url);

  // 按发布时间倒序（接口本身是新→旧，这里再保证一次）
  items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  let filterDesc = '';
  if (opts.since) {
    const since = parseDate(opts.since);
    const before = items.length;
    items = items.filter((it) => it.date && it.date >= since);
    filterDesc = `仅 ${opts.since} 之后（${items.length}/${before} 条）`;
  }
  if (opts.filter) {
    const re = new RegExp(opts.filter);
    const before = items.length;
    items = items.filter((it) => re.test(it.title));
    filterDesc = `${filterDesc ? filterDesc + '，' : ''}标题含 /${opts.filter}/（${items.length}/${before} 条）`;
  }
  if (!opts.all) items = items.slice(0, opts.limit);

  if (!items.length) throw new Error('过滤后没有条目，请放宽条件');

  // 每条默认带空元数据，便于之后统一渲染
  for (const it of items) {
    it.meta = {};
    it.contentHtml = '';
  }

  /* ---------------- 抓正文（可选） ---------------- */
  if (opts.withContent) {
    const n = opts.contentLimit > 0 ? Math.min(opts.contentLimit, items.length) : items.length;
    const cache = loadContentCache(opts.contentCache);
    let fetched = 0;
    let fromCache = 0;
    let failed = 0;

    console.log(`\n抓取正文：前 ${n} 条（缓存文件 ${opts.contentCache}）`);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const hit = cache[it.url];
      // 旧版缓存里存的是纯文本段落，没有 contentHtml，视为未命中以便重新抓取带排版的版本
      if (hit && !opts.refreshContent && typeof hit.contentHtml === 'string') {
        it.meta = hit.meta || {};
        it.contentHtml = hit.contentHtml;
        fromCache++;
        continue;
      }
      try {
        const html = await get(it.url);
        const art = extractArticle(html);
        it.meta = art.meta;
        it.contentHtml = art.contentHtml;
        cache[it.url] = { fetchedAt: new Date().toISOString(), meta: art.meta, contentHtml: art.contentHtml };
        fetched++;
        console.log(
          `  ${String(i + 1).padStart(3)}/${n} ✓ ${textLength(art.contentHtml)} 字 / 加粗 ${
            (art.contentHtml.match(/<(strong|b)>/g) || []).length
          } 处  ${it.title.slice(0, 30)}`
        );
      } catch (e) {
        failed++;
        console.warn(`  ${String(i + 1).padStart(3)}/${n} ✗ ${it.title.slice(0, 34)}（${e.message}）`);
      }
      await sleep(350);
    }

    // 超出字数上限时按段落边界截断
    for (const it of items) {
      if (it.contentHtml) it.contentHtml = truncateHtml(it.contentHtml, opts.contentMax);
    }

    // 只保留当前条目用到的缓存，避免文件无限增长
    const keep = new Set(items.map((x) => x.url));
    let dropped = 0;
    for (const k of Object.keys(cache)) {
      if (!keep.has(k)) {
        delete cache[k];
        dropped++;
      }
    }

    saveContentCache(opts.contentCache, cache);
    console.log(
      `正文抓取完成：新抓 ${fetched} 条，用缓存 ${fromCache} 条，失败 ${failed} 条` +
        (dropped ? `，清理过期缓存 ${dropped} 条` : '')
    );
  }

  const xml = buildFeed(items, { selfUrl: opts.self, filterDesc, guidVersion: opts.guidVersion });
  const newest = items[0];
  console.log(`\n输出 ${items.length} 条，最新：${newest.dateRaw} ${newest.title.slice(0, 40)}`);
  console.log(`最旧：${items[items.length - 1].dateRaw}`);

  // 除构建时间外，频道与条目任何变化都算“有变化”；
  // 只有 lastBuildDate / 频道 pubDate 变动时视为没变，避免产生空提交
  const signature = (s) =>
    s.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '').replace(/<pubDate>[^<]*<\/pubDate>/, '');
  if (!opts.force && fs.existsSync(opts.out)) {
    const prev = fs.readFileSync(opts.out, 'utf8');
    if (signature(prev) === signature(xml)) {
      console.log(`内容无变化，保留原文件 ${opts.out}（不产生新提交）`);
      return;
    }
  }

  fs.writeFileSync(opts.out, xml, 'utf8');
  console.log(`已写入 ${opts.out}（${(xml.length / 1024).toFixed(1)} KB）`);
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
