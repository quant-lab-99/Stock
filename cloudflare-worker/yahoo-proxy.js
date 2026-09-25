/**
 * Cloudflare Worker — Yahoo Finance 차트 API 전용 CORS 프록시
 *
 * 배포: Cloudflare 대시보드 → Workers & Pages → my-yahoo-proxy → Edit code
 *       → 이 파일 내용을 전부 붙여넣고 Deploy
 * 호출: https://<워커주소>/?url=<encodeURIComponent(Yahoo 차트 API URL)>
 *
 * 보안: 허용된 출처(ALLOWED_ORIGINS)에서만 응답하고, Yahoo 차트 API 이외의 주소는 거절(오픈 프록시 악용 방지)
 */
const ALLOWED_ORIGINS = [
  'https://quant-lab-99.github.io',
  'http://localhost:8000',
  'http://localhost:8765',
  'http://127.0.0.1:8000'
];
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const ALLOWED_PATH = /^\/v8\/finance\/chart\/[^/]+$/;
const CACHE_SECONDS = 1800; // 30분 캐시 (Yahoo 요청 수 절감)

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function reply(status, body, origin, extra = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...extra };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

    if (request.method === 'OPTIONS') {
      return allowedOrigin ? new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) }) : new Response(null, { status: 403 });
    }
    if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, allowedOrigin);
    // 브라우저 요청은 Origin 이 붙으므로, 허용 목록 밖의 사이트에서 오는 요청은 거절
    if (origin && !allowedOrigin) return reply(403, { error: 'origin_not_allowed' }, null);

    const target = new URL(request.url).searchParams.get('url');
    let upstream;
    try { upstream = new URL(target || ''); } catch { return reply(400, { error: 'bad_url' }, allowedOrigin); }
    if (upstream.protocol !== 'https:' || !ALLOWED_HOSTS.includes(upstream.hostname) || !ALLOWED_PATH.test(upstream.pathname)) {
      return reply(403, { error: 'target_not_allowed' }, allowedOrigin);
    }

    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const up = await fetch(upstream.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; quant-lab-proxy/1.0)', 'Accept': 'application/json' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
      });
      const body = await up.text();
      res = new Response(body, {
        status: up.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
      });
      if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    if (allowedOrigin) Object.entries(corsHeaders(allowedOrigin)).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  }
};
