const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];
// 各音频源的 Referer 映射，用于绕过上游防盗链
const REFERER_MAP: Record<string, string> = {
  "kuwo.cn": "https://www.kuwo.cn/",
  "music.126.net": "https://music.126.com/",
};

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function resolveReferer(hostname: string): string | undefined {
  const lower = hostname.toLowerCase();
  for (const [host, referer] of Object.entries(REFERER_MAP)) {
    if (lower === host || lower.endsWith("." + host)) {
      return referer;
    }
  }
  return undefined;
}

function normalizeAudioTarget(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function proxyAudioTarget(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeAudioTarget(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
    },
  };

  const referer = resolveReferer(normalized.hostname);
  if (referer) {
    (init.headers as Record<string, string>)["Referer"] = referer;
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;
  
  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache，以便重试成功后能更新同一个缓存项）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  
  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  // 如果是 GET 请求且未指定 nocache 强制刷新，尝试命中缓存
  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  // 判断是否应该缓存：必须是 200 状态，且内容不能是空数组或包含错误标识，且未指定强制刷新
  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');
  
  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  
  // 如果是搜索请求且结果为空，通常是 API 繁忙或异常，不建议长缓存
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  // 写入缓存（不阻塞主流程）
  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

// ===== Meting 标准格式适配层 =====
// 用于接入 api.qijieya.cn 等标准 Meting 实例：把 GD 格式请求翻译为 Meting 参数，
// 再把 Meting 返回（含 302 重定向、纯文本歌词、扁平数组）转回前端期望的 GD 结构。
const METING_TYPE_MAP: Record<string, string> = {
  search: "search",
  url: "url",
  lyric: "lrc",
  pic: "pic",
  playlist: "playlist",
};

function extractMetingId(rawUrl: string): string {
  try {
    return new URL(rawUrl, "https://meting.local/").searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

async function proxyMetingApi(url: URL, request: Request, apiBaseUrl: string): Promise<Response> {
  const types = (url.searchParams.get("types") || "").toLowerCase();
  const source = url.searchParams.get("source") || "netease";
  const metingType = METING_TYPE_MAP[types];

  if (!metingType) {
    return jsonResponse({ error: "unsupported types" }, 400);
  }

  const apiUrl = new URL(apiBaseUrl);
  apiUrl.searchParams.set("server", source);
  apiUrl.searchParams.set("type", metingType);

  if (types === "search") {
    apiUrl.searchParams.set("id", url.searchParams.get("name") || "");
    const limit = url.searchParams.get("count");
    if (limit) apiUrl.searchParams.set("limit", limit);
    const page = url.searchParams.get("pages");
    if (page) apiUrl.searchParams.set("page", page);
  } else {
    apiUrl.searchParams.set("id", url.searchParams.get("id") || "");
  }

  // url / pic：Meting 返回 302，需手动读取 Location 转成 JSON 交给前端
  if (types === "url" || types === "pic") {
    const upstream = await fetch(apiUrl.toString(), {
      method: request.method,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" },
    });
    const location = upstream.headers.get("Location") || "";
    if (!location) {
      return jsonResponse({ error: "no location" }, 502);
    }
    if (types === "pic") {
      return jsonResponse({ url: location, from: "meting" });
    }
    return jsonResponse({
      url: location,
      br: Number(url.searchParams.get("br") || 320) || 320,
      size: 0,
      from: "meting",
    });
  }

  const upstream = await fetch(apiUrl.toString(), {
    method: request.method,
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" },
  });
  const text = await upstream.text();

  if (types === "lyric") {
    return jsonResponse({ lyric: text });
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "invalid upstream json" }, 502);
  }

  if (types === "search") {
    const list = Array.isArray(data) ? data : [];
    return jsonResponse(list.map((item: any) => ({
      id: extractMetingId(item.url),
      name: item.name || "",
      artist: item.artist || "",
      album: "",
      pic_id: extractMetingId(item.pic),
      url_id: extractMetingId(item.url),
      lyric_id: extractMetingId(item.lrc),
      source,
    })));
  }

  if (types === "playlist") {
    const list = Array.isArray(data) ? data : [];
    const tracks = list.map((item: any) => {
      const trackId = extractMetingId(item.url);
      const picId = extractMetingId(item.pic);
      return {
        id: /^\d+$/.test(trackId) ? Number(trackId) : trackId,
        name: item.name || "",
        ar: [{ name: item.artist || "未知艺术家" }],
        al: { name: "", picUrl: item.pic || "", pic: picId, pic_str: picId },
        lyric_id: extractMetingId(item.lrc),
        url_id: trackId,
        source,
      };
    });
    return jsonResponse({ playlist: { tracks } });
  }

  return jsonResponse(data);
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  // 优先使用环境变量中配置的 API 地址，CF 部署未设置时 fallback 到默认节点
  const apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyAudioTarget(target, request);
  }

  // API_FORMAT=meting 时启用标准 Meting 适配层（配合 API_BASE_URL 指向 qijieya 等实例）
  const apiFormat = (typeof env?.API_FORMAT === "string" && env.API_FORMAT) ? env.API_FORMAT.toLowerCase() : "";
  if (apiFormat === "meting") {
    return proxyMetingApi(url, request, apiBaseUrl);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
