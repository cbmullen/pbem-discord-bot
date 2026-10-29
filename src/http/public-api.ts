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
): Response {
  return Response.json(payload, { status, headers: CORS_HEADERS });
}

export function publicOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function methodNotAllowedResponse(): Response {
  return publicJsonResponse({ error: "Method not allowed." }, 405);
}
