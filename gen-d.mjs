#!/usr/bin/env node
// gen-d.mjs
//
// 用法: node gen-d.mjs [选项]
//
// 选项:
//   --mid <ID>         空间 ID（默认已内置）
//   --out <文件>       输出文件（默认 feed-d.xml）
//   --limit <n>        输出条数（默认 30，接口每页 30 条）
//   --self <URL>       写入 atom:link self
//   --guid-version <v> 给条目 GUID 加版本号
//   --attempts <n>     整体重试次数（默认 3）
//   --force            内容没变也重写文件
//   -h, --help

import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';

const MID_DEFAULT = '3493080468556379';
const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_SIZE = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/* ---------------- WBI 签名 ---------------- */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12,
  38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52,
];

function encWbi(params, imgKey, subKey) {
  const mixinKey = MIXIN_TAB.map((n) => (imgKey + subKey)[n]).join('').slice(0, 32);
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

/* ---------------- HTTP ---------------- */
function httpGet(url, cookie = '', { retries = 2, base = 5000 } = {}) {
  const once = () =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            'User-Agent': UA,
            Referer: 'https://space.bilibili.com/',
            Origin: 'https://space.bilibili.com',
            Accept: 'application/json, text/plain, */*',
            'Accept-Encoding': 'identity',
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const c = [];
          res.on('data', (x) => c.push(x));
          res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        }
      );
      req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    });

  return (async () => {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        return await once();
      } catch (e) {
        last = e;
        // 412 是风控，间隔要拉长，否则越试越被封
        if (i < retries) await sleep(base * (i + 1));
      }
    }
    throw last;
  })();
}

