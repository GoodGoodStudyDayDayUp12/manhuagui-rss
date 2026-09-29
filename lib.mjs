// lib.mjs —— 各订阅源脚本共用的工具与小工具
//
// 主要提供：HTML 清洗（保留加粗/标题/列表/表格/链接/图片）、按 div 深度切片、
// 实体解码、正文长度与截断、RSS 转义等。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 转义 ---------------- */
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const cdata = (s) => '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';

/**
 * 数字实体码点转换：越界（如 &#99999999;）时返回 null，调用方保留原文本。
 * 直接用 String.fromCodePoint 会抛 RangeError，让整次生成失败。
 */
const codePointChar = (n) =>
  Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;

/** 解码常见 HTML 实体；extra=true 时额外解码 &ndash; / &hellip;（gen-a 原有能力） */
export const decodeEntities = (s, { extra = false } = {}) => {
  let out = String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePointChar(parseInt(h, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, d) => codePointChar(Number(d)) ?? m)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—');
  if (extra) out = out.replace(/&ndash;/g, '–').replace(/&hellip;/g, '…');
  return out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
};

/** 去掉 XML 非法控制字符与零宽字符（页面上常见的隐形垃圾，会让 RSS 校验失败） */
export const stripInvisible = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

export const cleanText = (s) =>
  stripInvisible(decodeEntities(String(s).replace(/<[^>]+>/g, ' '))).replace(/[ \t\u00a0]+/g, ' ').trim();

/** 剥掉所有标签并 trim（原先 gen-d 的本地实现，用于标题/简介等纯文本字段） */
export const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim();

/** 把 HTML 片段压成纯文本，块级/换行标签转成换行（原先 gen-a 的本地实现） */
export const htmlToText = (s) =>
  String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ');

/* ---------------- HTTP ---------------- */
/** 抓页面时统一的浏览器 UA（各生成器原有字面量） */
export const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HTML_HEADERS = {
  'User-Agent': UA_BROWSER,
  Accept: 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'identity',
};

const DEFAULT_NON_RETRY = new Set([403, 404]);

/**
 * 抓取文本页面（原先 gen-e/f/g/i 各有一份几乎相同的实现）。
 * 覆盖原有四份的全部能力：http/https 自动或显式选择、GBK/charset 嗅探解码、
 * 重定向跟随、超时、重试与退避、不可重试状态码、自定义请求头。
 * 顶层调用返回页面文本；重定向按 depth 递归，语义与原来一致。
 */
export async function httpText(url, opts = {}) {
  const {
    timeoutMs = 25000,
    retries = 3,
    nonRetry = DEFAULT_NON_RETRY,
    headers = {},
    backoff = (i) => 1000 * (i + 1),
    decodeGb = false,
    protocol = null,
    maxRedirects = 5,
    depth = 0,
    refererOrigin = '',
  } = opts;

  const once = () =>
    new Promise((resolve, reject) => {
      const lib = protocol === 'http' ? http : protocol === 'https' ? https : url.startsWith('https') ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            ...HTML_HEADERS,
            ...(refererOrigin ? { Referer: refererOrigin } : {}),
            ...headers,
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < maxRedirects) {
            res.resume();
            return resolve(httpText(new URL(res.headers.location, url).href, { ...opts, depth: depth + 1 }));
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
            if (decodeGb) {
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
            }
            resolve(buf.toString('utf8'));
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    });

  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await once();
    } catch (e) {
      last = e;
      if (nonRetry.has(e.statusCode)) break;
      if (i < retries) await sleep(backoff(i));
    }
  }
  throw last;
}

/* ---------------- HTML 切片 ---------------- */
/** 从 startIdx（指向 <div）开始按 div 深度截取整个元素 */
export function sliceDiv(html, startIdx) {
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

/* ---------------- 正文清洗 ---------------- */
/** 清洗规则版本：改动清洗逻辑时 +1，缓存里版本不一致会自动重抓 */
export const SANITIZER_VERSION = 3;

const KEEP_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'pre', 'code',
  'a', 'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const ATTR_KEEP = { a: ['href'], img: ['src', 'alt'] };

/** 判断一段加粗文字是不是小标题（一、 / （一） / 1. 开头） */
export const isSectionHeading = (t) =>
  /^([一二三四五六七八九十百]+[、.．]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\)|\d+[、.．])/.test(t);

export function sanitizeContent(raw) {
  let s = String(raw)
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
    for (const attr of ATTR_KEEP[name] || []) {
      const re = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const mm = attrs.match(re);
      const v = ((mm && (mm[2] ?? mm[3] ?? mm[4])) || '').trim();
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
    .replace(/<p>(?:<br\/?>|\s)*<\/p>/gi, '')
    .replace(/<p>&#160;<\/p>/gi, '')
    .trim();

  if (s && !s.startsWith('<')) s = '<p>' + s;

  // 小标题升级为块级标题标签：部分阅读器会丢掉行内 <strong>，但标题标签一定按粗体渲染
  s = s.replace(/<p>\s*<strong>([^<]{1,80})<\/strong>([\s\S]*?)<\/p>/g, (m, strongText, rest) => {
    const t = strongText.trim();
    const body = rest.trim();
    if (isSectionHeading(t)) return body ? `<h4>${t}</h4><p>${body}</p>` : `<h4>${t}</h4>`;
    if (!body) return `<h3>${t}</h3>`;
    return m;
  });

  return stripInvisible(s);
}

/** 把 HTML 里的相对链接/图片地址补成绝对地址（阅读器无法解析相对路径） */
export function absolutizeUrls(html, origin) {
  return String(html ?? '').replace(/\s(href|src)="([^"]*)"/gi, (m, attr, url) => {
    const u = url.trim();
    if (!u || /^(?:https?:|mailto:|data:|#|\/\/)/i.test(u)) {
      if (u.startsWith('//')) return ` ${attr}="https:${u}"`;
      return m;
    }
    const abs = origin + (u.startsWith('/') ? '' : '/') + u;
    return ` ${attr}="${abs}"`;
  });
}

