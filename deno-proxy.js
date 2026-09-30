/**
 * SUYU 漫画代理 —— Deno Deploy 版本
 * ------------------------------------------------------------------
 * 与 cf-proxy-worker.js 功能完全一致，只是换了个托管平台。
 *
 * 用法：
 *   取页面/接口：https://<你的域名>/?url=<encodeURIComponent(目标完整URL)>
 *   取图片：    https://<你的域名>/?img=1&url=<encodeURIComponent(目标完整URL)>
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
  'kanman.com',
  'kanmanimg.com',
  'dmzj.com',
  // 小说源（备用）
  'zongheng.com',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 图片缓存时间（秒）
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

Deno.serve(async (request) => {
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
    return textResponse('该域名不在允许列表中：' + target.hostname + '（可在 ALLOWED_HOSTS 里添加）', 403);
  }

  const headers = new Headers({
    'User-Agent': UA,
    'Accept': isImage
      ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // 不少漫画站开了防盗链，带上同源 Referer，避免图片 403
    'Referer': target.origin + '/',
  });

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: headers,
      redirect: 'follow',
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

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});