async function getCookie() {
  // buvid3/buvid4 必须来自同一次 finger/spi 调用，另补两个常见字段降低被风控概率
  const extra = `; b_nut=${Math.round(Date.now() / 1000)}; _uuid=${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
  try {
    const j = JSON.parse(await httpGet(`${API}/x/frontend/finger/spi`));
    if (j?.data?.b_3) return `buvid3=${j.data.b_3}; buvid4=${j.data.b_4 || ''}${extra}`;
  } catch {
    /* 拿不到就用空 cookie */
  }
  return '';
}

async function getWbiKeys(cookie) {
  const j = JSON.parse(await httpGet(`${API}/x/web-interface/nav`, cookie));
  const img = j?.data?.wbi_img?.img_url || '';
  const sub = j?.data?.wbi_img?.sub_url || '';
  const imgKey = img.split('/').pop().split('.')[0];
  const subKey = sub.split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new Error('拿不到 WBI 密钥');
  return { imgKey, subKey };
}

async function fetchVideosOnce(mid, want, cookie, keys) {
  const out = [];
  let pn = 1;
  while (out.length < want && pn <= 20) {
    const params = {
      mid,
      ps: PAGE_SIZE,
      pn,
      order: 'pubdate',
      platform: 'web',
      web_location: 1550101,
      tid: 0,
      keyword: '',
    };
    const body = await httpGet(`${API}/x/space/wbi/arc/search?${encWbi(params, keys.imgKey, keys.subKey)}`, cookie);
    const j = JSON.parse(body);
    if (j.code !== 0) throw new Error(`接口 code=${j.code} ${j.message || ''}`);
    const list = j.data?.list?.vlist || [];
    if (!list.length) break;
    out.push(...list);
    if (out.length >= (j.data?.page?.count ?? 0)) break;
    pn++;
    await sleep(800);
  }
  return out.slice(0, want);
}

/** 整体重试：每次重新取 cookie 和 WBI 密钥，间隔递增，降低被风控概率 */
async function fetchVideos(mid, want, attempts) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      const cookie = await getCookie();
      await sleep(1500);
      const keys = await getWbiKeys(cookie);
      await sleep(1500);
      return await fetchVideosOnce(mid, want, cookie, keys);
    } catch (e) {
      lastErr = e;
      if (a < attempts) {
        const wait = 15000 * a;
        console.warn(`  第 ${a} 次尝试失败（${e.message}），${wait / 1000} 秒后重试`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/* ---------------- RSS ---------------- */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const cdata = (s) => '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim();
const httpsPic = (u) => (u ? String(u).replace(/^http:\/\//i, 'https://') : '');

function buildFeed(videos, { mid, selfUrl, guidVersion }) {
  const now = new Date();
  const newest = videos[0]?.date || now;

  const itemXml = videos
    .map((v) => {
      const guidValue = guidVersion ? `${v.url}#${guidVersion}` : v.url;
      const guidAttr = guidVersion ? ' isPermaLink="false"' : ' isPermaLink="true"';
      const bits = [];
      if (v.duration) bits.push(`时长 ${v.duration}`);
      if (v.play) bits.push(`播放 ${v.play}`);
      if (v.dateRaw) bits.push(v.dateRaw);
      const desc =
        `<p><a href="${esc(v.url)}"><img src="${esc(v.cover)}" alt=""/></a></p>` +
        `<p><a href="${esc(v.url)}"><strong>${esc(v.title)}</strong></a></p>` +
        (v.desc ? `<p>${esc(v.desc)}</p>` : '') +
        (bits.length ? `<p>${esc(bits.join('　'))}</p>` : '') +
        `<hr/><p><a href="${esc(v.url)}">${esc(v.url)}</a></p>`;

      return `    <item>
      <title>${esc(v.title)}</title>
      <link>${esc(v.url)}</link>
      <guid${guidAttr}>${esc(guidValue)}</guid>
      <description>${cdata(desc)}</description>
      <category>订阅源 D</category>${v.date ? `\n      <pubDate>${v.date.toUTCString()}</pubDate>` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>订阅源 D</title>
    <link>${esc(`https://space.bilibili.com/${mid}`)}</link>
    <description>订阅源 D</description>
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
    mid: MID_DEFAULT,
    out: 'feed-d.xml',
    limit: PAGE_SIZE,
    self: null,
    guidVersion: '',
    attempts: 3,
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
      case '--mid': opts.mid = next(); break;
      case '--out': opts.out = next(); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--self': opts.self = next(); break;
      case '--guid-version': opts.guidVersion = next(); break;
      case '--attempts': opts.attempts = Number(next()); break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `gen-d.mjs

用法: node gen-d.mjs [选项]

选项:
  --mid <ID>         空间 ID（已内置默认值）
  --out <文件>       输出文件（默认 feed-d.xml）
  --limit <n>        输出条数（默认 30）
  --self <URL>       写入 atom:link self
  --guid-version <v> 给条目 GUID 加版本号
  --attempts <n>     整体重试次数（默认 3）
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

  console.log(`抓取空间 ${opts.mid} 的投稿列表…`);
  const raw = await fetchVideos(opts.mid, Math.max(opts.limit, 1), opts.attempts);
  console.log(`接口返回 ${raw.length} 条`);

  const videos = raw
    .map((v) => ({
      bvid: v.bvid,
      title: stripTags(v.title || ''),
      desc: stripTags(v.description ?? v.desc ?? '').slice(0, 600),
      cover: httpsPic(v.pic),
      duration: v.length || '',
      play: v.play ?? 0,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      date: v.created ? new Date(v.created * 1000) : null,
      dateRaw: v.created ? new Date(v.created * 1000).toISOString().slice(0, 10) : '',
    }))
    .filter((v) => v.bvid && v.title);

  if (!videos.length) throw new Error('没有解析到任何视频，接口结构可能已变化');
  videos.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  const xml = buildFeed(videos, { mid: opts.mid, selfUrl: opts.self, guidVersion: opts.guidVersion });

  const signature = (s) =>
    s.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '').replace(/<pubDate>[^<]*<\/pubDate>/, '');
  if (!opts.force && fs.existsSync(opts.out)) {
    const prev = fs.readFileSync(opts.out, 'utf8');
    if (signature(prev) === signature(xml)) {
      console.log(`内容无变化，保留原文件 ${opts.out}`);
      return;
    }
  }

  fs.writeFileSync(opts.out, xml, 'utf8');
  console.log(`最新：${videos[0].dateRaw} ${videos[0].title.slice(0, 36)}`);
  console.log(`已写入 ${opts.out}（${videos.length} 条，${(xml.length / 1024).toFixed(1)} KB）`);
})().catch((e) => {
  console.error('运行失败：' + e.message);
  process.exit(1);
});
