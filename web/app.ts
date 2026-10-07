// DOM glue for the pairing page. All text goes in through textContent; the page never builds
// markup from strings. Logic lives in view.ts and controller.ts.

import { PairingController, type Snapshot } from './controller.js';
import { describeStatus, remainingSeconds, type Action, type LinkInfo } from './view.js';

/** Cancel arrives with the plugin's cancel route. */
const CANCEL_ENABLED: boolean = false;

function byId(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element ${id}`);
  return e;
}

const els = {
  title: byId('state-title'),
  message: byId('state-message'),
  hint: byId('state-hint'),
  codeBlock: byId('code-block'),
  code: byId('code'),
  copy: byId('copy'),
  countdown: byId('countdown'),
  link: byId('link'),
  notice: byId('notice'),
  confirmText: byId('confirm-text'),
  actions: byId('actions'),
  apiHint: byId('api-hint'),
};

/** Cross-origin framing (access to the top window throws): never show or poll anything. */
function framedCrossOrigin(): boolean {
  if (window.top === window.self) return false;
  try {
    const href: string | undefined = window.top?.location.href;
    return href === undefined;
  } catch {
    return true;
  }
}

function setText(e: HTMLElement, text: string | null): void {
  const t = text ?? '';
  if (e.textContent !== t) e.textContent = t;
  e.hidden = t === '';
}

function setLink(info: LinkInfo | null): void {
  const a = els.link;
  if (!info) {
    a.hidden = true;
    a.removeAttribute('href');
    return;
  }
  a.textContent = info.label;
  a.setAttribute('href', info.href);
  if (info.external) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  } else {
    a.removeAttribute('target');
    a.removeAttribute('rel');
  }
  a.hidden = false;
}

let actionsKey = '';
let lastLive = '';
let lastCode: string | null = null;
let copyTimer: number | undefined;

interface Button {
  id: string;
  label: string;
  primary: boolean;
  run: () => void;
}

function renderButtons(buttons: Button[], disabled: boolean): void {
  const key = buttons.map((b) => `${b.id}:${b.label}`).join('|');
  if (key !== actionsKey) {
    const hadFocus = els.actions.contains(document.activeElement);
    els.actions.replaceChildren();
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      btn.addEventListener('click', b.run);
      els.actions.append(btn);
    }
    actionsKey = key;
    if (hadFocus) els.actions.querySelector('button')?.focus();
  }
  for (const btn of els.actions.querySelectorAll('button')) btn.disabled = disabled;
}

function buttonsFor(snap: Snapshot, controller: PairingController, actions: Action[]): Button[] {
  if (snap.confirmingUnpair) {
    return [
      {
        id: 'confirm',
        label: 'Yes, unpair',
        primary: true,
        run: () => void controller.confirmUnpair(),
      },
      {
        id: 'keep',
        label: 'Keep connection',
        primary: false,
        run: () => {
          controller.dismissUnpair();
        },
      },
    ];
  }
  const out: Button[] = [];
  for (const a of actions) {
    if (a.id === 'cancel' && !CANCEL_ENABLED) continue;
    const run = (): void => {
      if (a.id === 'pair') void controller.pair();
      else if (a.id === 'cancel') void controller.cancel();
      else controller.requestUnpair();
    };
    out.push({ id: a.id, label: a.label, primary: a.id === 'pair', run });
  }
  return out;
}

function render(snap: Snapshot, controller: PairingController, now: number): void {
  let title: string;
  let message: string;
  let hint: string | null = null;
  let code: string | null = null;
  let link: LinkInfo | null = null;
  let countdown: string | null = null;
  let apiHint: string | null = null;
  let buttons: Button[] = [];

  if (snap.problem) {
    title = snap.problem.kind === 'signin' ? 'Sign in required' : 'Plugin not available';
    message = snap.problem.message;
    link = snap.problem.link;
  } else if (snap.status) {
    const remaining = remainingSeconds(snap.status.expiresInSeconds, now - snap.receivedAt);
    const s = describeStatus(snap.status, remaining);
    title = s.title;
    message = s.message;
    hint = s.hint;
    code = s.code;
    link = s.link;
    countdown = s.countdown;
    apiHint = s.apiHint === null ? null : `Test API: ${s.apiHint}`;
    if (snap.starting) {
      message = 'Starting pairing. The code will appear here in a moment.';
    } else {
      buttons = buttonsFor(snap, controller, s.actions);
    }
  } else {
    return; // still loading: the static text stays
  }

  // One polite live region, updated only when the words change (not on countdown ticks).
  const live = `${title}\n${message}`;
  if (live !== lastLive) {
    els.title.textContent = title;
    els.message.textContent = message;
    lastLive = live;
  }
  setText(els.hint, hint);
  setText(els.code, code);
  els.codeBlock.hidden = code === null;
  if (code !== lastCode) {
    lastCode = code;
    els.copy.textContent = 'Copy code';
  }
  els.copy.hidden = code === null || !('clipboard' in navigator);
  setText(els.countdown, countdown === null ? null : countdownText(countdown));
  setLink(link);
  setText(els.notice, snap.notice);
  setText(
    els.confirmText,
    snap.confirmingUnpair ? 'Remove this connection from this server?' : null,
  );
  setText(els.apiHint, apiHint);
  renderButtons(buttons, snap.busy);
}

function countdownText(c: string): string {
  return /^\d/.test(c) ? `Code expires in ${c}` : c;
}

function start(): void {
  if (framedCrossOrigin()) {
    els.title.textContent = 'Open this page directly';
    els.message.textContent =
      'For your safety this page does not work inside another site. Open it in its own tab.';
    setLink({ href: window.location.href, label: 'Open this page directly', external: true });
    return;
  }
  let latest: Snapshot | null = null;
  const controller: PairingController = new PairingController({
    fetch: (url, init) => fetch(url, init),
    timers: {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => {
        window.clearTimeout(h as number);
      },
    },
    isHidden: () => document.hidden,
    now: () => Date.now(),
    onChange: (s) => {
      latest = s;
      render(s, controller, Date.now());
    },
  });
  document.addEventListener('visibilitychange', () => {
    controller.visibilityChanged();
  });
  els.copy.addEventListener('click', () => {
    const text = els.code.textContent;
    if (!text || !('clipboard' in navigator)) return;
    navigator.clipboard.writeText(text).then(
      () => {
        els.copy.textContent = 'Copied';
        window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => {
          els.copy.textContent = 'Copy code';
        }, 2000);
      },
      () => {
        els.copy.textContent = 'Copy failed';
      },
    );
  });
  // The countdown ticks locally between polls; nothing here touches the live region.
  window.setInterval(() => {
    if (latest && !document.hidden) render(latest, controller, Date.now());
  }, 1000);
  controller.start();
}

start();
