// SPDX-License-Identifier: Apache-2.0
import { checkContact, selectCard, validateContactId, validateLocator, verifyCard } from "./discovery.mjs";

import { exportBook, importBook, maxBookBytes } from "./contact-book.mjs";

const form = document.querySelector("#resolve");
const contact = document.querySelector("#contact");
const status = document.querySelector("#status");
const list = document.querySelector("#saved");
const demo = document.querySelector("#demo");
const connection = document.querySelector("#connection");
const install = document.querySelector("#install");
const scan = document.querySelector("#scan");
const qr = document.querySelector("#qr");
const submit = form.querySelector('button[type="submit"]');
const prefix = "findmestill/discovery-v0.1/";
let renderSequence = 0;
let refreshing = false;
let actionSequence = 0;
const errors = {
  conflicting_cards: "Conflicting signed routes were found. Your saved address was kept. Check with the contact before relying on it.",
  expired_card: "The latest signed record has expired. A current record is needed.",
  invalid_id: "Paste a contact link that ends with its full FindMeStill ID.",
  invalid_locator: "The contact link must use a canonical HTTPS address.",
  no_verified_card: "No signed record could be verified. Check the contact link and try again.",
  offline: "The saved record is available offline. Connect to check for a move.",
  unreadable_qr: "No FindMeStill contact link was found. Try another image or paste the link.",
  unsupported: "This browser cannot safely save a contact. Try an updated browser.",
};

async function act(button, run, busy = "Checking signatures…") {
  const sequence = ++actionSequence;
  button.disabled = true;
  status.textContent = busy;
  try {
    const message = await run();
    if (sequence === actionSequence) status.textContent = message;
  } catch (error) {
    if (sequence === actionSequence) status.textContent = errors[error.code] ?? "The verifier could not finish. Check the link or browser storage and try again.";
  } finally {
    button.disabled = false;
  }
}

async function saveContact(id, locator) {
  if (!navigator.onLine) throw Object.assign(new Error(), { code: "offline" });
  if (!navigator.locks) throw Object.assign(new Error(), { code: "unsupported" });
  return navigator.locks.request(prefix + id, async () => {
    const pin = localStorage.getItem(prefix + id) ?? undefined;
    const checked = await checkContact({ id, locator, pin });
    if (checked.card.jws !== pin) localStorage.setItem(prefix + id, checked.card.jws);
    return checked;
  });
}

async function verifyAndDisplay(id, locator) {
  const { card, confirmed } = await saveContact(id, locator);
  await render();
  if (!confirmed) return `Kept saved revision ${card.revision}. No host confirmed this revision. You can retry or paste a new introduction for this contact.`;
  return `Verified revision ${card.revision} at ${card.primary}`;
}

function savedIds() {
  return Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort().map(key => key.slice(prefix.length));
}

