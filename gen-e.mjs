#!/usr/bin/env node
// gen-e.mjs
//
// 用法: node gen-e.mjs [选项]
//
// 选项:
//   --url <地址>       列表页地址（已内置默认值）
//   --out <文件>       输出文件（默认 feed-e.xml）
//   --limit <n>        输出条数（默认 50，0 = 全部）
//   --self <URL>       写入 atom:link self
//   --guid-version <v> 给条目 GUID 加版本号
//   --force            内容没变也重写文件
//
// 正文相关:
//   --with-content     抓每篇正文（含翻页、主图与图注、来源与时间）
//   --content-limit <n> 前 n 条抓正文（默认 20）
//   --content-max <n>  每条正文字数上限（默认 12000）
//   --content-pages <n> 每条最多翻几页（默认 1，该站各页内容相同会自动跳过）
//   --content-cache <文件> 正文缓存（默认 .s-e.json）
//   --refresh-content  忽略缓存重抓
//   -h, --help

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {
  esc,
  cdata,
  sleep,
  cleanText,
  sliceDiv,
  sanitizeContent,
  SANITIZER_VERSION,
  textLength,
  truncateHtml,
  loadContentCache,
  saveContentCache,
  pruneCache,
  unchangedFile,
  absolutizeUrls,
} from './lib.mjs';

