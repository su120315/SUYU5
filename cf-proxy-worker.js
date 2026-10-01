/**
 * SUYU 漫画代理 —— Cloudflare Worker
 * ------------------------------------------------------------------
 * 作用：替代随时会失效的公共 CORS 代理，给自己的漫画页提供一个稳定、专有的代理。
 * 免费额度：每天 10 万次请求，个人站完全够用。
 *
 * 用法（部署后你的 Worker 域名就是代理地址）：
 *   取页面/接口：https://<你的域名>/?url=<encodeURIComponent(目标完整URL)>
 *   取图片：    https://<你的域名>/?img=1&url=<encodeURIComponent(目标完整URL)>
 *
 * 安全设计：
 *   - 不带 img=1 时，只允许下面 ALLOWED_HOSTS 里列出的站点（避免变成人人可用的公开代理）；
 *   - 带 img=1 时允许任意域名，但只放行 Content-Type 为 image/* 的响应，不能拿来抓网页/接口。
 */

// 允许代理的站点，按域名后缀匹配（子域名自动包含）。需要新增时在数组里加一条即可。
const ALLOWED_HOSTS = [
  // 漫画源
  'bzmgcn.com',
  'baozimh.com',
  'copymanga.site',
  'copymanga.com',
  'mangacopy.com',
  'manhuagui.com',
  'mhgui.com',
  'hamrealm.com',
  'kanman.com',
  'kanmanimg.com',
  'dmzj.com',
  // 备选漫画源
  'manhuadb.com',
  'dm5.com',
  'mangabz.com',
  'gufengmh.com',
  '1kkk.com',
  'colamanga.com',
  'manga2020.com',
  'manhuaren.com',
  // 漫蛙系（manwamh5 镜像 + manwa2 备用）
  'manwamh5.com',
  'manwamh.com',
  'manwa2.com',
  // 小众漫画站（收录了不少国内已下架的作品）
  'mangakatana.com',
  // 小说源（备用）
  'zongheng.com',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 防盗链还原：不同漫画站的图片 CDN 要求的 Referer 不一样（例如漫画柜的 hamreus.com 必须带 manhuagui Referer，否则 403）
const REFERER_MAP = [
  ['hamreus.com', 'https://www.manhuagui.com/'],
  ['mhgui.com', 'https://www.manhuagui.com/'],
  ['manhuagui.com', 'https://www.manhuagui.com/'],
  // 漫蛙系：图片 CDN 只认漫蛙 Referer
  ['mhpic.net', 'https://www.manwamh5.com/'],
  ['baipiaoguai.org', 'https://manwa2.com/'],
  ['manwamh5.com', 'https://www.manwamh5.com/'],
  ['manwamh.com', 'https://www.manwamh5.com/'],
  ['manwa2.com', 'https://manwa2.com/'],
  ['kanmanimg.com', 'https://www.kanman.com/'],
  ['kanman.com', 'https://www.kanman.com/'],
  ['bzmgcn.com', 'https://cn.bzmgcn.com/'],
  ['baozimh.com', 'https://www.baozimh.com/'],
  ['copymanga.site', 'https://www.copymanga.site/'],
  ['mangacopy.com', 'https://www.mangacopy.com/'],
  ['dmzj.com', 'https://www.dmzj.com/'],
  ['manhuadb.com', 'https://www.manhuadb.com/'],
  ['dm5.com', 'https://www.dm5.com/'],
  ['mangabz.com', 'https://www.mangabz.com/'],
  ['1kkk.com', 'https://www.1kkk.com/'],
  ['gufengmh.com', 'https://www.gufengmh.com/'],
  ['manhuaren.com', 'https://www.manhuaren.com/'],
  ['colamanga.com', 'https://www.colamanga.com/'],
  // Katana 小站：图片走 i1.mangakatana.com，带上本站 Referer 更稳
  ['mangakatana.com', 'https://mangakatana.com/'],
];

// 给目标地址挑一个能过防盗链的 Referer
function pickReferer(hostname) {
  const host = hostname.toLowerCase();
  for (const [suffix, referer] of REFERER_MAP) {
    if (host === suffix || host.endsWith('.' + suffix)) return referer;
  }
  return 'https://' + host + '/';
}

// 图片缓存时间（秒），漫画图片不会变，缓存久一点省流量、加载更快
const IMAGE_CACHE_SECONDS = 604800;

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  }, extra || {});
}

