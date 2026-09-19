#!/usr/bin/env node
// gen-a.mjs


import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.0.0';
const SITE = 'https://www.manhuagui.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ');
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function clean(s) {
  return decodeEntities(stripTags(s)).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith('//')) return 'https:' + href;
  if (/^https?:\/\//i.test(href)) return href;
  return SITE + (href.startsWith('/') ? '' : '/') + href;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s) {
  return '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

/** 站点日期是北京时间，按 +08:00 解析 */
function parseSiteDate(ymd) {
  if (!ymd) return null;
  const d = new Date(`${ymd}T00:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function request(url, { timeout = 20000, redirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: SITE + '/',
          ...headers,
        },
      },
      (res) => {
        const { statusCode, headers: h } = res;
        if (statusCode >= 300 && statusCode < 400 && h.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('重定向次数过多'));
          const next = absUrl(h.location);
          return resolve(request(next, { timeout, redirects: redirects - 1, headers }));
        }
        if (statusCode !== 200) {
          res.resume();
          const err = new Error(statusCode === 403 ? 'HTTP 403（站点防护/访问过于频繁被拦截）' : `HTTP ${statusCode}`);
          err.statusCode = statusCode;
          return reject(err);
        }
        const enc = String(h['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          // 站点是 UTF-8；若出现乱码可在此加 iconv 兜底
          resolve(buf.toString('utf8'));
        });
        stream.on('error', reject);
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function fetchHtml(url, { retries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await request(url, { timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      // 403/404 属于站点策略或资源不存在，重试无意义，直接失败
      if (e.statusCode === 403 || e.statusCode === 404 || e.statusCode === 410) break;
      if (i < retries) {
        console.warn(`[warn] 第 ${i + 1} 次抓取失败（${e.code || e.message}），稍后重试…`);
        await sleep(800 * Math.pow(2, i));
      }
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * 解析漫画页
 * ------------------------------------------------------------------ */

export function parseComic(html, comicUrl) {
  const grab = (re, group = 1) => {
    const m = html.match(re);
    return m ? m[group] : null;
  };

  const title = clean(grab(/<div class="book-title">\s*<h1>([\s\S]*?)<\/h1>/)) || '未知漫画';
  const alias = clean(grab(/<div class="book-title">[\s\S]*?<h2>([\s\S]*?)<\/h2>/)) || null;
  const cover = absUrl(grab(/class="hcover">\s*<img src="([^"]+)"/));
  const coverStatus = clean(grab(/<p class="hcover">[\s\S]*?<span class="text">([\s\S]*?)<\/span>/)) || null;

  const listBlock = (label) => grab(new RegExp(`<strong>${label}：</strong>([\\s\\S]*?)</span>`));

  const anchorsOf = (block) => {
    if (!block) return [];
    return [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => clean(m[1])).filter(Boolean);
  };

  const authors = anchorsOf(listBlock('漫画作者'));
  const tags = anchorsOf(listBlock('漫画剧情'));
  const year = clean(listBlock('出品年代')) || null;
  const region = clean(listBlock('漫画地区')) || null;
  const aliasField = clean(listBlock('漫画别名')) || null;

  const statusBlock = grab(/<li class="status">([\s\S]*?)<\/li>/) || '';
  const serialStatus =
    (statusBlock.match(/漫画状态：<\/strong>\s*<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]?.trim() ||
    grab(/漫画状态：<\/strong>\s*<span[^>]*>([\s\S]*?)<\/span>/)?.trim() ||
    null;
  const updatedAtRaw =
    statusBlock.match(/最近于\s*\[\s*<span[^>]*>([\d-]+)<\/span>/)?.[1] ?? grab(/最近于\s*\[\s*([\d-]+)\s*\]/);
  const latestChapterUrl = absUrl(statusBlock.match(/更新至\s*\[\s*<a href="([^"]+)"/)?.[1] ?? null);
  const latestChapterTitle = clean(statusBlock.match(/更新至\s*\[\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '') || null;

  const introHtml = grab(/<div id="intro-all"[^>]*>([\s\S]*?)<\/div>/) || grab(/<div id="intro-cut"[^>]*>([\s\S]*?)<\/div>/) || '';
  const intro = clean(introHtml) || clean(grab(/<meta name="description" content="([^"]*)"/)) || '';

  const chapters = parseChapters(html);

  return {
    id: (comicUrl.match(/comic\/(\d+)/) || [])[1] || null,
    url: comicUrl,
    title,
    alias: aliasField || alias,
    cover,
    coverStatus,
    authors,
    tags,
    year,
    region,
    serialStatus,
    updatedAt: updatedAtRaw || null,
    latestChapterUrl,
    latestChapterTitle,
    intro,
    chapters,
    fetchedAt: new Date(),
  };
}

function parseChapters(html) {
  // 章节区：从 <div class="chapter cf ..."> 到「最近更新漫画」区块之前
  const startIdx = html.indexOf('<div class="chapter cf');
  let endIdx = html.indexOf('<div class="recent', startIdx === -1 ? 0 : startIdx);
  if (endIdx === -1) endIdx = html.indexOf('class="recent', startIdx === -1 ? 0 : startIdx);
  if (endIdx === -1) endIdx = html.length;
  const block = html.slice(startIdx === -1 ? 0 : startIdx, endIdx);

  // 站点把分段名放在 <h4><span>单话</span></h4> 里（两个 chapter-list 的 id 都叫 chapter-list-0，不能靠 id 分段）
  const heads = [...block.matchAll(/<h4>\s*<span>([\s\S]*?)<\/span>\s*<\/h4>/g)];
  const sections = [];
  if (heads.length === 0) {
    sections.push({ name: '', html: block });
  } else {
    heads.forEach((m, i) => {
      const from = m.index + m[0].length;
      const to = i + 1 < heads.length ? heads[i + 1].index : block.length;
      sections.push({ name: clean(m[1]), html: block.slice(from, to) });
    });
  }

  const chapters = [];
  for (const sec of sections) {
    const re = /<a\s+href="([^"]+)"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(sec.html))) {
      const inner = m[3];
      const pages = inner.match(/<i>\s*(\d+)\s*p\s*<\/i>/i);
      chapters.push({
        url: absUrl(m[1]),
        title: clean(m[2]) || clean(inner),
        section: sec.name,
        pages: pages ? Number(pages[1]) : null,
        isNew: /<em class="new"/.test(inner),
      });
    }
  }
  return chapters;
}

/* ------------------------------------------------------------------ *
 * 状态文件（记录首次见到章节的时间，用于 pubDate 和 --new-only）
 * ------------------------------------------------------------------ */

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.comics) return s;
  } catch {
    /* 首次运行 */
  }
  return { version: 1, comics: {} };
}

function saveState(file, state) {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[warn] 状态文件写入失败: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * RSS 2.0 生成
 * ------------------------------------------------------------------ */

export function buildFeed(
  comic,
  { items, selfUrl, limit = 100, feedTitle, feedDesc, withIntro = false, withCover = false } = {}
) {
  const picked = limit > 0 ? items.slice(0, limit) : items;
  const updated = parseSiteDate(comic.updatedAt);
  const lastBuild = new Date();

  const feedDescription = feedDesc || '订阅源 A';

  const title = feedTitle || '订阅源 A';
  const ctx = { withIntro, withCover };
  const itemXml = picked.map((ch) => renderItem(comic, ch, updated, ctx)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(comic.url)}</link>
    <description>${esc(feedDescription)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>${updated ? `\n    <pubDate>${updated.toUTCString()}</pubDate>` : ''}
    <generator>rss ${VERSION}</generator>
    <ttl>60</ttl>
    <dc:creator>rss</dc:creator>${comic.cover ? `\n    <image>\n      <url>${esc(comic.cover)}</url>\n      <title>${esc(comic.title)}</title>\n      <link>${esc(comic.url)}</link>\n    </image>` : ''}${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${itemXml}
  </channel>
</rss>
`;
}

function renderItem(comic, ch, updated, ctx = {}) {
  const bits = [];
  bits.push(`《${comic.title}》${ch.title}`);
  if (ch.pages) bits.push(`${ch.pages} 页`);
  if (ch.section) bits.push(ch.section);
  if (comic.serialStatus) bits.push(comic.serialStatus);
  if (ch.isNew && comic.updatedAt) bits.push(`本站更新于 ${comic.updatedAt}`);

  const titleText = ch.pages ? `${ch.title}（${ch.pages}p）` : ch.title;
  const html =
    `<p>${esc(bits.join(' · '))}</p>` +
    `<p><a href="${esc(ch.url)}">${esc(ch.url)}</a></p>` +
    (ctx.withCover && comic.cover
      ? `<p><a href="${esc(ch.url)}"><img src="${esc(comic.cover)}" alt="${esc(comic.title)}" /></a></p>`
      : '') +
    (ctx.withIntro && comic.intro ? `<hr/><p>${esc(comic.intro).replace(/\n/g, '<br/>')}</p>` : '');

  const pub = ch.pubDate ? `<pubDate>${ch.pubDate.toUTCString()}</pubDate>` : '';

  return `    <item>
      <title>${esc(titleText)}</title>
      <link>${esc(ch.url)}</link>
      <guid isPermaLink="true">${esc(ch.url)}</guid>
      <description>${cdata(html)}</description>
      <category>${esc(comic.title)}</category>${ch.section ? `\n      <category>${esc(ch.section)}</category>` : ''}${comic.authors.length ? `\n      <dc:creator>${esc(comic.authors.join('、'))}</dc:creator>` : ''}${pub ? `\n      ${pub}` : ''}
    </item>`;
}

/* ------------------------------------------------------------------ *
 * 单次生成流程
 * ------------------------------------------------------------------ */

function normalizeComicArg(arg) {
  const idMatch = String(arg).match(/comic\/(\d+)/) || String(arg).match(/^(\d+)$/);
  if (!idMatch) throw new Error(`无法识别的漫画参数: ${arg}（应为漫画 ID 或完整链接）`);
  const id = idMatch[1];
  return { id, url: `${SITE}/comic/${id}/` };
}

async function collect(comicRef, opts, state) {
  const html = await fetchHtml(comicRef.url, { retries: opts.retries, timeoutMs: opts.timeoutMs });
  const comic = parseComic(html, comicRef.url);
  if (!comic.id) comic.id = comicRef.id;
  if (!comic.chapters.length) throw new Error('未解析到任何章节，页面结构可能已变化');

  const rec = (state.comics[comic.id] ||= { seen: {}, title: comic.title });
  rec.title = comic.title;
  rec.lastCheck = new Date().toISOString();
  rec.lastUpdatedAt = comic.updatedAt;

  // 组装 item：站点顺序为最新在前
  const latestDate = parseSiteDate(comic.updatedAt);
  const seenNow = new Set();
  const prepared = comic.chapters.map((ch) => {
    seenNow.add(ch.url);
    const firstSeen = rec.seen[ch.url];
    const isLatest = comic.latestChapterUrl ? ch.url === comic.latestChapterUrl : ch.isNew;
    let pubDate = null;
    if (isLatest) {
      pubDate = latestDate || new Date();
    } else if (firstSeen) {
      // 旧章节的“首次见到”时间不能晚于最新章节，否则阅读器会把它们排到最前面
      const t = new Date(firstSeen);
      pubDate = latestDate && t > latestDate ? new Date(latestDate.getTime() - 60_000) : t;
    }
    return { ...ch, pubDate };
  });

  const isFirstRun = Object.keys(rec.seen).length === 0;
  const fresh = prepared.filter((ch) => !rec.seen[ch.url]);

  for (const ch of prepared) if (!rec.seen[ch.url]) rec.seen[ch.url] = new Date().toISOString();

  let items = prepared;
  if (opts.newOnly && !isFirstRun) {
    items = fresh.length ? fresh : prepared.slice(0, 1);
  }

  return { comic, items, fresh, isFirstRun, state };
}

async function generate(comics, opts) {
  const state = loadState(opts.state);
  const results = [];
  for (const ref of comics) {
    try {
      const { comic, items, fresh, isFirstRun } = await collect(ref, opts, state);
      const selfUrl = opts.self || (opts.serve ? `http://127.0.0.1:${opts.port}/${comics.length > 1 ? `comic/${comic.id}.xml` : 'feed.xml'}` : null);
      const xml = buildFeed(comic, {
        items,
        selfUrl,
        limit: opts.limit,
        withIntro: opts.withIntro,
        withCover: opts.withCover,
      });
      results.push({ comic, xml, fresh, isFirstRun, error: null });
      console.log(
        `[ok] ${comic.title} (${comic.id})：${comic.chapters.length} 章，输出 ${items.length} 条` +
          `，最新 ${comic.latestChapterTitle || '-'}（${comic.updatedAt || '未知'}）` +
          (opts.newOnly ? `，新增 ${fresh.length} 条` : '')
      );
    } catch (e) {
      console.error(`[fail] ${ref.url}：${e.message}`);
      if (e.statusCode === 403) {
        console.error('       站点拦下了这次请求（触发防护/访问过于频繁）。请等待几分钟到数十分钟后再试，并降低刷新频率。');
      } else if (e.code === 'ETIMEDOUT' || /超时/.test(e.message)) {
        console.error(
          '       连接建立后站点没有回应，通常是：站点被网络环境阻断/需要代理、站点临时维护、或请求过于频繁被限流。\n' +
            '       稍后重试、调大 --timeout/--retries，或改用可访问该站点的网络环境。'
        );
      }
      results.push({ comic: { id: ref.id, url: ref.url, title: ref.id }, xml: null, error: e });
    }
  }
  saveState(opts.state, state);
  return results;
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function writeOutputs(results, comics, opts) {
  // 显式给了 outdir（命令行或配置文件）时，即使只有一部漫画也用 manhuagui-<id>.xml 命名，便于托管
  const multi = comics.length > 1 || opts.outdirExplicit;
  const written = [];
  for (const r of results) {
    if (!r.xml) continue;
    const file = multi
      ? path.join(opts.outdir, comics.length > 1 ? `feed-a-${r.comic.id}.xml` : 'feed-a.xml')
      : path.resolve(opts.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.xml, 'utf8');
    written.push(file);
    console.log(`[write] ${file}`);
  }

  if (opts.combined && results.some((r) => r.xml)) {
    const ok = results.filter((r) => r.xml);
    const items = [];
    for (const r of ok) {
      const parsed = extractItems(r.xml);
      items.push(...parsed);
    }
    items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    const file = path.join(opts.outdir, 'feed-b.xml');
    fs.writeFileSync(file, buildCombinedFeed(ok.map((r) => r.comic), items, opts), 'utf8');
    written.push(file);
    console.log(`[write] ${file}（合并 ${ok.length} 部漫画）`);
  }
  return written;
}

function extractItems(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag) => block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
    const raw = get('title') || '';
    out.push({
      xml: `    <item>${m[1].trim().replace(/\n\s*/g, '\n      ')}</item>`,
      date: get('pubDate') ? new Date(decodeEntities(get('pubDate'))) : null,
      title: decodeEntities(raw),
    });
  }
  return out;
}

function buildCombinedFeed(comics, items, opts) {
  const selfUrl = opts.self || (opts.serve ? `http://127.0.0.1:${opts.port}/feed.xml` : null);
  const titles = comics.map((c) => c.title).join('、');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>订阅源 B</title>
    <link>${esc(SITE)}</link>
    <description>订阅源 B</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>rss ${VERSION}</generator>
    <ttl>60</ttl>${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}
${items.map((i) => i.xml).join('\n')}
  </channel>
</rss>
`;
}

/* ------------------------------------------------------------------ *
 * 本地订阅服务
 * ------------------------------------------------------------------ */

async function serve(comics, opts) {
  const cache = new Map(); // id -> { xml, at, error }

  async function refreshAll(force = false) {
    const now = Date.now();
    const stale = comics.filter((c) => {
      const hit = cache.get(c.id);
      return force || !hit || now - hit.at > opts.interval * 60_000;
    });
    if (!stale.length) return;
    const results = await generate(stale, { ...opts, state: opts.state });
    for (let i = 0; i < stale.length; i++) {
      const r = results[i];
      const selfUrl = `http://127.0.0.1:${opts.port}/${comics.length > 1 ? `comic/${stale[i].id}.xml` : 'feed.xml'}`;
      if (r.xml) {
        const xml = r.xml.replace(
          /<\/channel>/,
          `    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />\n  </channel>`
        );
        cache.set(stale[i].id, { xml: r.xml.includes('atom:link') ? r.xml : xml, at: Date.now(), error: null, title: r.comic.title });
      } else {
        const prev = cache.get(stale[i].id);
        cache.set(stale[i].id, { xml: prev?.xml ?? null, at: Date.now(), error: r.error, title: prev?.title ?? stale[i].id });
      }
    }
    if (opts.out || opts.outdir !== '.') {
      try {
        writeOutputs(results.filter((r) => r.xml), stale, opts);
      } catch (e) {
        console.warn(`[warn] 落盘失败: ${e.message}`);
      }
    }
  }

  await refreshAll(false);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${opts.port}`);
    const route = u.pathname.replace(/\/+$/, '') || '/';

    if (route === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, feeds: comics.map((c) => c.id), uptime: process.uptime() }));
    }

    if (route === '/refresh') {
      await refreshAll(true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, refreshed: comics.map((c) => c.id) }));
    }

    const feedRoute = route === '/feed.xml' || route === '/rss.xml' || route === '/rss';
    const idRoute = route.match(/^\/(?:comic\/)?(\d+)\.xml$/);

    if (feedRoute || idRoute) {
      const ref = idRoute ? comics.find((c) => c.id === idRoute[1]) : comics[0];
      if (!ref) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('未配置该漫画');
      }
      const hit = cache.get(ref.id);
      if (!hit || Date.now() - hit.at > opts.interval * 60_000) await refreshAll(false);
      const cur = cache.get(ref.id);
      if (!cur?.xml) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`抓取失败：${cur?.error?.message || '未知错误'}，请稍后重试`);
      }
      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': `public, max-age=${opts.interval * 60}`,
        'Access-Control-Allow-Origin': '*',
        'X-Feed-Fetched-At': new Date(cur.at).toISOString(),
      });
      return res.end(cur.xml);
    }

    if (route === '/' || route === '/index.html') {
      const rows = comics
        .map((c) => {
          const hit = cache.get(c.id);
          const file = comics.length > 1 ? `comic/${c.id}.xml` : 'feed.xml';
          const status = hit?.error ? `<span style="color:#c00">抓取失败：${esc(hit.error.message)}</span>` : `已更新 · ${hit ? new Date(hit.at).toLocaleString('zh-CN') : '-'}`;
          return `<li><a href="/${file}">${esc(hit?.title || c.id)}</a> — ${status}</li>`;
        })
        .join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>manhuagui RSS</title>` +
          `<h2>manhuagui RSS 订阅</h2><ul>${rows}</ul>` +
          `<p>刷新间隔 ${opts.interval} 分钟；<a href="/refresh">立即刷新</a> · <a href="/health">状态</a></p>`
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  const timer = setInterval(() => refreshAll(false).catch(() => {}), Math.max(1, opts.interval) * 60_000);

  await new Promise((resolve) => server.listen(opts.port, '127.0.0.1', resolve));

  const feedUrls = comics.map((c) => `  http://127.0.0.1:${opts.port}/${comics.length > 1 ? `comic/${c.id}.xml` : 'feed.xml'}`);
  console.log(`\nRSS 服务已启动（每 ${opts.interval} 分钟自动刷新，Ctrl+C 退出）：`);
  console.log(feedUrls.join('\n'));
  console.log(`  索引页 http://127.0.0.1:${opts.port}/`);

  const shutdown = () => {
    console.log('\n正在停止…');
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/** 读取 JSON 配置；配置里的相对路径按配置文件所在目录解析 */
function loadConfigFile(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件读取失败（${abs}）：${e.message}`);
  }
  const base = path.dirname(abs);
  const cfg = {};
  const comics = raw.comics ?? raw.ids;
  if (Array.isArray(comics) && comics.length) cfg.comics = comics.map(String);
  if (raw.out) cfg.out = path.resolve(base, raw.out);
  if (raw.outdir) {
    cfg.outdir = path.resolve(base, raw.outdir);
    cfg.outdirExplicit = true;
  }
  if (raw.state) cfg.state = path.resolve(base, raw.state);
  for (const k of ['limit', 'port', 'interval', 'retries']) {
    if (raw[k] !== undefined) cfg[k] = Number(raw[k]);
  }
  if (raw.timeout !== undefined) cfg.timeoutMs = Number(raw.timeout) * 1000;
  for (const k of ['combined', 'withIntro', 'withCover', 'newOnly', 'serve']) {
    if (raw[k] !== undefined) cfg[k] = Boolean(raw[k]);
  }
  if (raw.self) cfg.self = String(raw.self);
  return cfg;
}

function parseArgs(argv) {
  const opts = {
    comics: [],
    out: 'feed-a.xml',
    outdir: '.',
    outdirExplicit: false,
    limit: 100,
    state: '.s-a.json',
    newOnly: false,
    combined: false,
    withCover: false,
    serve: false,
    port: 8931,
    interval: 30,
    retries: 3,
    timeoutMs: 20000,
    withIntro: false,
    self: null,
    help: false,
  };

  // 先读配置文件作为默认值，命令行参数优先
  const ci = argv.indexOf('--config');
  if (ci !== -1) {
    const file = argv[ci + 1];
    if (!file) throw new Error('--config 缺少配置文件路径');
    Object.assign(opts, loadConfigFile(file));
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--config': i++; break; // 已在上面处理
      case '--out': opts.out = next(); break;
      case '--outdir': opts.outdir = next(); opts.outdirExplicit = true; break;
      case '--limit': opts.limit = Number(next()); break;
      case '--state': opts.state = next(); break;
      case '--port': opts.port = Number(next()); break;
      case '--interval': opts.interval = Number(next()); break;
      case '--retries': opts.retries = Number(next()); break;
      case '--timeout': opts.timeoutMs = Number(next()) * 1000; break;
      case '--self': opts.self = next(); break;
      case '--new-only': opts.newOnly = true; break;
      case '--with-intro': opts.withIntro = true; break;
      case '--with-cover': opts.withCover = true; break;
      case '--combined': opts.combined = true; break;
      case '--serve': opts.serve = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
        opts.comics.push(a);
    }
  }
  return opts;
}

const HELP = `gen-a.mjs

用法: node gen-a.mjs [ID或链接...] [选项]
      node gen-a.mjs --config config.json

选项:
  --config <文件>   配置文件
  --out <文件>      单个源输出（默认 feed-a.xml）
  --outdir <目录>   多源输出目录
  --limit <n>       条数（默认 100，0=全部）
  --new-only        只输出新增项
  --state <文件>    状态文件（默认 .s-a.json）
  --combined        额外生成合并源 feed-b.xml
  --with-cover      条目内嵌封面图
  --with-intro      条目内附简介
  --serve / --port / --interval   本地服务
  --self <URL>      写入 atom:link self
  --retries <n> / --timeout <秒>
  -h, --help
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.comics.length === 0) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  const comics = opts.comics.map(normalizeComicArg);
  const seen = new Set();
  const unique = comics.filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));

  if (opts.serve) return serve(unique, opts);

  const results = await generate(unique, opts);
  const written = writeOutputs(results, unique, opts);
  if (!written.length) {
    console.error('没有生成任何订阅文件。');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-a.mjs')) {
  main().catch((e) => {
    console.error('运行失败：' + e.message);
    process.exit(1);
  });
}
