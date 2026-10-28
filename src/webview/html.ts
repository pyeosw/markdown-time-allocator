/** Escapes a value for an HTML attribute without trusting callers' URI encoding. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Creates a static shell shared by the panel and DOM behavior tests. */
export function webviewHtml(
  cspSource: string,
  scriptUri: string,
  styleUri: string,
  nonce: string
): string {
  const script = escapeAttribute(scriptUri);
  const style = escapeAttribute(styleUri);
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(cspSource)}; script-src 'nonce-${escapeAttribute(nonce)}';">
    <link rel="stylesheet" href="${style}"><title>作業時間の配分</title></head>
    <body><main><p class="eyebrow">TIME CALCULATOR</p><h1>作業時間の配分</h1>
    <p id="target"></p><label class="mode">勤務区分 <select id="mode"><option value="normal">通常</option><option value="amLeave">AM休暇</option></select></label>
    <p id="schedule"></p><div id="summary" class="summary"></div><p id="rounding" class="muted"></p>
    <div id="errors" role="alert"></div><section id="items" aria-label="作業項目"></section>
    <div class="other"><span>その他 <small>残時間を自動配分</small></span><strong id="other">—</strong></div>
    <div class="actions"><button id="apply" disabled>適用</button><button id="reload" class="secondary">再読込</button><button id="close" class="secondary">閉じる</button></div>
    <p id="feedback" role="status" aria-live="polite"></p><p class="muted">適用でMarkdownを更新します。保存はVSCodeの設定に従います。</p>
    </main><script nonce="${escapeAttribute(nonce)}" src="${script}"></script></body></html>`;
}
