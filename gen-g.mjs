#!/usr/bin/env node
// gen-g.mjs
//
// 只抓取公开可访问的部分：普通文章取正文；若页面出现订阅/付费标记，则只保留公开预览并注明。
// 不会尝试绕过任何登录或付费限制。
//
// 用法: node gen-g.mjs [选项]
//
// 选项:
//   --url <地址>       列表页地址（已内置默认值）
//   --out <文件>       输出文件（默认 feed-g.xml）
//   --limit <n>        列表最多取多少条（默认 100）
//   --max-items <n>    合并历史后总条数上限（默认 300）
//   --no-history       不保留历史条目
//   --self <URL>       写入 atom:link self
//   --guid-version <v> 给条目 GUID 加版本号
//   --with-content     抓取文章正文（公开部分）
//   --content-limit <n> 前 n 条抓正文（默认 20）
//   --content-max <n>  每条正文字数上限（默认 12000）
//   --content-cache <文件> 正文缓存（默认 .s-g.json）
//   --refresh-content  忽略缓存重抓
//   --force            内容没变也重写文件
//   -h, --help

import {
  esc,
  cdata,
  sleep,
  cleanText,
  decodeEntities,
  sanitizeContent,
  loadContentCache,
  saveContentCache,
  pruneCache,
  textLength,
  truncateHtml,
  SANITIZER_VERSION,
  httpText,
  guidFields,
  rssChannel,
  writeFeedOutput,
} from './lib.mjs';

const PAGE_URL = 'https://www.zaobao.com.sg/news/china';
const ORIGIN = 'https://www.zaobao.com.sg';
// 该站需要英文权重更高的 Accept-Language（与其余源不同，必须显式传入）
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

// 正文抽取规则变化时 +1，旧缓存自动失效
const CACHE_VERSION = SANITIZER_VERSION * 10 + 1;

/* ---------------- 抓取（实现见 lib.mjs httpText） ---------------- */

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const items = [];
  const seen = new Set();

  for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>\s*<h([23])[^>]*>([\s\S]*?)<\/h\2>\s*<\/a>/g)) {
    const href = m[1].trim();
    const title = cleanText(m[3]);
    if (!href || !title) continue;
    if (!/\/story\d{8}-\d+/.test(href)) continue;
    const url = /^https?:/i.test(href) ? href : ORIGIN + (href.startsWith('/') ? '' : '/') + href;
    if (seen.has(url)) continue;
    seen.add(url);
    const dm = url.match(/story(\d{4})(\d{2})(\d{2})-/);
    items.push({ title, url, dateRaw: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '' });
  }
  return items;
}