async function render() {
  const request = ++renderSequence;
  const items = [];
  for (const id of savedIds()) {
    let card;
    try {
      card = await verifyCard(localStorage.getItem(prefix + id), id);
    } catch {
      continue;
    }
    const item = document.createElement("li");
    const detail = document.createElement("p");
    detail.textContent = `${new URL(card.primary).host} · revision ${card.revision} · ${id}`;
    const expiry = document.createElement("p");
    const date = new Date(card.expiresAt * 1000);
    const expired = card.expiresAt <= Math.floor(Date.now() / 1000);
    expiry.textContent = expired ? "Signed record expired" : "Signed record expires";
    if (!Number.isNaN(date.getTime())) {
      const time = document.createElement("time");
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString();
      expiry.append(" ", time);
    }
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "secondary";
    refresh.textContent = "Check for a move";
    refresh.addEventListener("click", () => act(refresh, () => verifyAndDisplay(id)));
    refresh.disabled = !navigator.onLine;
    item.append(detail, expiry, refresh);
    if (!expired) {
      const share = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Share contact link";
      const field = document.createElement("input");
      field.readOnly = true;
      field.setAttribute("aria-label", "Contact link to share");
      field.value = card.primary + "#" + id;
      field.onfocus = () => field.select();
      share.append(summary, field);
      item.append(share);
    }
    const recovery = document.createElement("details");
    const heading = document.createElement("summary");
    heading.textContent = "Find this contact again";
    const hint = document.createElement("p");
    hint.textContent = "Choosing a search engine shares this public ID with it. Copy the contact link from a result, then verify it here.";
    const engines = document.createElement("div");
    engines.className = "actions";
    for (const [name, base] of [["Google", "https://www.google.com/search"], ["Bing", "https://www.bing.com/search"], ["DuckDuckGo", "https://duckduckgo.com/"]]) {
      const url = new URL(base);
      url.searchParams.set("q", '"' + id + '"');
      const link = document.createElement("a");
      link.textContent = name;
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      engines.append(link);
    }
    const recover = document.createElement("form");
    const label = document.createElement("label");
    label.textContent = "Candidate card link for this contact";
    const input = document.createElement("input");
    input.type = "url";
    input.required = true;
    input.maxLength = 817;
    label.append(input);
    const check = document.createElement("button");
    check.type = "submit";
    check.className = "secondary";
    check.textContent = "Verify new location";
    recover.append(label, check);
    recover.onsubmit = event => {
      event.preventDefault();
      act(check, async () => {
        const candidate = input.value.trim();
        const locator = validateLocator(candidate.split("#")[0]);
        if (candidate.includes("#") && contactLink(candidate).id !== id) return "This link names a different contact. Your saved contact was kept.";
        return verifyAndDisplay(id, locator);
      });
    };
    recovery.append(heading, hint, engines, recover);
    item.append(recovery);
    items.push(item);
  }
  if (request === renderSequence) list.replaceChildren(...items);
}

function contactLink(value) {
  const [locator, fragment, extra] = value.trim().split("#");
  const id = validateContactId(extra === undefined ? fragment : undefined);
  return { id, locator: validateLocator(locator) };
}

form.addEventListener("submit", event => {
  event.preventDefault();
  act(submit, () => {
    const { id, locator } = contactLink(contact.value);
    return verifyAndDisplay(id, locator);
  });
});

demo.addEventListener("click", () => act(demo, async () => {
  const response = await fetch("/fixtures/discovery-v0.1.json");
  if (!response.ok) throw new Error("Sample unavailable");
  const sample = await response.json();
  const initial = await selectCard(sample.contactId, [sample.initial], { now: sample.initialTime });
  const moved = await selectCard(sample.contactId, [sample.moved], { now: sample.movedTime, pin: initial.jws });
  return `Verified a sample move from ${new URL(initial.primary).host} to ${new URL(moved.primary).host}. The contact ID stayed the same.`;
}));

function syncConnection() {
  connection.hidden = navigator.onLine;
  render().catch(() => { status.textContent = "Browser storage is unavailable."; });
}

window.addEventListener("offline", syncConnection);
window.addEventListener("online", async () => {
  syncConnection();
  if (refreshing) return;
  refreshing = true;
  const sequence = actionSequence;
  try {
    let errors = 0;
    for (const id of savedIds()) {
      if (!navigator.onLine) break;
      try {
        if (!(await saveContact(id)).confirmed) errors += 1;
      } catch {
        errors += 1;
      }
    }
    await render();
    if (sequence === actionSequence && errors && navigator.onLine) status.textContent = "Some saved contacts need attention. Check for a move to see details.";
  } finally {
    refreshing = false;
  }
});
syncConnection();

if (location.hash.startsWith("#contact=")) {
  try {
    const value = decodeURIComponent(location.hash.slice(9));
    contactLink(value);
    contact.value = value;
    contact.focus();
  } catch {
    status.textContent = errors.invalid_id;
  }
  history.replaceState(null, "", location.pathname + location.search);
}

