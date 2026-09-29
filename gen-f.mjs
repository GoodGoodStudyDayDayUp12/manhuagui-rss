#!/usr/bin/env node
// gen-f.mjs
//
// 用法: node gen-f.mjs [选项]
//
// 选项:
//   --url <地址>       页面地址（已内置默认值）
//   --out <文件>       输出文件（默认 feed-f.xml）
//   --limit <n>        输出条数（默认 30，0 = 全部）
//   --self <URL>       写入 atom:link self
//   --guid-version <v> 给条目 GUID 加版本号
//   --force            内容没变也重写文件
//   --no-history       不与已有输出合并历史条目
//   --max-items <n>    历史合并后的条目上限（默认 300）
//   -h, --help

import {
  esc,
  cdata,
  cleanText,
  sliceDiv,
  sanitizeContent,
  absolutizeUrls,
  httpText,
  guidFields,
  rssChannel,
  writeFeedOutput,
} from './lib.mjs';

const PAGE_URL = 'https://api-docs.deepseek.com/zh-cn/updates/';
const ORIGIN = 'https://api-docs.deepseek.com';

/* ---------------- 抓取（实现见 lib.mjs httpText） ---------------- */

/* ---------------- 解析更新条目 ---------------- */
function parseEntries(html) {
  // 正文容器
  const marker = html.indexOf('theme-doc-markdown');
  const containerStart = marker > -1 ? html.lastIndexOf('<div', marker) : -1;
  const scope = containerStart > -1 ? sliceDiv(html, containerStart) : html;

  // 以 <h2 …>时间: YYYY-MM-DD</h2> 为分隔
  const heads = [...scope.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)];
  const entries = [];

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const dateM = h[0].match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateM) continue;
    const dateRaw = dateM[1];
    const from = h.index + h[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : scope.length;
    let body = scope.slice(from, to);

    // 标题：该段里的所有 h3（可能一条日期下有多个模型）
    const titles = [...body.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)]
      .map((m) => cleanText(m[1]))
      .filter(Boolean);

    // 去掉自动生成的锚点链接
    body = body
      .replace(/<a[^>]*class="[^"]*hash-link[^"]*"[\s\S]*?<\/a>/gi, '')
      .replace(/<a[^>]*aria-label="[^"]*的直接链接"[\s\S]*?<\/a>/gi, '');

    const anchorId = (h[0].match(/id="([^"]+)"/) || [])[1] || '';
    entries.push({
      dateRaw,
      title: titles.length ? titles.join(' / ') : dateRaw,
      anchor: anchorId,
      contentHtml: absolutizeUrls(sanitizeContent(body), ORIGIN),
    });
  }

  return entries;
}

/* ---------------- RSS ---------------- */
const parseDate = (d) => {
  if (!d) return null;
  const t = new Date(`${d}T09:00:00+08:00`);
  return Number.isNaN(t.getTime()) ? null : t;
};

function buildFeed(entries, { selfUrl, guidVersion }) {
  const now = new Date();
  const newest = entries[0]?.date || now;

  const itemXml = entries
    .map((e) => {
      const link = e.anchor ? `${PAGE_URL}#${encodeURIComponent(e.anchor)}` : PAGE_URL;
      const guid = guidFields(link, guidVersion, { vPrefix: true });
      const desc =
        `<p><strong>${esc(e.title)}</strong></p>` +
        `<p>${esc(e.dateRaw)}</p>` +
        (e.contentHtml ? '<hr/>' + e.contentHtml : '') +
        `<hr/><p><a href="${esc(link)}">${esc(link)}</a></p>`;
      return `    <item>
      <title>${esc(e.title)}</title>
      <link>${esc(link)}</link>
      <guid${guid.attr}>${esc(guid.value)}</guid>
      <description>${cdata(desc)}</description>${e.date ? `\n      <pubDate>${e.date.toUTCString()}</pubDate>` : ''}
    </item>`;
    })
    .join('\n');

  const channel = rssChannel({
    title: '订阅源 F',
    link: PAGE_URL,
    description: '订阅源 F',
    selfUrl,
    buildDate: now,
    pubDate: newest,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
${channel}
${itemXml}
  </channel>
</rss>
`;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = {
    url: PAGE_URL,
    out: 'feed-f.xml',
    limit: 30,
    self: null,
    guidVersion: '',
    force: false,
    history: true,
    maxItems: 300,
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
      case '--force': opts.force = true; break;
      case '--no-history': opts.history = false; break;
      case '--max-items': opts.maxItems = Number(next()); break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `gen-f.mjs

用法: node gen-f.mjs [选项]

选项:
  --url <地址>       页面地址（已内置默认值）
  --out <文件>       输出文件（默认 feed-f.xml）
  --limit <n>        输出条数（默认 30，0 = 全部）
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号
  --force            内容没变也重写文件
  --no-history       不与已有输出合并历史条目
  --max-items <n>    历史合并后的条目上限（默认 300）
  -h, --help
`;

/* ---------------- 主流程 ---------------- */
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  console.log(`抓取页面：${opts.url}`);
  const html = await httpText(opts.url);
  let entries = parseEntries(html);
  console.log(`解析到 ${entries.length} 条更新记录`);
  if (!entries.length) throw new Error('没有解析到条目，页面结构可能已变化');

  for (const e of entries) e.date = parseDate(e.dateRaw);
  entries.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  if (opts.limit > 0) entries = entries.slice(0, opts.limit);

  const xml = buildFeed(entries, { selfUrl: opts.self, guidVersion: opts.guidVersion });
  const { changed, xml: outXml } = writeFeedOutput(opts.out, xml, {
    history: opts.history,
    maxItems: opts.maxItems,
    force: opts.force,
  });
  if (!changed) {
    console.log(`内容无变化，保留原文件 ${opts.out}`);
    return;
  }

  console.log(`最新：${entries[0].dateRaw} ${entries[0].title.slice(0, 40)}`);
  console.log(
    `已写入 ${opts.out}（共 ${(outXml.match(/<item>/g) || []).length} 条，${(outXml.length / 1024).toFixed(1)} KB）`
  );
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
