#!/usr/bin/env node
/**
 * govcn-rss.mjs —— 把「中国政府网 · 最新政策」做成 RSS 2.0 订阅源
 *
 * 数据来源：页面 https://www.gov.cn/zhengce/zuixin/ 实际加载的
 *          https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json
 *          （含约 1100 条政策，字段：TITLE / SUB_TITLE / URL / DOCRELPUBTIME）
 *
 * 零依赖，Node.js >= 18。
 *
 * 用法：
 *   node govcn-rss.mjs                          # 生成 govcn-feed.xml（默认最近 50 条）
 *   node govcn-rss.mjs --limit 100 --out 政策.xml
 *   node govcn-rss.mjs --since 2026-01-01       # 只要这个日期之后的
 *   node govcn-rss.mjs --filter "条例|办法|通知"  # 标题关键词过滤（正则）
 *   node govcn-rss.mjs --all                    # 输出全部 1000+ 条
 */

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

/* ---------------- 生成 RSS ---------------- */
function buildFeed(items, { selfUrl, filterDesc }) {
  const now = new Date();
  const newest = items[0]?.date || now;
  const itemXml = items
    .map((it) => {
      const desc =
        `<p>${esc(it.title)}</p>` +
        `<p>发布日期：${esc(it.dateRaw)}　来源：中国政府网</p>` +
        `<p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`;
      return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.url)}</link>
      <guid isPermaLink="true">${esc(it.url)}</guid>
      <description>${cdata(desc)}</description>
      <category>最新政策</category>${it.date ? `\n      <pubDate>${it.date.toUTCString()}</pubDate>` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>中国政府网 · 最新政策</title>
    <link>${esc(PAGE_URL)}</link>
    <description>${esc(
      `中国政府网「最新政策」栏目更新（按发稿时间倒序）${filterDesc ? '；' + filterDesc : ''}。数据源：${DATA_URL}`
    )}</description>
    <language>zh-CN</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <pubDate>${newest.toUTCString()}</pubDate>
    <generator>govcn-rss 1.0.0</generator>
    <ttl>60</ttl>
    <dc:creator>中国政府网</dc:creator>${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${itemXml}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = { limit: 50, out: 'govcn-feed.xml', since: null, filter: null, all: false, self: null, force: false };
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
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `govcn-rss —— 中国政府网「最新政策」RSS 生成器

用法: node govcn-rss.mjs [选项]

选项:
  --out <文件>       输出文件（默认 govcn-feed.xml）
  --limit <n>        输出多少条（默认 50）
  --all              输出全部（约 1100 条）
  --since <日期>     只要该日期之后发布的，如 2026-01-01
  --filter <正则>    标题过滤，如 "条例|办法"
  --self <URL>       写入 atom:link rel="self"（托管后的地址）
  --force            即使内容没变化也重写文件
  -h, --help         帮助
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

  const xml = buildFeed(items, { selfUrl: opts.self, filterDesc });
  const newest = items[0];
  console.log(`\n输出 ${items.length} 条，最新：${newest.dateRaw} ${newest.title.slice(0, 40)}`);
  console.log(`最旧：${items[items.length - 1].dateRaw}`);

  // 条目完全没变时不重写文件，避免每次运行都产生一个只有 lastBuildDate 变化的提交
  const signature = (s) => (s.match(/<guid[^>]*>([\s\S]*?)<\/guid>/g) || []).join('|');
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
