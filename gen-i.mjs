#!/usr/bin/env node
// gen-i.mjs
//
// 用法: node gen-i.mjs [选项]
//
// 选项:
//   --config <文件>    配置文件（一次生成多个关键词源）
//   --keyword <词>     搜索关键词（默认 肯德基）
//   --url <地址>       直接指定完整搜索地址（会覆盖 keyword）
//   --out <文件>       输出文件（默认 feed-i.xml）
//   --limit <n>        输出条数（默认 100）
//   --pages <n>        抓前 n 页（每页 30 条左右，默认 1）
//   --max-items <n>    合并历史后总条数上限（默认 300）
//   --no-history       不保留历史条目
//   --self <URL>       写入 atom:link self
//   --guid-version <v> 给条目 GUID 加版本号
//   --force            内容没变也重写文件
//   -h, --help

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { esc, cdata, sleep, cleanText, decodeEntities, unchangedFile, mergeHistoryIntoXml } from './lib.mjs';

const KEYWORD_DEFAULT = '肯德基';
const BASE = 'https://s.manmanbuy.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------------- 抓取 ---------------- */
function fetchText(url, retries = 3, depth = 0) {
  const once = () =>
    new Promise((resolve, reject) => {
      const req = https.get(
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
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
// 站点用 Next.js CSS Modules，类名后缀哈希会变，这里统一按前缀匹配
const pick = (block, prefix) => {
  const re = new RegExp(`class="[^"]*${prefix}__[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
  return (block.match(re) || [])[1] || '';
};

function parseDeals(html) {
  const deals = [];
  const seen = new Set();

  // 每个条目以 DiscountItemPC_box__ 开头（split 已切好，直接用即可）
  const blocks = html.split(/(?=<div class="DiscountItemPC_box__)/).filter((b) => b.includes('DiscountItemPC_box__'));
  for (const block of blocks) {
    // 主链接与标题
    const titleA = block.match(/<div class="DiscountItemPC_itemTitle__[^"]*">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleA) continue;
    const url = decodeEntities(titleA[1].trim());
    const title = cleanText(titleA[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);

    const subA = block.match(/<div class="DiscountItemPC_itemSubTitle__[^"]*">\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const tagBlock = pick(block, 'DiscountItemPC_itemTag');
    const timeM = block.match(/<span class="DiscountItemPC_itemTime__[^"]*">([^<]*)<\/span>/i);
    const mallM = block.match(/<span class="DiscountItemPC_itemMall__[^"]*">([^<]*)<\/span>/i);
    const coverM = block.match(/<div class="DiscountItemPC_itemCover__[^"]*">[\s\S]*?<img[^>]+src="([^"]+)"/i);
    const badgeM = block.match(/<div class="DiscountItemPC_itemCover__[^"]*">\s*<span[^>]*>([^<]*)<\/span>/i);
    const commentM = block.match(/DiscountItemPC_iconComment__[^"]*">[\s\S]*?<\/i>([\s\S]*?)<\/span>/i);
    const hotM = block.match(/DiscountItemPC_iconHot__[^"]*">[\s\S]*?<\/i>([\s\S]*?)<\/span>/i);

    deals.push({
      title,
      subtitle: subA ? cleanText(subA[1]) : '',
      url,
      tag: cleanText(tagBlock).replace(/\s+/g, ' '),
      badge: cleanText(badgeM ? badgeM[1] : ''),
      mall: cleanText(mallM ? mallM[1] : ''),
      timeRaw: cleanText(timeM ? timeM[1] : ''),
      cover: coverM ? decodeEntities(coverM[1]) : '',
      comments: cleanText(commentM ? commentM[1] : ''),
      hot: cleanText(hotM ? hotM[1] : ''),
    });
  }
  return deals;
}

/* ---------------- 时间解析（页面只有 MM-DD HH:mm，按北京时间） ---------------- */
function parseDealTime(s) {
  const m = String(s || '').match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, mo, dd, hh, mi] = m.map(Number);
  const now = Date.now();
  const build = (year) => new Date(Date.UTC(year, mo - 1, dd, hh, mi) - 8 * 3600 * 1000);
  let d = build(new Date().getUTCFullYear());
  if (d.getTime() - now > 2 * 24 * 3600 * 1000) d = build(new Date().getUTCFullYear() - 1);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---------------- RSS ---------------- */
function renderItem(it, guidVersion) {
  const guidValue = guidVersion ? `${it.url}#v${guidVersion}` : it.url;
  const guidAttr = guidVersion ? ' isPermaLink="false"' : ' isPermaLink="true"';
  const meta = [it.mall, it.timeRaw, it.tag, it.badge].filter(Boolean).join('　');
  const stat = [it.comments ? `评论 ${it.comments}` : '', it.hot ? `热度 ${it.hot}` : ''].filter(Boolean).join('　');
  const desc =
    `<p><strong>${esc(it.title)}</strong></p>` +
    (it.subtitle ? `<p>${esc(it.subtitle)}</p>` : '') +
    (meta ? `<p>${esc(meta)}</p>` : '') +
    (it.cover ? `<p><img src="${esc(it.cover)}"/></p>` : '') +
    (stat ? `<p>${esc(stat)}</p>` : '') +
    `<hr/><p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;
  return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      <guid${guidAttr}>${esc(guidValue)}</guid>
      <description>${cdata(desc)}</description>${it.mall ? `\n      <category>${esc(it.mall)}</category>` : ''}${it.date ? `\n      <pubDate>${it.date.toUTCString()}</pubDate>` : ''}
    </item>`;
}

function buildFeed(deals, { selfUrl, guidVersion, limit, pageUrl }) {
  const now = new Date();
  const newest = deals[0]?.date || now;
  const rendered = deals.map((it) => renderItem(it, guidVersion));

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>订阅源 I</title>
    <link>${esc(pageUrl)}</link>
    <description>订阅源 I</description>
    <language>zh-CN</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <pubDate>${newest.toUTCString()}</pubDate>
    <generator>rss 1.0.0</generator>
    <ttl>60</ttl>${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${rendered.slice(0, limit > 0 ? limit : undefined).join('\n')}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = {
    config: null,
    keyword: KEYWORD_DEFAULT,
    url: null,
    out: 'feed-i.xml',
    limit: 100,
    pages: 1,
    maxItems: 300,
    history: true,
    self: null,
    guidVersion: '',
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
      case '--config': opts.config = next(); break;
      case '--keyword': opts.keyword = next(); break;
      case '--url': opts.url = next(); break;
      case '--out': opts.out = next(); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--pages': opts.pages = Number(next()); break;
      case '--max-items': opts.maxItems = Number(next()); break;
      case '--no-history': opts.history = false; break;
      case '--self': opts.self = next(); break;
      case '--guid-version': opts.guidVersion = next(); break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `gen-i.mjs

用法: node gen-i.mjs [选项]

选项:
//   --keyword <词>     搜索关键词（默认 肯德基）
  --url <地址>       直接指定完整搜索地址
  --out <文件>       输出文件（默认 feed-i.xml）
  --limit <n>        输出条数（默认 100）
  --pages <n>        抓前 n 页（默认 1）
  --max-items <n>    合并历史后总条数上限（默认 300）
  --no-history       不保留历史条目
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号
  --force            内容没变也重写文件
  -h, --help
`;

/* ---------------- 主流程 ---------------- */
const pageUrlFor = (opts, page) =>
  opts.url
    ? opts.url
    : `${BASE}/pc/search/result?c=discount&keyword=${encodeURIComponent(opts.keyword)}&orderby=new&infoType=0&pageId=${page}`;

/** 生成单个源 */
async function runOne(opts) {
  const label = opts.url ? opts.url : `关键词 ${opts.keyword}`;
  const all = [];
  const seen = new Set();
  for (let p = 1; p <= Math.max(1, opts.pages); p++) {
    const u = pageUrlFor(opts, p);
    console.log(`抓取第 ${p} 页：${u}`);
    const html = await fetchText(u);
    const deals = parseDeals(html);
    console.log(`  解析到 ${deals.length} 条`);
    for (const d of deals) if (!seen.has(d.url)) { seen.add(d.url); all.push(d); }
    if (p < opts.pages) await sleep(800);
  }

  if (!all.length) throw new Error('没有解析到条目，页面结构可能已变化');

  for (const d of all) d.date = parseDealTime(d.timeRaw);
  const withTime = all.filter((d) => d.date);
  if (withTime.length) {
    // 有时间的按时间倒序，没时间的保持原顺序放后面
    const sorted = [...withTime].sort((a, b) => b.date - a.date);
    const rest = all.filter((d) => !d.date);
    all.length = 0;
    all.push(...sorted, ...rest);
  }

  let xml = buildFeed(all, {
    selfUrl: opts.self,
    guidVersion: opts.guidVersion,
    limit: opts.limit,
    pageUrl: pageUrlFor(opts, 1),
  });
  if (opts.history) xml = mergeHistoryIntoXml(xml, opts.out, { maxItems: opts.maxItems });

  if (!opts.force && fs.existsSync(opts.out) && unchangedFile(opts.out, xml)) {
    console.log(`内容无变化，保留原文件 ${opts.out}`);
    return;
  }

  fs.writeFileSync(opts.out, xml, 'utf8');
  const total = (xml.match(/<item>/g) || []).length;
  console.log(`  最新：${all[0].timeRaw} ${all[0].title.slice(0, 40)}`);
  console.log(`  已写入 ${path.basename(opts.out)}（共 ${total} 条，${(xml.length / 1024).toFixed(1)} KB）`);
  return total;
}

/* ---------------- 多源调度 ---------------- */
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  let feeds = [opts];
  if (opts.config) {
    const abs = path.resolve(opts.config);
    const base = path.dirname(abs);
    const cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    feeds = (cfg.feeds || [])
      .filter((f) => f.enabled !== false)
      .map((f) => ({
        ...opts,
        keyword: f.keyword ?? opts.keyword,
        url: f.url ?? null,
        out: f.out ? path.resolve(base, f.out) : opts.out,
        limit: f.limit ?? opts.limit,
        pages: f.pages ?? opts.pages,
        maxItems: f.maxItems ?? opts.maxItems,
        self: f.self ?? opts.self,
      }));
    if (!feeds.length) throw new Error('配置文件里没有启用的源');
    console.log(`配置文件 ${path.basename(abs)}：共 ${feeds.length} 个源\n`);
  }

  let ok = 0;
  let failed = 0;
  for (const f of feeds) {
    const label = f.url ? f.url : `关键词 ${f.keyword}`;
    console.log(`=== ${label} → ${path.basename(f.out)} ===`);
    try {
      await runOne(f);
      ok++;
    } catch (e) {
      failed++;
      console.error(`  [失败] ${label}：${e.message}`);
    }
  }
  console.log(`\n完成：成功 ${ok} 个，失败 ${failed} 个`);
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