const PAGE_URL = 'http://finance.people.com.cn/GB/70846/index.html';
const ORIGIN = 'http://finance.people.com.cn';
// 本站缓存版本：正文抽取规则（尤其图片挑选取舍）变化时 +1，旧缓存自动失效
const CACHE_VERSION = SANITIZER_VERSION * 10 + 3;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------------- 抓取（兼容 GBK 页面） ---------------- */
function fetchText(url, retries = 3, depth = 0) {
  const once = () =>
    new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'identity',
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
            res.resume();
            return resolve(fetchText(new URL(res.headers.location, url).href, retries, depth + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            const err = new Error(`HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const head = buf.toString('latin1', 0, 2000);
            const m = head.match(/charset=["']?([\w-]+)/i);
            const cs = (m ? m[1] : 'utf-8').toLowerCase();
            if (/gb2312|gbk|gb18030/.test(cs)) {
              try {
                resolve(new TextDecoder('gb18030').decode(buf));
                return;
              } catch {
                /* 环境不支持时退回 utf8 */
              }
            }
            resolve(buf.toString('utf8'));
          });
        }
      );
      req.setTimeout(25000, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    });

  return (async () => {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        return await once();
      } catch (e) {
        last = e;
        if (e.statusCode === 403 || e.statusCode === 404) break;
        if (i < retries) await sleep(1000 * (i + 1));
      }
    }
    throw last;
  })();
}

/* ---------------- 列表解析 ---------------- */
function parseList(html) {
  const items = [];
  const blocks = [...html.matchAll(/<ul[^>]*class="[^"]*list_16[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi)];
  const scope = blocks.length ? blocks.map((b) => b[1]).join('\n') : html;

  for (const li of scope.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const a = li[1].match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = cleanText(a[2]);
    const href = a[1].trim();
    if (!title || !href || /index\.html$/.test(href)) continue;
    const dateRaw = (li[1].match(/<em[^>]*>\s*([\d]{4}-[\d]{2}-[\d]{2})[^<]*<\/em>/i) || [])[1] || '';
    const url = /^https?:/i.test(href) ? href : ORIGIN + (href.startsWith('/') ? '' : '/') + href;
    items.push({ title, url, dateRaw });
  }
  return items;
}

/* ---------------- 正文抽取 ---------------- */

// 站点内的推广图/图标特征：公众号二维码、扫一扫、客户端下载、分享、导航图标等
const BAD_IMG_SRC = /(?:\/img\/|\/static\/|\/images\/|logo|icon|share|arrow|spacer|blank|look\.png|qrcode|erweima|download)/i;
const BAD_IMG_ALT = /(?:公众号|二维码|扫一扫|关注|下载|客户端|分享|微信|微博)/;
const BAD_IMG_CLASS = /(?:tjewm|rmwApp|app-bot|share_con|rm_ranking|hot_con|nav|footer|paper_num)/i;

/** 判断某个 img 是不是正文照片（而不是页面图标/推广图） */
function isArticleImg(tag, before = '') {
  const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1] || '';
  if (!src) return false;
  const alt = (tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
  if (BAD_IMG_SRC.test(src) || BAD_IMG_ALT.test(alt)) return false;
  if (!/(?:NMediaFile|\/n1\/|MAIN|\.jpe?g|\.png|\.gif)(?:$|\?)/i.test(src)) return false;
  // 看它最近所在的容器 class
  const cls = ([...String(before).matchAll(/<div[^>]*class="([^"]{0,80})"/g)].pop() || [])[1] || '';
  if (BAD_IMG_CLASS.test(cls)) return false;
  return true;
}

/** 从候选位置挑正文主图；挑不到就返回 null（宁可不放图，也不放错图） */
function pickLeadImage(html, contentIdx) {
  const head = contentIdx > -1 ? html.slice(0, contentIdx) : html;
  const scope = head.length > 20000 ? head.slice(-20000) : head; // 只看正文附近，避免页头/侧栏

  // ① 最可靠：图注 <div class="text_show_img"> 前面紧挨着的那张图
  const capIdx = scope.search(/<div class="text_show_img"/i);
  if (capIdx > -1) {
    const seg = scope.slice(0, capIdx);
    const imgs = [...seg.matchAll(/<img[^>]+>/gi)];
    for (let k = imgs.length - 1; k >= 0 && k >= imgs.length - 4; k--) {
      const tag = imgs[k][0];
      if (isArticleImg(tag, seg.slice(0, imgs[k].index))) return tag;
    }
  }

  // ② 其次：lypic 容器（该站的正文图片容器）
  const ly = scope.lastIndexOf('lypic');
  if (ly > -1) {
    const seg = scope.slice(ly);
    for (const m of seg.matchAll(/<img[^>]+>/gi)) {
      if (isArticleImg(m[0], seg.slice(0, m.index))) return m[0];
    }
  }

  return null;
}

function extractArticle(html, { withLead = true } = {}) {
  const meta = {};
  const dm = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{2}:\d{2})/);
  if (dm) meta.datetime = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')} ${dm[4]}`;
  const sm = html.match(/来源：\s*([^<\s|]{2,20})/);
  if (sm) meta.source = cleanText(sm[1]);

  const contentIdx = html.indexOf('rm_txt_con');

  // 正文之前的主图与图注
  let lead = '';
  if (withLead) {
    const tag = pickLeadImage(html, contentIdx);
    if (tag) {
      const raw = (tag.match(/src=["']([^"']+)["']/i) || [])[1] || '';
      const src = raw.startsWith('//') ? 'https:' + raw : /^https?:/i.test(raw) ? raw : ORIGIN + (raw.startsWith('/') ? '' : '/') + raw;
      const alt = cleanText((tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '');
      lead =
        `<p><img src="${esc(src)}"${alt ? ` alt="${esc(alt)}"` : ''}/></p>` + (alt ? `<p>${esc(alt)}</p>` : '');
    }
  }

  const i = contentIdx;
  if (i === -1) return { meta, contentHtml: lead, bodyHtml: '', nextUrl: null };

  let block = sliceDiv(html, html.lastIndexOf('<div', i));
  // 去掉“责编/分享”那一段
  block = block.replace(/<p[^>]*class="[^"]*paper_num[^"]*"[\s\S]*?<\/p>/gi, '');

  const nextM = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*id=["']next["']/i) ||
    html.match(/<a[^>]+id=["']next["'][^>]*href=["']([^"']+)["']/i);

  // 正文里也可能混入二维码/推广图/分享图标，一并剔除
  let bodyHtml = absolutizeUrls(sanitizeContent(block), ORIGIN).replace(/<img[^>]*\/?>/gi, (tag) =>
    isArticleImg(tag) ? tag : ''
  );
  return { meta, contentHtml: lead + bodyHtml, bodyHtml, nextUrl: nextM ? nextM[1] : null };
}

/** 正文指纹：用于识别“下一页”其实是同一篇内容 */
const bodyKey = (h) => textLength(h) + ':' + String(h).slice(0, 200);

/** 抓一篇正文，必要时翻页（同内容页会自动跳过，避免重复拼接） */
async function fetchArticle(url, maxPages) {
  const html = await fetchText(url);
  const first = extractArticle(html, { withLead: true });
  const parts = [first.contentHtml];
  // 该模板的“下一页”各页正文完全相同，用纯正文指纹去重
  const seen = new Set([bodyKey(first.bodyHtml)]);
  let next = first.nextUrl;
  let pages = 1;

  while (next && pages < maxPages) {
    const nextUrl = /^https?:/i.test(next) ? next : ORIGIN + (next.startsWith('/') ? '' : '/') + next;
    await sleep(400);
    try {
      const more = await fetchText(nextUrl);
      const a = extractArticle(more, { withLead: false });
      const key = bodyKey(a.bodyHtml);
      if (!a.bodyHtml || seen.has(key)) break; // 内容重复 → 没有真正的下一页
      seen.add(key);
      parts.push(a.bodyHtml);
      next = a.nextUrl;
    } catch {
      break;
    }
    pages++;
  }

  return { meta: first.meta, contentHtml: parts.join(''), pages };
}

/* ---------------- RSS ---------------- */
const parseDate = (d) => {
  if (!d) return null;
  const t = new Date(`${d}T08:00:00+08:00`);
  return Number.isNaN(t.getTime()) ? null : t;
};

function buildFeed(items, { selfUrl, guidVersion }) {
  const now = new Date();
  const newest = items[0]?.date || now;

  const itemXml = items
    .map((it) => {
      const guidValue = guidVersion ? `${it.url}#${guidVersion}` : it.url;
      const guidAttr = guidVersion ? ' isPermaLink="false"' : ' isPermaLink="true"';
      const info = [it.dateRaw, it.meta?.datetime, it.meta?.source ? `来源：${it.meta.source}` : '']
        .filter(Boolean)
        .join('　');
      const desc =
        `<p><strong>${esc(it.title)}</strong></p>` +
        (info ? `<p>${esc(info)}</p>` : '') +
        (it.contentHtml ? '<hr/>' + it.contentHtml : '') +
        `<hr/><p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;

      return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      <guid${guidAttr}>${esc(guidValue)}</guid>
      <description>${cdata(desc)}</description>${it.date ? `\n      <pubDate>${it.date.toUTCString()}</pubDate>` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>订阅源 E</title>
    <link>${esc(PAGE_URL)}</link>
    <description>订阅源 E</description>
    <language>zh-CN</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <pubDate>${newest.toUTCString()}</pubDate>
    <generator>rss 1.0.0</generator>
    <ttl>60</ttl>${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${itemXml}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = {
    url: PAGE_URL,
    out: 'feed-e.xml',
    limit: 50,
    self: null,
    guidVersion: '',
    force: false,
    withContent: false,
    contentLimit: 20,
    contentMax: 12000,
    contentPages: 1,
    contentCache: '.s-e.json',
    refreshContent: false,
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
      case '--self': opts.self = next(); break;
      case '--guid-version': opts.guidVersion = next(); break;
      case '--with-content': opts.withContent = true; break;
      case '--content-limit': opts.contentLimit = Number(next()); break;
      case '--content-max': opts.contentMax = Number(next()); break;
      case '--content-pages': opts.contentPages = Number(next()); break;
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

const HELP = `gen-e.mjs

用法: node gen-e.mjs [选项]

选项:
  --url <地址>       列表页地址（已内置默认值）
  --out <文件>       输出文件（默认 feed-e.xml）
  --limit <n>        输出条数（默认 50）
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号
  --with-content     抓正文（含翻页、主图、来源与时间）
  --content-limit <n> 前 n 条抓正文（默认 20）
  --content-max <n>  每条正文字数上限（默认 12000）
  --content-pages <n> 每条最多翻几页（默认 1，该站各页内容相同会自动跳过）
  --content-cache <文件> 正文缓存（默认 .s-e.json）
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
  const html = await fetchText(opts.url);
  let items = parseList(html);
  console.log(`解析到 ${items.length} 条`);

  const seen = new Set();
  items = items.filter((it) => (seen.has(it.url) ? false : seen.add(it.url)));
  for (const it of items) {
    it.date = parseDate(it.dateRaw);
    it.meta = {};
    it.contentHtml = '';
  }
  items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  if (opts.limit > 0) items = items.slice(0, opts.limit);
  if (!items.length) throw new Error('没有解析到条目，页面结构可能已变化');

  /* ---------------- 抓正文 ---------------- */
  if (opts.withContent) {
    const n = opts.contentLimit > 0 ? Math.min(opts.contentLimit, items.length) : items.length;
    const cache = loadContentCache(opts.contentCache);
    let fetched = 0;
    let fromCache = 0;
    let failed = 0;

    console.log(`\n抓取正文：前 ${n} 条（每条最多翻 ${opts.contentPages} 页）`);
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
        const art = await fetchArticle(it.url, opts.contentPages);
        it.meta = art.meta;
        it.contentHtml = art.contentHtml;
        cache[it.url] = {
          fetchedAt: new Date().toISOString(),
          v: CACHE_VERSION,
          meta: art.meta,
          contentHtml: art.contentHtml,
        };
        fetched++;
        console.log(
          `  ${String(i + 1).padStart(3)}/${n} ✓ ${art.pages} 页 / ${textLength(art.contentHtml)} 字 / 加粗 ${
            (art.contentHtml.match(/<(strong|b)>/g) || []).length
          } 处  ${it.title.slice(0, 26)}`
        );
      } catch (e) {
        failed++;
        console.warn(`  ${String(i + 1).padStart(3)}/${n} ✗ ${it.title.slice(0, 30)}（${e.message}）`);
      }
      await sleep(400);
    }

    for (const it of items) {
      if (it.contentHtml) it.contentHtml = truncateHtml(it.contentHtml, opts.contentMax);
    }

    const dropped = pruneCache(cache, items.map((x) => x.url));
    saveContentCache(opts.contentCache, cache);
    console.log(
      `正文抓取完成：新抓 ${fetched} 条，用缓存 ${fromCache} 条，失败 ${failed} 条` +
        (dropped ? `，清理过期缓存 ${dropped} 条` : '')
    );
  }

  const xml = buildFeed(items, { selfUrl: opts.self, guidVersion: opts.guidVersion });

  if (!opts.force && fs.existsSync(opts.out) && unchangedFile(opts.out, xml)) {
    console.log(`内容无变化，保留原文件 ${opts.out}`);
    return;
  }

  fs.writeFileSync(opts.out, xml, 'utf8');
  console.log(`最新：${items[0].dateRaw} ${items[0].title.slice(0, 40)}`);
  console.log(`已写入 ${opts.out}（${items.length} 条，${(xml.length / 1024).toFixed(1)} KB）`);
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
