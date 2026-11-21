// SPDX-License-Identifier: Apache-2.0
import { resolveContact, selectCard, validateContactId, validateLocator, verifyCard } from "./discovery.mjs";

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
  button.disabled = true;
  status.textContent = busy;
  try {
    status.textContent = await run();
  } catch (error) {
    status.textContent = errors[error.code] ?? "The verifier could not finish. Check the link or browser storage and try again.";
  } finally {
    button.disabled = false;
  }
}

async function saveContact(id, locator) {
  if (!navigator.onLine) throw Object.assign(new Error(), { code: "offline" });
  if (!navigator.locks) throw Object.assign(new Error(), { code: "unsupported" });
  return navigator.locks.request(prefix + id, async () => {
    const pin = localStorage.getItem(prefix + id) ?? undefined;
    const card = await resolveContact({ id, locator, pin });
    localStorage.setItem(prefix + id, card.jws);
    await render();
    return `Saved revision ${card.revision} at ${card.primary}`;
  });
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
    refresh.addEventListener("click", () => act(refresh, () => saveContact(id)));
    refresh.disabled = !navigator.onLine;
    item.append(detail, expiry, refresh);
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
    return saveContact(id, locator);
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
  try {
    let errors = 0;
    for (const id of savedIds()) {
      if (!navigator.onLine) break;
      try {
        await saveContact(id);
      } catch {
        errors += 1;
      }
    }
    if (errors && navigator.onLine) status.textContent = "Some saved contacts need attention. Check for a move to see details.";
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