if (globalThis.BarcodeDetector) {
  BarcodeDetector.getSupportedFormats().then(formats => {
    if (formats.includes("qr_code")) scan.hidden = false;
  }).catch(() => {});
}
qr.addEventListener("change", () => {
  const file = qr.files.item(0);
  qr.value = "";
  if (!file) return;
  act(qr, async () => {
    if (file.size > 10 * 1024 * 1024) throw Object.assign(new Error(), { code: "unreadable_qr" });
    const bitmap = await createImageBitmap(file);
    try {
      const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
      if (codes.length !== 1) throw Object.assign(new Error(), { code: "unreadable_qr" });
      contactLink(codes[0].rawValue);
      contact.value = codes[0].rawValue;
      contact.focus();
      return "Contact link read. Verify it when you’re ready.";
    } finally {
      bitmap.close();
    }
  }, "Reading QR image…");
});

if (navigator.serviceWorker) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

let installPrompt;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  install.hidden = false;
});
install.addEventListener("click", async () => {
  const prompt = installPrompt;
  installPrompt = undefined;
  install.hidden = true;
  try {
    await prompt?.prompt();
  } catch {
    status.textContent = "Use your browser’s install menu to install FindMeStill.";
  }
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  install.hidden = true;
});
window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(prefix)) render().catch(() => {});
});

const book = document.querySelector("#book");
const exportButton = document.querySelector("#export-book");
const exportCode = document.querySelector("#export-code");
const bookCode = document.querySelector("#book-code");
const restoreForm = document.querySelector("#restore-book");
const recoveryCode = document.querySelector("#recovery-code");
const bookFile = document.querySelector("#book-file");

function hideCode() {
  bookCode.value = "";
  exportCode.hidden = true;
}

bookCode.onfocus = () => bookCode.select();
document.querySelector("#hide-code").onclick = hideCode;
book.addEventListener("toggle", () => { if (!book.open) hideCode(); });
window.addEventListener("pagehide", () => { hideCode(); restoreForm.reset(); });

exportButton.onclick = () => act(exportButton, async () => {
  hideCode();
  const records = savedIds().map(id => [id, localStorage.getItem(prefix + id)]);
  if (!records.length) return "Save a verified contact before creating a backup.";
  const { file, code } = await exportBook(records);
  const url = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "findmestill-contacts.fmsbook";
  bookCode.value = code;
  exportCode.hidden = false;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  bookCode.focus();
  return "Contact book prepared. Save this download’s recovery code separately.";
}, "Encrypting contact book…");

restoreForm.onsubmit = event => {
  event.preventDefault();
  act(restoreForm.querySelector("button"), async () => {
    if (!navigator.locks) throw Object.assign(new Error(), { code: "unsupported" });
    const file = bookFile.files[0];
    if (!file || file.size > maxBookBytes) return "Choose a FindMeStill contact book up to 8 MiB.";
    const code = recoveryCode.value.trim();
    recoveryCode.value = "";
    let records;
    try {
      records = await importBook(new Uint8Array(await file.arrayBuffer()), code);
    } catch {
      return "Could not verify this backup. Check that the file and recovery code belong together.";
    }
    let added = 0;
    let different = 0;
    try {
      for (const [id, jws] of records) {
        await navigator.locks.request(prefix + id, () => {
          const existing = localStorage.getItem(prefix + id);
          if (existing === null) { localStorage.setItem(prefix + id, jws); added++; }
          else if (existing !== jws) different++;
        });
      }
    } catch {
      await render();
      return `Restored ${added} before storage became unavailable. You can safely retry this file.`;
    }
    restoreForm.reset();
    await render();
    const retained = records.length - added;
    return `Restored ${added} and kept ${retained} existing. ${different ? "Some saved revisions differ from the backup. " : ""}Check for moves when online.`;
  }, "Verifying contact book…");
};
