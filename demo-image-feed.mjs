#!/usr/bin/env node
/**
 * demo-image-feed.mjs —— 图片型 RSS 的测试源（用于验证「阅读器能不能显示订阅里的图片」）
 *
 * 里面的图片全部来自可合法直链的公共图源：
 *   - picsum.photos ：Unsplash 授权照片，按 seed 稳定返回
 *   - placehold.co  ：纯色占位图（带文字，便于确认是哪一条）
 *   - 看漫画的漫画封面缩略图（站点自己的公开图，无防盗链，带链接指回章节页）
 *
 * 用法：node demo-image-feed.mjs [输出文件]     默认 demo-images.xml
 */

import fs from 'node:fs';

const OUT = process.argv[2] || 'demo-images.xml';
const SITE = 'https://www.manhuagui.com';
const COMIC = `${SITE}/comic/45638/`;
const COVER = 'https://cf.mhgui.com/cpic/h/45638_83.jpg';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s) => '<![CDATA[' + String(s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';

const items = [
  {
    title: '照片（picsum · Unsplash 授权）',
    img: 'https://picsum.photos/seed/manhuagui-1/800/1200',
    note: '随机真实照片，用来确认阅读器会加载并显示 feed 里的图片。',
    link: COMIC,
  },
  {
    title: '照片（picsum 第二张）',
    img: 'https://picsum.photos/seed/manhuagui-2/800/1200',
    note: '同一源的第二张，用来确认多张图能正常显示。',
    link: COMIC,
  },
  {
    title: '占位图（placehold.co，带文字）',
    img: 'https://placehold.co/800x1200/2b6cb0/ffffff.png?text=Page+3',
    note: '图上会印出 Page 3，方便你确认图文是否对应到同一条。',
    link: COMIC,
  },
  {
    title: '<enclosure> 形式（部分阅读器只在附件里取图）',
    img: 'https://picsum.photos/seed/manhuagui-4/800/1200',
    note: '这条同时用 <enclosure> 和正文 <img> 两种方式给图，看你的阅读器认哪一种。',
    link: COMIC,
    enclosure: true,
  },
  {
    title: '《我，当备胎女友就行了》封面（站点公开缩略图）',
    img: COVER,
    note: '这张是站点自己的封面图，实测无防盗链，可以直接在订阅里显示，点击跳回漫画页。',
    link: COMIC,
    enclosure: true,
  },
];

const now = new Date();
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>图片显示测试源</title>
    <link>${esc(COMIC)}</link>
    <description>用于验证 RSS 阅读器能否显示订阅中的图片：包含真实照片、带文字占位图和站点封面缩略图。</description>
    <language>zh-CN</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <generator>demo-image-feed</generator>
${items
  .map((it, i) => {
    const pub = new Date(now.getTime() - i * 3600_000).toUTCString();
    return `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.link)}</link>
      <guid isPermaLink="false">demo-image-${i + 1}</guid>
      <description>${cdata(
        `<p>${esc(it.note)}</p><p><a href="${esc(it.link)}"><img src="${esc(it.img)}" alt="${esc(it.title)}" /></a></p>`
      )}</description>
      ${it.enclosure ? `<enclosure url="${esc(it.img)}" type="image/jpeg" length="0" />` : ''}
      <pubDate>${pub}</pubDate>
    </item>`;
  })
  .join('\n')}
  </channel>
</rss>
`;

fs.writeFileSync(OUT, xml, 'utf8');
console.log(`[write] ${OUT}（${items.length} 条，均为可合法直链的图片）`);
