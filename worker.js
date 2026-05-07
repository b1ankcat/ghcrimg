/**
 * Cloudflare Worker — ghcr.io Pull-Through Proxy
 *
 * Copy this single file → `npx wrangler deploy` → done.
 * docker pull <your-worker-domain>/owner/image:tag
 */

const UPSTREAM = 'https://ghcr.io';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_MAP = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept,user-agent,range',
  'access-control-expose-headers':
    'www-authenticate,content-type,content-length,content-range,' +
    'docker-content-digest,docker-distribution-api-version,location,' +
    'accept-ranges,oci-distribution-api-version',
  'access-control-max-age': '86400',
};

function withCORS(headers) {
  for (const [k, v] of Object.entries(CORS_MAP)) headers.set(k, v);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(status, obj) {
  const h = new Headers({ 'content-type': 'application/json' });
  withCORS(h);
  return new Response(JSON.stringify(obj, null, 2), { status, headers: h });
}

/** cf- headers we don't want leaking to Docker clients */
function isCFHeader(name) {
  return name.startsWith('cf-') || name === 'server' ||
    name === 'set-cookie' || name === 'strict-transport-security' ||
    name === 'x-github-request-id';
}

/**
 * Build a new Response from upstream — fresh mutable Headers copy.
 * This is necessary because `fetch()` responses have IMMUTABLE headers.
 */
function buildProxyResponse(upstream, host) {
  const headers = new Headers();

  // Copy only non-CF headers from upstream
  for (const [k, v] of upstream.headers) {
    if (!isCFHeader(k)) headers.set(k, v);
  }

  // Rewrite ghcr.io token realm → this worker
  const wwwAuth = headers.get('www-authenticate');
  if (wwwAuth) {
    headers.set('www-authenticate', wwwAuth.replace(
      /realm="https?:\/\/ghcr\.io\/token"/,
      `realm="https://${host}/token"`,
    ));
  }

  withCORS(headers);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

/**
 * Headers worth forwarding from the Docker client to ghcr.io:
 *   Authorization — Bearer token after auth flow
 *   Accept        — manifest content-type negotiation
 *   Range         — parallel blob download + resume
 */
function upstreamHeaders(incoming) {
  const h = new Headers();
  for (const name of ['authorization', 'accept', 'range']) {
    const v = incoming.get(name);
    if (v) h.set(name, v);
  }
  h.set('user-agent', 'ghcr-proxy-cf-worker');
  return h;
}

async function fetchUpstream(pathWithQuery, initHeaders, method) {
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
    try {
      const resp = await fetch(new Request(new URL(pathWithQuery, UPSTREAM), {
        method: method || 'GET',
        headers: initHeaders,
        redirect: 'follow',
      }));
      if (resp.ok || resp.status < 500) {
        return { ok: true, response: resp };
      }
      const snippet = await resp.text().catch(() => '');
      lastErr = new Error(`upstream ${resp.status}: ${snippet.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleToken(url, host, authHeader) {
  const h = new Headers();
  if (authHeader) h.set('authorization', authHeader);

  const { ok, response, error } = await fetchUpstream(
    `/token?${url.searchParams.toString()}`, h, 'GET',
  );

  if (!ok) {
    return json(502, {
      errors: [{ code: 'TOKEN_ERROR', message: `ghcr token unreachable: ${error.message}` }],
    });
  }

  return buildProxyResponse(response, host);
}

async function handleRegistry(request, url, host) {
  const { ok, response, error } = await fetchUpstream(
    url.pathname + url.search,
    upstreamHeaders(request.headers),
    request.method,
  );

  if (!ok) {
    throw new Error(`ghcr.io unreachable (${request.method} ${url.pathname}): ${error?.message || 'unknown'}`);
  }

  return buildProxyResponse(response, host);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function handleDebugProxy(url) {
  const path = url.searchParams.get('path');
  const results = { path, steps: [] };

  const fakeHeaders = new Headers({
    'accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
  });
  const built = upstreamHeaders(fakeHeaders);
  results.steps.push({ step: 'headers-built', ok: true, headers: Object.fromEntries(built) });

  const t0 = Date.now();
  try {
    const { ok, response, error } = await fetchUpstream(path, built, 'HEAD');
    if (!ok) {
      results.steps.push({ step: 'fetchUpstream', ok: false, error: error?.message });
    } else {
      results.steps.push({
        step: 'fetchUpstream', ok: true, durationMs: Date.now() - t0,
        upstreamStatus: response.status,
      });
      const proxyResp = buildProxyResponse(response, url.hostname);
      results.steps.push({
        step: 'buildProxyResponse', ok: true,
        finalStatus: proxyResp.status,
        finalHeaders: {
          'www-authenticate': proxyResp.headers.get('www-authenticate') || '',
          'access-control-allow-origin': proxyResp.headers.get('access-control-allow-origin') || '',
        },
      });
    }
  } catch (e) {
    results.steps.push({ step: 'fetchUpstream', ok: false, error: e.message });
  }

  return json(200, results);
}

async function handleDebug(url) {
  const target = url.searchParams.get('target') || '/v2/';
  const t = [];
  const t0 = Date.now();
  try {
    const r = await fetch(`https://ghcr.io${target}`, {
      method: 'GET', redirect: 'follow', headers: { 'accept': 'application/json' },
    });
    t.push({ label: `GET ${target}`, ok: true, durationMs: Date.now() - t0, status: r.status });
  } catch (e) {
    t.push({ label: `GET ${target}`, ok: false, durationMs: Date.now() - t0, error: e.message });
  }
  return json(200, { tests: t });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const host = url.hostname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_MAP });
    }

    try {
      if (path === '/debug-proxy') return await handleDebugProxy(url);
      if (path === '/debug')      return await handleDebug(url);

      if (path === '/token') {
        const auth = request.headers.get('authorization');
        return await handleToken(url, host, auth);
      }

      if (path.startsWith('/v2/') || path === '/v2') {
        return await handleRegistry(request, url, host);
      }

      return json(200, {
        service: 'ghcr.io pull-through proxy',
        status: 'ok',
        upstream: 'ghcr.io',
        usage: `docker pull ${host}/owner/image:tag`,
      });
    } catch (err) {
      return json(502, {
        errors: [{ code: 'UNKNOWN', message: err.message }],
      });
    }
  },
};
