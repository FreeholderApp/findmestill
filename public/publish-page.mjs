// SPDX-License-Identifier: Apache-2.0
import { selectCard, validateLocator } from "./discovery.mjs";

const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export async function publishPage(pageUrl, id, document, label = "FindMeStill contact", now, pin) {
  validateLocator(pageUrl);
  if (typeof label !== "string" || !label.trim() || label.length > 120 || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(label)) throw Error("Use a short public display name");
  const card = await selectCard(id, [document], { now, pin });
  if (document.at(-1) !== card.jws) throw Error("A current signed history is required");
  if ([card.primary, ...card.backups].includes(pageUrl)) throw Error("Give the public HTML page and signed JSON distinct URLs");
  const title = escape(label.trim());
  const link = escape(card.primary + "#" + id);
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · FindMeStill · ${id}</title>
<link rel="canonical" href="${escape(pageUrl)}">
<link rel="alternate" type="application/json" href="${escape(card.primary)}">
<style>
body { margin: 2rem auto; max-width: 40rem; padding: 0 1rem; font: 1.1rem/1.6 system-ui,sans-serif; overflow-wrap: anywhere; }
</style>
</head><body><main>
<h1>${title}</h1>
<p>My FindMeStill contact ID is <code>${id}</code>.</p>
<p>Copy this contact link into your FindMeStill verifier to check the signed address.</p>
<p><a href="${link}">${link}</a></p>
<p>Signed revision ${card.revision}. This page lists a publicly shared contact address.</p>
</main></body></html>\n`;
  const text = [label.trim(), "FindMeStill ID: " + id, "Signed contact link: " + card.primary + "#" + id].join("\n");
  return { html, text };
}