/* ---------------- 正文抽取（仅公开部分） ---------------- */
function extractArticle(html) {
  const meta = {};
  const dm = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})/);
  if (dm) {
    const p = (s) => String(s).padStart(2, '0');
    meta.datetime = `${dm[1]}-${p(dm[2])}-${p(dm[3])} ${p(dm[4])}`;
  }
  const byline = (html.match(/href="\/byline\/[^"]*"[^>]*>([^<]+)</) || [])[1];
  if (byline) meta.author = cleanText(byline);

  // 订阅/付费标记：命中则只保留公开预览，不做任何绕过
  const premium =
    /"(?:isPremium|premium|subscriberOnly)"\s*:\s*true|成为订户|订阅以继续|订阅后继续|subscriber-only/i.test(html);

  const s = html.indexOf('<main class="articlePage');
  const e = html.indexOf('</main>', s);
  const scope = s > -1 ? html.slice(s, e > s ? e : undefined) : html;

  // 主图与图注：优先取带说明文字（图注较长）的那张，避免抓到图片编号
  let lead = '';
  const candidates = [...scope.matchAll(/<img[^>]+src="(https:\/\/cassette[^"]+)"[^>]*>/gi)];
  let pick = null;
  for (const m of candidates) {
    const alt = cleanText((m[0].match(/(?:alt|title)="([^"]*)"/) || [])[1] || '');
    if (alt.length >= 10) {
      pick = { src: m[1], alt };
      break;
    }
  }
  if (!pick && candidates.length) pick = { src: candidates[0][1], alt: '' };
  if (pick) {
    lead = `<p><img src="${esc(decodeEntities(pick.src))}"${pick.alt ? ` alt="${esc(pick.alt)}"` : ''}/></p>` + (pick.alt ? `<p>${esc(pick.alt)}</p>` : '');
  }

  // 正文段落：排除“延伸阅读”与作者/日期行
  const kept = [];
  for (const m of scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = cleanText(m[1]);
    if (!text) continue;
    if (/延伸阅读/.test(text)) continue;
    if (/^发布\s*\//.test(text)) continue;
    kept.push(m[0]);
  }

  let body = sanitizeContent(kept.join(''));
  if (premium) {
    body = truncateHtml(body, 800) + '<p>（本文属于订阅内容，这里只保留公开部分，完整内容请点原文）</p>';
  }

  return { meta, contentHtml: lead + body, premium };
}

/* ---------------- RSS ---------------- */
const parseDate = (d) => {
  if (!d) return null;
  const t = new Date(`${d}T12:00:00+08:00`);
  return Number.isNaN(t.getTime()) ? null : t;
};

function renderItem(it, guidVersion) {
  const guid = guidFields(it.url, guidVersion, { vPrefix: true });
  const infoParts = [it.dateRaw, it.meta?.datetime, it.meta?.author ? `作者：${it.meta.author}` : ''].filter(Boolean);
  const desc =
    `<p><strong>${esc(it.title)}</strong></p>` +
    (infoParts.length ? `<p>${esc(infoParts.join('　'))}</p>` : '') +
    (it.contentHtml ? '<hr/>' + it.contentHtml : '') +
    `<hr/><p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;
  return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      <guid${guid.attr}>${esc(guid.value)}</guid>
      <description>${cdata(desc)}</description>${it.date ? `\n      <pubDate>${it.date.toUTCString()}</pubDate>` : ''}
    </item>`;
}

function buildFeed(items, { selfUrl, guidVersion, limit }) {
  const now = new Date();
  const newest = items[0]?.date || now;
  const rendered = items.map((it) => renderItem(it, guidVersion));

  const channel = rssChannel({
    title: '订阅源 G',
    link: PAGE_URL,
    description: '订阅源 G',
    selfUrl,
    buildDate: now,
    pubDate: newest,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
${channel}
${rendered.slice(0, limit > 0 ? limit : undefined).join('\n')}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = {
    url: PAGE_URL,
    out: 'feed-g.xml',
    limit: 100,
    maxItems: 300,
    history: true,
    self: null,
    guidVersion: '',
    withContent: false,
    contentLimit: 20,
    contentMax: 12000,
    contentCache: '.s-g.json',
    refreshContent: false,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--url': opts.url = next(); break;
      case '--out': opts.out = next(); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--max-items': opts.maxItems = Number(next()); break;
      case '--no-history': opts.history = false; break;
      case '--self': opts.self = next(); break;
      case '--guid-version': opts.guidVersion = next(); break;
      case '--with-content': opts.withContent = true; break;
      case '--content-limit': opts.contentLimit = Number(next()); break;
      case '--content-max': opts.contentMax = Number(next()); break;
      case '--content-cache': opts.contentCache = next(); break;
      case '--refresh-content': opts.refreshContent = true; break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `gen-g.mjs

用法: node gen-g.mjs [选项]

选项:
  --url <地址>       列表页地址（已内置默认值）
  --out <文件>       输出文件（默认 feed-g.xml）
  --limit <n>        列表最多取多少条（默认 100）
  --max-items <n>    合并历史后总条数上限（默认 300）
  --no-history       不保留历史条目
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号
  --with-content     抓取文章正文（仅公开部分）
  --content-limit <n> 前 n 条抓正文（默认 20）
  --content-max <n>  每条正文字数上限（默认 12000）
  --content-cache <文件> 正文缓存（默认 .s-g.json）
  --refresh-content  忽略缓存重抓
  --force            内容没变也重写文件
  -h, --help
`;

/* ---------------- 主流程 ---------------- */
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  console.log(`抓取列表页：${opts.url}`);
  const html = await httpText(opts.url, { headers: { 'Accept-Language': ACCEPT_LANGUAGE } });
  let items = parseList(html);
  console.log(`解析到 ${items.length} 条`);
  if (!items.length) throw new Error('没有解析到条目，页面结构可能已变化');

  for (const it of items) {
    it.date = parseDate(it.dateRaw);
    it.meta = {};
    it.contentHtml = '';
  }
  if (opts.limit > 0) items = items.slice(0, opts.limit);

  /* ---------------- 抓正文 ---------------- */
  if (opts.withContent) {
    const n = opts.contentLimit > 0 ? Math.min(opts.contentLimit, items.length) : items.length;
    const cache = loadContentCache(opts.contentCache);
    let fetched = 0;
    let fromCache = 0;
    let failed = 0;
    let premium = 0;

    console.log(`\n抓取正文：前 ${n} 条`);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const hit = cache[it.url];
      if (hit && !opts.refreshContent && typeof hit.contentHtml === 'string' && hit.v === CACHE_VERSION) {
        it.meta = hit.meta || {};
        it.contentHtml = hit.contentHtml;
        fromCache++;
        continue;
      }
      try {
        const page = await httpText(it.url, { headers: { 'Accept-Language': ACCEPT_LANGUAGE } });
        const art = extractArticle(page);
        it.meta = art.meta;
        it.contentHtml = truncateHtml(art.contentHtml, opts.contentMax);
        if (art.premium) premium++;
        cache[it.url] = {
          fetchedAt: new Date().toISOString(),
          v: CACHE_VERSION,
          meta: art.meta,
          contentHtml: it.contentHtml,
        };
        fetched++;
        console.log(
          `  ${String(i + 1).padStart(3)}/${n} ✓ ${textLength(it.contentHtml)} 字${
            art.premium ? '（含订阅限制）' : ''
          }  ${it.title.slice(0, 26)}`
        );
      } catch (e) {
        failed++;
        console.warn(`  ${String(i + 1).padStart(3)}/${n} ✗ ${it.title.slice(0, 30)}（${e.message}）`);
      }
      await sleep(500);
    }

    const dropped = pruneCache(cache, items.map((x) => x.url));
    saveContentCache(opts.contentCache, cache);
    console.log(
      `正文抓取完成：新抓 ${fetched} 条，用缓存 ${fromCache} 条，失败 ${failed} 条` +
        (premium ? `，其中 ${premium} 条受订阅限制只保留预览` : '') +
        (dropped ? `，清理过期缓存 ${dropped} 条` : '')
    );
  }

  const xml = buildFeed(items, { selfUrl: opts.self, guidVersion: opts.guidVersion, limit: opts.limit });
  const { changed, xml: outXml } = writeFeedOutput(opts.out, xml, {
    history: opts.history,
    maxItems: opts.maxItems,
    force: opts.force,
  });
  if (!changed) {
    console.log(`内容无变化，保留原文件 ${opts.out}`);
    return;
  }

  const total = (outXml.match(/<item>/g) || []).length;
  console.log(`最新：${items[0].dateRaw} ${items[0].title.slice(0, 40)}`);
  console.log(`已写入 ${opts.out}（共 ${total} 条，${(outXml.length / 1024).toFixed(1)} KB）`);
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
