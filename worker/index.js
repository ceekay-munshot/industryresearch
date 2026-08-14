/**
 * Industry Research Dashboard — Cloudflare Worker
 *
 * Responsibilities (kept intentionally tiny for this scaffold):
 *   1. Serve the static site in ./public via the ASSETS binding.
 *   2. Reserve a single stub route: POST /api/chat.
 *
 * The chat route is a placeholder — real chat is wired in a later step.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Reserved API route: chat stub ---------------------------------
    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { ...JSON_HEADERS, Allow: 'POST' },
        });
      }
      return new Response(JSON.stringify({ reply: 'Chat is wired in a later step.' }), {
        headers: JSON_HEADERS,
      });
    }

    // --- Everything else: static assets --------------------------------
    return env.ASSETS.fetch(request);
  },
};