/** 纯文本长度（用于截断判断） */
export const textLength = (html) =>
  decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().length;

/** 超出字数上限时，按 </p> 边界截断并补省略号 */
export function truncateHtml(html, max) {
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

/* ---------------- 缓存 ---------------- */
export function loadContentCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c === 'object') return c;
  } catch {
    /* 首次运行 */
  }
  return {};
}

export function saveContentCache(file, cache) {
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[warn] 正文缓存写入失败：${e.message}`);
  }
}

/** 只保留当前条目用到的缓存，避免文件无限增长 */
export function pruneCache(cache, keepUrls) {
  const keep = new Set(keepUrls);
  let dropped = 0;
  for (const k of Object.keys(cache)) {
    if (!keep.has(k)) {
      delete cache[k];
      dropped++;
    }
  }
  return dropped;
}

/**
 * 除构建时间外内容没变就不重写文件，返回 true 表示“无变化”。
 * 只去掉频道级（第一条 <item> 之前）的 <lastBuildDate> 与 <pubDate>：
 * 否则频道没有 <pubDate> 时会误吃第一条 item 的 pubDate，
 * 条目 pubDate 变了也会被判成“无变化”，文件永远不重写。
 */
export function unchangedFile(file, xml) {
  const signature = (s) => {
    const cut = s.indexOf('<item>');
    const head = cut === -1 ? s : s.slice(0, cut);
    const items = cut === -1 ? '' : s.slice(cut);
    return (
      head.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '').replace(/<pubDate>[^<]*<\/pubDate>/, '') + items
    );
  };
  try {
    return signature(fs.readFileSync(file, 'utf8')) === signature(xml);
  } catch {
    return false;
  }
}

/* ---------------- 历史条目保留 ---------------- */
/** 读取上一次输出里的 item 原始片段 */
export function loadHistoryItems(file) {
  try {
    const xml = fs.readFileSync(file, 'utf8');
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
      raw: m[1].trim(),
      link: (m[1].match(/<link>([^<]*)<\/link>/) || [])[1] || '',
      guid: (m[1].match(/<guid[^>]*>([^<]*)<\/guid>/) || [])[1] || '',
    }));
  } catch {
    return [];
  }
}

/**
 * 把「本次抓到的条目」与「上次输出里的旧条目」合并：
 * 新条目在前，旧条目按原顺序接在后面，重复的丢弃，总数不超过 maxItems。
 * 这样列表页只有当天内容时（新闻首页、投稿前 30 条等）订阅里仍能保留历史。
 */
export function mergeHistoryIntoXml(xml, outFile, { maxItems = 300 } = {}) {
  const oldItems = loadHistoryItems(outFile);
  if (!oldItems.length) return xml;

  const blocks = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
  if (!blocks.length) return xml;

  const merged = blocks.map((m) => m[0]);
  const seen = new Set(
    merged.map((b) => (b.match(/<link>([^<]*)<\/link>/) || [])[1] || '').filter(Boolean)
  );

  for (const old of oldItems) {
    if (maxItems > 0 && merged.length >= maxItems) break;
    const key = old.link || old.guid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push('    <item>\n      ' + old.raw.replace(/\n\s*/g, '\n      ') + '\n    </item>');
  }

  if (merged.length === blocks.length) return xml;

  const head = xml.slice(0, blocks[0].index);
  const last = blocks[blocks.length - 1];
  const tail = xml.slice(last.index + last[0].length);
  return head + merged.join('\n') + tail;
}

/* ---------------- RSS 公共片段 ---------------- */
/**
 * 生成各源逐字节相同的频道头（<channel> 到 <ttl>/atom:link 为止，不含结尾换行）。
 * buildDate → <lastBuildDate>，pubDate → 频道级 <pubDate>（默认与 buildDate 相同）。
 */
export function rssChannel({
  title,
  link,
  description = title,
  generator = 'rss 1.0.0',
  selfUrl = null,
  buildDate = new Date(),
  pubDate = buildDate,
}) {
  return `  <channel>
    <title>${esc(title)}</title>
    <link>${esc(link)}</link>
    <description>${esc(description)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>
    <pubDate>${pubDate.toUTCString()}</pubDate>
    <generator>${esc(generator)}</generator>
    <ttl>60</ttl>${selfUrl ? `\n    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />` : ''}`;
}

/**
 * 条目的 GUID 取值与属性。
 * vPrefix=false → `<link>#<v>`（gen-c/d/e），true → `<link>#v<v>`（gen-f/g/i）。
 * 各源原有前缀必须保持：GUID 变了阅读器会把条目当新条目重新推送。
 */
export function guidFields(link, guidVersion, { vPrefix = false } = {}) {
  return {
    value: guidVersion ? `${link}#${vPrefix ? 'v' : ''}${guidVersion}` : link,
    attr: guidVersion ? ' isPermaLink="false"' : ' isPermaLink="true"',
  };
}

/**
 * 合并历史条目 → 无变化跳过 → 落盘。返回 { changed, xml }（xml 是合并后的内容）。
 * 把原先散在 gen-a/c/d/e/f/g/i 里的同一段尾部逻辑收到一处。
 */
export function writeFeedOutput(out, xml, { history = true, maxItems = 300, force = false } = {}) {
  const merged = history ? mergeHistoryIntoXml(xml, out, { maxItems }) : xml;
  if (!force && unchangedFile(out, merged)) return { changed: false, xml: merged };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, merged, 'utf8');
  return { changed: true, xml: merged };
}
