// SPDX-License-Identifier: Apache-2.0
import { readCardDocument, validateContactId, validateLocator } from "./discovery.mjs";
import { publishPage } from "./publish-page.mjs";

const form = document.querySelector("#publish-form");
const result = document.querySelector("#publication");
const status = document.querySelector("#publish-status");
const text = document.querySelector("#public-text");
const submit = form.querySelector("button");
let html;
let edit = 0;

form.oninput = () => {
  edit++;
  html = undefined;
  result.hidden = true;
  text.value = "";
  status.textContent = "";
};

form.onsubmit = async event => {
  event.preventDefault();
  const generation = ++edit;
  submit.disabled = true;
  result.hidden = true;
  html = undefined;
  status.textContent = "Checking the signed contact…";
  try {
    const [locator, id, extra] = document.querySelector("#my-card").value.trim().split("#");
    if (extra !== undefined) throw Error();
    validateContactId(id);
    const page = validateLocator(document.querySelector("#my-page").value.trim());
    const label = document.querySelector("#public-name").value.trim();
    const pin = localStorage.getItem("findmestill/discovery-v0.1/" + id) ?? undefined;
    const publication = await publishPage(page, id, await readCardDocument(locator), label, undefined, pin);
    if (generation !== edit) return;
    html = publication.html;
    text.value = publication.text;
    result.hidden = false;
    status.textContent = "Ready to publish on your website.";
  } catch {
    if (generation === edit) status.textContent = "Check your signed card link and public page URL. The page needs a separate address from the signed card.";
  } finally { submit.disabled = false; }
};
text.onfocus = () => text.select();
document.querySelector("#download-page").onclick = () => {
  if (!html) return;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "fms.html";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
