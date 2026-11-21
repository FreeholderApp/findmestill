// SPDX-License-Identifier: Apache-2.0
import { resolveContact, selectCard, validateContactId, validateLocator, verifyCard } from "./discovery.mjs";

const form = document.querySelector("#resolve");
const contact = document.querySelector("#contact");
const status = document.querySelector("#status");
const list = document.querySelector("#saved");
const demo = document.querySelector("#demo");
const submit = form.querySelector('button[type="submit"]');
const prefix = "findmestill/discovery-v0.1/";
const errors = {
  conflicting_cards: "Conflicting signed routes were found. Your saved address was kept. Check with the contact before relying on it.",
  expired_card: "The latest signed record has expired. A current record is needed.",
  invalid_id: "Paste a contact link that ends with its full FindMeStill ID.",
  invalid_locator: "The contact link must use a canonical HTTPS address.",
  no_verified_card: "No signed record could be verified. Check the contact link and try again.",
  unsupported: "This browser cannot safely save a contact. Try an updated browser.",
};

async function act(button, run) {
  button.disabled = true;
  status.textContent = "Checking signatures…";
  try {
    status.textContent = await run();
  } catch (error) {
    status.textContent = errors[error.code] ?? "The verifier could not finish. Check the link or browser storage and try again.";
  } finally {
    button.disabled = false;
  }
}

async function saveContact(id, locator) {
  if (!navigator.locks) throw Object.assign(new Error(), { code: "unsupported" });
  return navigator.locks.request(prefix + id, async () => {
    const pin = localStorage.getItem(prefix + id) ?? undefined;
    const card = await resolveContact({ id, locator, pin });
    localStorage.setItem(prefix + id, card.jws);
    await render();
    return `Saved revision ${card.revision} at ${card.primary}`;
  });
}

async function render() {
  const items = [];
  for (const key of Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort()) {
    const id = key.slice(prefix.length);
    let card;
    try {
      card = await verifyCard(localStorage.getItem(key), id);
    } catch {
      continue;
    }
    const item = document.createElement("li");
    const detail = document.createElement("p");
    detail.textContent = `${new URL(card.primary).host} · revision ${card.revision} · ${id}`;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "secondary";
    refresh.textContent = "Check for a move";
    refresh.addEventListener("click", () => act(refresh, () => saveContact(id)));
    item.append(detail, refresh);
    items.push(item);
  }
  list.replaceChildren(...items);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  act(submit, () => {
    const [locator, fragment, extra] = contact.value.trim().split("#");
    const id = validateContactId(extra === undefined ? fragment : undefined);
    return saveContact(id, validateLocator(locator));
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

render().catch(() => { status.textContent = "Browser storage is unavailable."; });
window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(prefix)) render().catch(() => {});
});
