const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  Vary: "Origin",
};

export function publicJsonResponse(
  payload: unknown,
  status = 200,
  additionalHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(CORS_HEADERS);
  new Headers(additionalHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(payload, {
    status,
    headers,
  });
}

export function publicOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function methodNotAllowedResponse(): Response {
  return publicJsonResponse({ error: "Method not allowed." }, 405);
}
