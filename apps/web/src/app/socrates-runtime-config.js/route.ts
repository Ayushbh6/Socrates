export const dynamic = "force-dynamic";

const escapeJsString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");

export function GET() {
  const apiBaseUrl =
    process.env.SOCRATES_API_BASE_URL ??
    process.env.NEXT_PUBLIC_SOCRATES_API_BASE_URL ??
    "http://127.0.0.1:4000";

  return new Response(`window.__SOCRATES_CONFIG__ = { apiBaseUrl: "${escapeJsString(apiBaseUrl)}" };\n`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
