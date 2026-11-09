// 把告警送到人眼前。只做一件事：HTTP POST。没有 webhook 就只留在本地事件表里。
// 认三种收件方：ntfy（手机推送）、飞书/钉钉机器人、通用 JSON。

export type NotifyKind = "ntfy" | "feishu" | "dingtalk" | "json";

export type NotifyResult = { ok: boolean; detail: string };

export function webhookKind(url: string): NotifyKind {
  const host = safeHost(url);
  if (host === "ntfy.sh" || host.endsWith(".ntfy.sh") || url.startsWith("ntfys://")) return "ntfy";
  if (host.includes("feishu.cn") || host.includes("larksuite.com")) return "feishu";
  if (host.includes("dingtalk.com")) return "dingtalk";
  return "json";
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 收件方要什么就发什么；发不出去也不抛，返回原因给人看。 */
export async function postWebhook(
  url: string,
  title: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const kind = webhookKind(url);
  let body: string;
  const headers: Record<string, string> = {};
  switch (kind) {
    case "ntfy":
      // ntfy 的 Title 头只收 ASCII，中文标题会丢；正文进 body 最稳。
      body = text;
      headers["Title"] = "gpulease";
      headers["Tags"] = "warning";
      break;
    case "feishu":
      body = JSON.stringify({ msg_type: "text", content: { text: `${title}\n${text}` } });
      headers["Content-Type"] = "application/json";
      break;
    case "dingtalk":
      body = JSON.stringify({ msgtype: "text", text: { content: `${title}\n${text}` } });
      headers["Content-Type"] = "application/json";
      break;
    default:
      body = JSON.stringify({ title, text });
      headers["Content-Type"] = "application/json";
      break;
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const raw = (await res.text()).trim();
    // 飞书/钉钉会在 200 里塞错误码，不能只看状态码。
    if (kind === "feishu" || kind === "dingtalk") {
      try {
        const parsed = JSON.parse(raw) as { code?: number; StatusCode?: number; errcode?: number };
        const code = parsed.code ?? parsed.StatusCode ?? parsed.errcode;
        if (typeof code === "number" && code !== 0) return { ok: false, detail: `返回码 ${code}` };
      } catch {
        // 不是 JSON 就当成功，别把正常收件当失败。
      }
    }
    return { ok: true, detail: kind };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: reason.slice(0, 120) };
  }
}