function textResponse(message, status) {
  return new Response(message, {
    status: status || 400,
    headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some(function (suffix) {
    const s = suffix.toLowerCase();
    return host === s || host.endsWith('.' + s);
  });
}

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    // 跨域预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse('只支持 GET / HEAD', 405);
    }

    const rawTarget = reqUrl.searchParams.get('url');
    if (!rawTarget) {
      return textResponse('SUYU 漫画代理已就绪。用法：?url=<encodeURIComponent(目标URL)>，图片加 &img=1', 200);
    }

    let target;
    try {
      target = new URL(/^https?:\/\//i.test(rawTarget) ? rawTarget : 'https://' + rawTarget);
    } catch (e) {
      return textResponse('目标地址无效', 400);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return textResponse('只支持 http / https', 400);
    }

    const isImage = reqUrl.searchParams.get('img') === '1';

    if (!isImage && !hostAllowed(target.hostname)) {
      return textResponse('该域名不在允许列表中：' + target.hostname + '（可在 Worker 的 ALLOWED_HOSTS 里添加）', 403);
    }

    const headers = new Headers({
      'User-Agent': UA,
      'Accept': isImage
        ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      // 不少漫画站开了防盗链：带上该站要求的 Referer（如图片 CDN 需要原站 Referer），避免 403
      'Referer': pickReferer(target.hostname),
      // 补齐浏览器指纹类请求头，提高过反爬的成功率
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': isImage ? 'image' : 'document',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    });

    let upstream;
    try {
      // 透传浏览器带回的 Cookie，让需要会话校验的站点能正常返回真实内容
      const incomingCookie = request.headers.get('Cookie');
      if (incomingCookie) headers.set('Cookie', incomingCookie);

      upstream = await fetch(target.toString(), {
        method: request.method,
        headers: headers,
        redirect: 'follow',
        cf: isImage ? { cacheEverything: true, cacheTtl: IMAGE_CACHE_SECONDS } : undefined,
      });
    } catch (e) {
      return textResponse('上游请求失败：' + e.message, 502);
    }

    const contentType = upstream.headers.get('Content-Type') || '';

    // 图片模式只放行真正的图片，防止被当作任意内容的开放代理
    if (isImage && !/^image\//i.test(contentType)) {
      return textResponse('目标不是图片（Content-Type: ' + contentType + '）', 403);
    }

    const outHeaders = new Headers(corsHeaders({
      'Content-Type': contentType || (isImage ? 'application/octet-stream' : 'text/html; charset=utf-8'),
    }));
    if (isImage) {
      outHeaders.set('Cache-Control', 'public, max-age=' + IMAGE_CACHE_SECONDS + ', immutable');
    }

    // 把上游的 Set-Cookie 回传给浏览器（去掉 Domain，否则浏览器会因域名不匹配而丢弃）
    try {
      const raw = typeof upstream.headers.getSetCookie === 'function'
        ? upstream.headers.getSetCookie()
        : (upstream.headers.get('Set-Cookie') ? [upstream.headers.get('Set-Cookie')] : []);
      for (const sc of raw) {
        outHeaders.append('Set-Cookie', String(sc).replace(/;\s*Domain=[^;]+/i, ''));
      }
    } catch (e) { /* 忽略 cookie 处理异常 */ }

    // HTML：注入 <base> 让页面内的相对资源回到原站加载，从而绕过那些"图片由 JS 动态加载"的站点。
    // 同时不复制 X-Frame-Options / CSP，允许漫画页把它以 iframe 嵌入。
    if (!isImage && /text\/html/i.test(contentType)) {
      let text = await upstream.text();
      if (!/<base\s/i.test(text)) {
        const baseHref = target.toString().replace(/"/g, '&quot;');
        text = /<head[^>]*>/i.test(text)
          ? text.replace(/<head([^>]*)>/i, '<head$1><base href="' + baseHref + '">')
          : '<base href="' + baseHref + '">' + text;
      }
      return new Response(text, { status: upstream.status, headers: outHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};