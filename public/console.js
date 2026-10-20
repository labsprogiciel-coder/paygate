// Paygate operator console. Talks to /admin/* with a Clerk session token when the Worker has Clerk on (it puts the publishable key in a
// <meta>), or with the operator key, which lives in sessionStorage only (gone when the tab closes).
// Everything from the API is rendered with textContent, never as HTML: provider callback bodies are untrusted.

const store = { get: () => { try { return sessionStorage.getItem('pg_admin') } catch { return null } }, set: (v) => { try { v ? sessionStorage.setItem('pg_admin', v) : sessionStorage.removeItem('pg_admin') } catch {} } };
let key = store.get();
const app = document.getElementById('app');
const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || null;
const CLERK = { pk: meta('clerk-publishable-key'), host: meta('clerk-frontend-api') };
let clerk = null; // window.Clerk once loaded

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (v === true) el.setAttribute(k, '');
		else el.setAttribute(k, v);
	}
	for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
	return el;
}

const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));

class AuthError extends Error {}
class NotOperator extends Error { constructor(userId) { super('This account is not an operator'); this.userId = userId } }
const bearer = async () => key || (clerk?.session ? await clerk.session.getToken() : null);
async function api(method, path, body) {
	const res = await fetch(path, { method, headers: { authorization: `Bearer ${await bearer()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new AuthError(data?.error?.message || 'Unauthorized');
	if (res.status === 403 && data?.error?.code === 'not_operator') throw new NotOperator(data.error.userId);
	if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { code: data?.error?.code ?? null });
	return data;
}

const fmtAmount = (n) => n == null ? '–' : `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} FCFA`;
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const ago = (ms) => { if (!ms) return '–'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const PSP = { pawapay: 'pawaPay', pispi: 'PI-SPI', sandbox: 'Sandbox' };
const PSP_LOGO = { pawapay: '/providers/pawapay.png', pispi: '/providers/pispi.png' };
const pspLogo = (id, size = 16) => PSP_LOGO[id] ? h('img', { class: 'plogo', src: PSP_LOGO[id], alt: '', width: size, height: size }) : null;
const OPERATOR = { orange: 'Orange Money', wave: 'Wave', moov: 'Moov Money' };
const RAIL = { mobile_money: 'Mobile money', pispi_qr: 'Bank · QR code', pispi_rtp: 'Bank · payment request' };
const ICON = { orange: 'orange', wave: 'wave', moov: 'moov' };
const logoFor = (p) => p.rail === 'mobile_money' ? ICON[p.operator] : p.rail?.startsWith('pispi') ? 'pispi' : null;
/** A payment's provider as an avatar (operator or PI-SPI logo, else the PSP's initials), with a corner badge for its direction. */
const avatar = (p, kind = p.object ?? p.kind) => {
	const f = logoFor(p), out = kind === 'disbursement';
	const name = p.rail === 'mobile_money' ? (OPERATOR[p.operator] || 'Mobile money') : p.rail?.startsWith('pispi') ? 'PI-SPI' : (PSP[p.provider] || p.provider || '');
	return h('span', { class: 'av', title: `${name} · ${out ? 'payout (out)' : 'collection (in)'}` },
		f ? h('img', { src: `/providers/${f}.png`, alt: name, width: 30, height: 30 }) : h('span', { class: 'av-txt' }, (PSP[p.provider] || p.provider || '?').slice(0, 2)),
		h('span', { class: `av-dir ${out ? 'out' : 'in'}`, 'aria-hidden': 'true' }, out ? '↑' : '↓'));
};
const icon = (p) => { const f = p.rail === 'mobile_money' ? ICON[p.operator] : p.rail.startsWith('pispi') ? 'pispi' : null; return f ? h('img', { class: 'logo', src: `/providers/${f}.png`, alt: '', width: 20, height: 20 }) : null; };
const COUNTRY = { CIV: ['ci', "Côte d'Ivoire"], SEN: ['sn', 'Senegal'], BFA: ['bf', 'Burkina Faso'] };
const origin = (p) => { const c = COUNTRY[p.country]; return c ? h('span', { class: 'chan' }, h('img', { class: 'flag', src: `/country/${c[0]}.png`, alt: '', width: 20, height: 20 }), h('span', { title: c[1] }, p.country)) : h('span', { class: 'muted' }, '–'); };
const pspBadge = (p) => h('span', { class: `badge pspb psp-${p.provider}` }, pspLogo(p.provider, 14), PSP[p.provider] || p.provider);
const channel = (p) => p.rail === 'mobile_money' ? (OPERATOR[p.operator] || p.operator || 'Mobile money') : (RAIL[p.rail] || p.rail);
const badge = (s) => h('span', { class: `badge s-${s}` }, s);
const pretty = (t) => { if (!t) return null; try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t } };
/**
 * Tenants are apps and products: each has a mark, its logo or else its initials. The directory is read once a minute at most, so every page
 * can show who a payment belongs to without asking again.
 */
const TENANTS = new Map();
let tenantsAt = 0;
async function loadTenants(force = false) {
	if (!force && Date.now() - tenantsAt < 60_000) return;
	try { const { data } = await api('GET', '/admin/tenants'); TENANTS.clear(); for (const t of data) TENANTS.set(t.id, t); tenantsAt = Date.now(); } catch (e) { if (e instanceof AuthError || e instanceof NotOperator) throw e; }
}
const initials = (s) => (s || '?').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const tenantMark = (t, size = 20) => {
	const name = t?.name || t?.id || '?';
	return t?.logo ? h('img', { class: `tmark tm-${size}`, src: t.logo, alt: '', width: size, height: size }) : h('span', { class: `tmark tm-${size} tm-txt`, 'aria-hidden': 'true' }, initials(name));
};
/** A tenant as a mark and a name, from its id. */
/** A filter by tenant: every known tenant by name, plus whatever the URL asked for even if it is not (or no longer) one of them. */
const tenantSelect = (current, label = 'Tenant') => h('select', { 'aria-label': label }, h('option', { value: '' }, 'Any tenant'),
	[...TENANTS.values()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => h('option', { value: t.id, selected: t.id === current ? true : null }, t.name)),
	current && !TENANTS.has(current) ? h('option', { value: current, selected: true }, current) : null);
const tenantChip = (id) => { if (!id) return null; const t = TENANTS.get(id); return h('span', { class: 'chan tchip', title: id }, tenantMark(t ?? { id }), t?.name || id); };

/**
 * Toasts stack in one live region, newest at the bottom, so two never sit on top of each other. A success ("Saved") fades after a few
 * seconds; an error stays until it is dismissed, and is announced at once (role=alert).
 */
function toast(m, { error = false } = {}) {
	let stack = document.querySelector('.toasts');
	if (!stack) { stack = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(stack); }
	const t = h('div', { class: `toast${error ? ' bad' : ''}`, role: error ? 'alert' : null }, h('span', { class: 'grow' }, m),
		error ? h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×') : null);
	stack.append(t);
	if (!error) setTimeout(() => t.remove(), 4000);
}
/**
 * Every button that calls the API goes through this: the button is disabled and marked busy, says what it is doing, and comes back when the
 * call is done. An error is shown next to the action (`errorIn`), or else as a toast that stays; `onError` may claim it first (to put it
 * under a form field) by returning true. A session that ended goes back to sign-in.
 */
async function act(e, fn, { busy = 'Working…', errorIn, onError } = {}) {
	const b = e.currentTarget, text = b.textContent, had = document.activeElement === b, k = keyOf(b), scope = b.closest('[role=dialog]') ?? shell?.main;
	b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = busy;
	if (errorIn) put(errorIn);
	try { return await fn(); }
	catch (x) {
		if (x instanceof AuthError) return signOut('Session ended. Sign in again.');
		if (x instanceof NotOperator) return notOperator(x.userId);
		if (onError?.(x)) return;
		if (errorIn?.isConnected) put(errorIn, h('div', { class: 'alert bad', role: 'alert' }, x.message));
		else toast(x.message, { error: true });
	} finally {
		b.disabled = false; b.removeAttribute('aria-busy'); b.textContent = text;
		// a disabled button drops focus, and a re-render may have replaced it: put focus back on it, or on its replacement
		if (had && (document.activeElement === document.body || !document.activeElement)) { if (b.isConnected) b.focus(); else focusKey(scope, k); }
	}
}

/**
 * What needs a person, as toasts that stay until dismissed or acted on. A dismissed one stays away for this tab until what it says changes
 * (its key includes the count), so a refresh does not bring back what was already seen.
 */
const DISMISSED = 'pg_dismissed';
const dismissedKeys = () => { try { return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) || '[]')) } catch { return new Set() } };
const dismiss = (k) => { try { sessionStorage.setItem(DISMISSED, JSON.stringify([...dismissedKeys(), k].slice(-50))) } catch { /* only a convenience */ } };
function notices(items) {
	let stack = document.querySelector('.notices');
	if (!stack) { stack = h('div', { class: 'notices', role: 'region', 'aria-label': 'Needs attention' }); document.body.append(stack); }
	const gone = dismissedKeys();
	put(stack, items.filter((n) => !gone.has(n.key)).map((n) => {
		const el = h('div', { class: `notice ${n.level}`, role: n.level === 'bad' ? 'alert' : 'status' });
		const close = () => { dismiss(n.key); el.remove(); };
		put(el, h('div', { class: 'grow' }, h('strong', {}, n.title), h('div', { class: 'notice-why' }, n.why)),
			h('a', { class: 'btn sm', href: n.href, onclick: () => el.remove() }, n.action),
			h('button', { class: 'notice-x', 'aria-label': 'Dismiss', onclick: close }, '×'));
		return el;
	}));
}
const clearNotices = () => document.querySelector('.notices')?.replaceChildren();
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied') } catch { toast('Copy failed: select the text instead', { error: true }) } };

// ---- overlays -------------------------------------------------------------------------------------------------------------------
let uidN = 0;
const uid = (prefix) => `${prefix}${++uidN}`;
/**
 * Dialogs and drawers stack: Escape and a click on the backdrop close only the top one, Tab stays inside it, and closing gives focus back to
 * whatever opened it. Each is named by its first heading (aria-labelledby), or by `label` while it has none (a drawer still loading).
 * A form passes `dirty`, and is not thrown away by Escape or the backdrop without asking.
 */
const OPEN = [];
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
document.addEventListener('keydown', (e) => {
	const top = OPEN.at(-1);
	if (!top) return;
	if (e.key === 'Escape') { e.preventDefault(); top.dismiss(); return; }
	if (e.key !== 'Tab') return;
	const els = [...top.box.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length);
	if (!els.length) { e.preventDefault(); top.box.focus(); return; }
	const first = els[0], last = els.at(-1), at = document.activeElement;
	if (!top.box.contains(at)) { e.preventDefault(); first.focus(); }
	else if (e.shiftKey && (at === first || at === top.box)) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
});
/**
 * Controls that a re-render replaces carry a data-key; focus follows the key into the new copy, so saving a form does not drop focus to
 * <body> when the button that opened it was redrawn in the meantime.
 */
const keyOf = (el) => el?.closest?.('[data-key]')?.dataset.key ?? null;
const focusKey = (scope, k) => { if (!k || !scope) return false; const el = scope.querySelector(`[data-key="${CSS.escape(k)}"]`); el?.focus(); return !!el; };
function overlay(content, { center = false, label, dirty } = {}) {
	const back = document.activeElement, backKey = keyOf(back);
	const box = h('div', { class: center ? 'modal' : 'drawer', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }, content);
	const ov = h('div', { class: `overlay${center ? ' center' : ''}`, onclick: (e) => { if (e.target === ov) self.dismiss() } }, box);
	const name = () => {
		const hd = box.querySelector('h1, h2');
		if (hd) { hd.id ||= uid('dlg'); box.setAttribute('aria-labelledby', hd.id); box.removeAttribute('aria-label'); }
		else if (label) box.setAttribute('aria-label', label);
	};
	const self = {
		box, ov,
		close() {
			const i = OPEN.indexOf(self); if (i < 0) return; OPEN.splice(i, 1); ov.remove();
			if (back?.isConnected) back.focus(); else focusKey(OPEN.at(-1)?.box ?? shell?.main, backKey);
		},
		/** Escape, the backdrop: asks first when a form has unsaved changes */
		dismiss() { if (dirty?.() && !confirm('Discard your changes?')) return; self.close(); },
		/** replaces the content (a drawer once loaded) and names the dialog after its new heading */
		fill(...kids) { const k = box.contains(document.activeElement) ? keyOf(document.activeElement) : null; put(box, ...kids); name(); focusKey(box, k); },
	};
	OPEN.push(self);
	document.body.append(ov);
	name();
	(box.querySelector('input:not([type="hidden"]):not(:disabled):not(.sr-only), textarea, select, button') || box).focus();
	return self;
}
/** Leaving a page closes every dialog without moving focus back into a page that is going away. */
const closeAll = () => { for (const o of OPEN.splice(0)) o.ov.remove(); };
function secretModal(title, note, value) {
	const m = overlay([h('h2', {}, title), h('p', { class: 'muted' }, note), h('code', { class: 'secret' }, value),
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => copy(value) }, 'Copy'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'))], { center: true });
}
function confirmModal(title, text, label, onYes) {
	const err = h('div');
	const m = overlay([h('h2', {}, title), h('p', {}, text), err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn danger solid', onclick: (e) => act(e, async () => { await onYes(); m.close(); }, { busy: `${label}…`, errorIn: err }) }, label))], { center: true });
}
/**
 * A form field: the label is tied to its control (for/id), and the hint and any error under it are read with it (aria-describedby).
 * Meaning goes in the hint, never only in a placeholder, which disappears as soon as someone types. `hint` may be a node that changes.
 */
const ERR = new WeakMap();
function field(label, input, hint) {
	input.id ||= uid('f');
	const hintEl = hint == null ? null : hint.nodeType ? hint : h('small', { class: 'hint' }, hint);
	if (hintEl) hintEl.id ||= uid('h');
	const errEl = h('small', { class: 'field-err', id: uid('e'), hidden: true });
	ERR.set(input, errEl);
	input.setAttribute('aria-describedby', [hintEl?.id, errEl.id].filter(Boolean).join(' '));
	return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl, errEl);
}
/** Shows `msg` under the field (or clears it with null) and marks the control invalid for assistive tech. */
function setError(input, msg) {
	const el = ERR.get(input);
	if (!el) return;
	if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
	put(el, msg || ''); el.hidden = !msg;
}
/** Checks [control, message-or-null] pairs: marks every wrong one, moves focus to the first, and says whether all were right. */
function check(rules) {
	let first = null;
	for (const [input, msg] of rules) { setError(input, msg || null); if (msg && !first) first = input; }
	if (first) { first.closest('details')?.setAttribute('open', ''); first.focus(); }
	return !first;
}
/**
 * Checks one field again when the person leaves it, so a mistake shows before Save, not only after. Not when they are leaving it for one of
 * the dialog's buttons: an error appearing then pushes the button down under the pointer and the click is lost; the button checks anyway.
 */
const onBlurCheck = (input, rule) => input.addEventListener('blur', (e) => {
	if (e.relatedTarget?.closest?.('.actions')) return;
	if (input.value !== '' || input.hasAttribute('aria-invalid')) setError(input, rule() || null);
});

// ---- login ----------------------------------------------------------------------------------------------------------------------
const loadScript = (src) => new Promise((ok, fail) => document.head.append(h('script', { src, crossorigin: 'anonymous', 'data-clerk-publishable-key': CLERK.pk, onload: ok, onerror: () => fail(new Error(`Could not load ${src}`)) })));
/** Clerk's UI, then Clerk itself, from the Frontend API host the Worker named (the page's CSP allows only that host). */
async function loadClerk() {
	if (clerk) return clerk;
	await loadScript(`https://${CLERK.host}/npm/@clerk/ui@1/dist/ui.browser.js`);
	await loadScript(`https://${CLERK.host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`);
	await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
	return (clerk = window.Clerk);
}
async function signOut(msg) {
	store.set(null); key = null; started = false; location.hash = '';
	if (clerk?.session) await clerk.signOut().catch(() => {});
	login(msg);
}

const login = (msg) => CLERK.pk ? clerkLogin(msg) : keyLogin(msg);

function keyLogin(msg) {
	const input = h('input', { type: 'password', autocomplete: 'off', required: true });
	const form = h('form', { class: 'login', onsubmit: async (e) => {
		e.preventDefault(); key = input.value.trim();
		try { await api('GET', '/admin/float'); store.set(key); start() } catch (err) { key = null; keyLogin(err instanceof AuthError ? 'That key was not accepted.' : err.message) }
	} }, h('h1', {}, 'Paygate'), h('p', { class: 'sub' }, 'Operator console. The key stays in this tab only.'), msg ? h('div', { class: 'alert bad' }, msg) : null,
		field('Operator key', input, 'The ADMIN_API_KEY secret of this Worker.'), h('div', { class: 'actions' },
			CLERK.pk ? h('button', { class: 'btn', type: 'button', onclick: () => clerkLogin() }, 'Back') : null,
			h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
	put(app, form); input.focus();
}

async function clerkLogin(msg) {
	const box = h('div', { class: 'clerk' }, h('p', { class: 'muted' }, 'Loading…'));
	put(app, h('div', { class: 'login' }, h('h1', {}, 'Paygate'), h('p', { class: 'sub' }, 'Operator console'), msg ? h('div', { class: 'alert bad' }, msg) : null, box,
		h('p', { class: 'muted small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); keyLogin() } }, 'Use the operator key instead'))));
	try {
		const c = await loadClerk();
		if (c.session) return start();
		box.replaceChildren();
		c.mountSignIn(box, { routing: 'virtual', fallbackRedirectUrl: '/' });
		const off = c.addListener(({ session }) => { if (session && !key) { off(); c.unmountSignIn(box); start() } });
	} catch (err) { put(box, h('div', { class: 'alert bad' }, err.message)) }
}

function notOperator(userId) {
	const id = h('code', { class: 'secret' }, userId || '?');
	put(app, h('div', { class: 'login' }, h('h1', {}, 'Paygate'), h('div', { class: 'alert warn' }, 'You are signed in, but this account is not an operator.'),
		h('p', {}, 'Ask an operator to add your Clerk user id to CLERK_OPERATOR_IDS:'), id,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => copy(userId) }, 'Copy id'), h('button', { class: 'btn primary', onclick: () => signOut() }, 'Sign out'))));
}

// ---- skeletons and paging ----------------------------------------------------------------------------------------------------------
// Placeholders shaped like what is loading, so the page does not jump when it arrives. Widths are classes: the CSP allows no inline styles.
const W = ['w30', 'w60', 'w45', 'w75', 'w40', 'w55', 'w35', 'w65'];
const bar = (i = 0, cls = '') => h('span', { class: `sk ${W[i % W.length]} ${cls}` });
const busy = (...kids) => h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div', { 'aria-hidden': 'true' }, kids));
const skTable = (cols, n = 8) => busy(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
	h('tbody', {}, Array.from({ length: n }, (_, r) => h('tr', { class: 'sk-row' }, cols.map((_, c) => h('td', {}, bar(r + c)))))))));
const skList = (n = 8) => busy(h('div', { class: 'list' }, Array.from({ length: n }, (_, i) => h('div', { class: 'li' }, h('span', { class: 'sk sk-sq' }),
	h('div', { class: 'min0' }, bar(i, 'sk-l'), bar(i + 3, 'sk-s')), h('span', { class: 'sk w-amt' }), h('span', { class: 'sk sk-pill' })))));
const skFeed = (n = 8, compact = false) => busy(h('ul', { class: `feed${compact ? ' compact' : ''}` }, compact ? null : h('li', { class: 'day' }, h('span', { class: 'sk w-day' })),
	Array.from({ length: n }, (_, i) => h('li', { class: 'ev' }, h('span', { class: 'sk w-time' }), h('span', { class: 'sk w-src' }),
		h('div', { class: 'ev-main' }, bar(i + 1, 'sk-l'), bar(i + 4, 'sk-s')), h('span', { class: 'sk sk-pill' })))));
const skTiles = () => busy(h('div', { class: 'tiles' }, [0, 1, 2, 3].map((i) => h('div', { class: 'tile' }, bar(i, 'sk-s'), h('span', { class: 'sk sk-big' }), bar(i + 2, 'sk-s')))));
const skCards = (n) => busy(h('div', { class: 'cards' }, Array.from({ length: n }, (_, i) => h('div', { class: 'xcard' }, bar(i, 'sk-l'), h('span', { class: 'sk sk-big' }), bar(i + 1, 'sk-s'), bar(i + 2, 'sk-l')))));
const skHead = () => busy(h('div', { class: 'bar' }, h('div', { class: 'grow' }, h('span', { class: 'sk sk-h1' }))));
const skDrawer = () => busy(h('div', { class: 'bar' }, h('span', { class: 'sk sk-h1' })), h('div', { class: 'card' }, h('dl', { class: 'kv' },
	Array.from({ length: 8 }, (_, i) => [h('dt', {}, bar(i, 'sk-s')), h('dd', {}, bar(i + 3))]))), h('div', { class: 'card' }, bar(1), bar(4), bar(2)));
const SKELETON = {
	overview: () => [skHead(), skTiles(), h('div', { class: 'cols mt22' }, skList(6), skFeed(6, true))],
	wallets: (id) => id ? [skHead(), skTiles(), skTable(['Product', 'Available', 'Held', 'Share'], 3)] : [skHead(), skCards(4)],
	providers: (id) => id ? [skHead(), ...[0].map((i) => busy(h('section', { class: 'psp' }, h('header', { class: 'psp-head' }, h('span', { class: 'sk sk-sq' }), h('div', { class: 'grow' }, h('span', { class: 'sk sk-h1' }))),
		h('div', { class: 'psp-body' }, h('div', { class: 'panel' }, Array.from({ length: 5 }, (_, r) => bar(r + i, 'sk-l'))), h('div', { class: 'panel' }, Array.from({ length: 3 }, (_, r) => bar(r + i + 2, 'sk-l')))))))] : [skHead(), skCards(2)],
	payments: () => [skHead(), h('div', { class: 'mb20' }, skTiles()), skTable(['When', 'Tenant', 'Type', 'PSP', 'Channel', 'Origin', 'Reference', 'Counterparty', 'Amount', 'Status'], 10)],
	events: () => [skHead(), skFeed(10)],
	tenants: () => [skHead(), skTable(['Id', 'Name', 'Status', 'Webhook', 'Max payment', 'Created'], 5)],
};

const SIZES = [10, 25, 50];
const pref = { get: () => { try { return Number(localStorage.getItem('pg_rows')) || 10 } catch { return 10 } }, set: (n) => { try { localStorage.setItem('pg_rows', String(n)) } catch {} } };
/**
 * Cursor paging, newest first. `fetch(cursor, size)` answers { data, next, total? }; Older follows `next`, Newer goes back up the cursors already seen.
 * The page keeps its height while the next one loads (a skeleton of the same number of rows), and scrolls back to the top of the list.
 */
function pager({ fetch, render, skeleton, noun = 'rows' }) {
	const body = h('div'), nav = h('div', { class: 'pager' });
	let stack = [null], size = SIZES.includes(pref.get()) ? pref.get() : 10, last = null, loading = false, seq = 0;
	const sizeSel = h('select', { 'aria-label': `${noun} per page` }, SIZES.map((n) => h('option', { value: n, selected: n === size ? true : null }, `${n} per page`)));
	sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); pref.set(size); reset() });
	const draw = () => {
		const n = last?.data.length ?? 0, from = (stack.length - 1) * size + 1;
		const info = loading ? 'Loading…' : !n ? '' : last.total != null ? `${from}–${from + n - 1} of ${last.total} ${noun}` : `Page ${stack.length}`;
		put(nav, h('span', { class: 'muted small grow', 'aria-live': 'polite' }, info), sizeSel,
			h('button', { class: 'btn sm', disabled: loading || stack.length === 1 ? true : null, onclick: () => { stack.pop(); load(true) } }, '← Newer'),
			h('button', { class: 'btn sm', disabled: loading || !last?.next ? true : null, onclick: () => { stack.push(last.next); load(true) } }, 'Older →'));
	};
	const load = async (scroll = false, quiet = false) => {
		const mine = ++seq; loading = true; draw();
		if (!quiet || !last) put(body, skeleton(Math.max(3, Math.min(last?.data.length || 8, size)))); // a refresh keeps the rows until the new ones arrive
		if (scroll) body.scrollIntoView({ block: 'start', behavior: 'smooth' });
		try { const r = await fetch(stack.at(-1), size); if (mine !== seq) return; last = r; put(body, render(r.data)) }
		catch (e) { if (mine !== seq) return; if (e instanceof AuthError) return signOut('Session ended. Sign in again.'); if (e instanceof NotOperator) return notOperator(e.userId); last = null; put(body, h('div', { class: 'alert bad' }, e.message, ' ', h('button', { class: 'btn sm', onclick: () => load() }, 'Retry'))) }
		loading = false; draw();
	};
	const reset = () => { stack = [null]; last = null; return load() };
	return { el: h('div', {}, body, nav), reset, refresh: () => load(false, true) };
}

// ---- shell + router -------------------------------------------------------------------------------------------------------------
const PAGES = { overview: ['Overview', overview], wallets: ['Wallets', walletsPage], providers: ['Providers', providersPage], payments: ['Payments', payments], events: ['Events', events], tenants: ['Tenants', tenants] };
let attention = { unknown: 0, problems: 0 };

let started = false;
async function start() {
	if (!key) {
		if (!CLERK.pk) return login();
		const c = await loadClerk().catch(() => null);
		if (!c?.session) return login();
	}
	if (!started) window.addEventListener('hashchange', route);
	started = true;
	route();
}
/**
 * The shell (sidebar, nav, main) is built once; navigating swaps only the page inside it. Navigating is the one thing that closes dialogs:
 * the page they belonged to is gone. An action on a page calls reloadPage() instead, which re-reads that page's data in place.
 */
let shell = null;
/** How the page on screen re-reads its data. A page with its own lists (paging, filters) sets this; otherwise it is drawn again. */
let pageReload = null;
function buildShell() {
	const nav = h('nav', { class: 'nav' }, Object.entries(PAGES).map(([id, [label]]) => h('a', { href: `#/${id}` }, label)));
	const main = h('main', { class: 'main' });
	const root = h('div', { class: 'shell' }, h('aside', { class: 'side' }, h('div', { class: 'brand' }, 'Paygate', h('small', {}, 'Operator console')), nav, h('div', { class: 'spacer' }),
		h('button', { class: 'btn sm', onclick: () => signOut() }, 'Sign out')), main);
	put(app, root);
	shell = { root, nav, main };
}
async function route() {
	closeAll();
	clearNotices(); // the overview puts back what still needs a person
	const [name, param] = (location.hash.slice(2) || 'overview').split('?')[0].split('/').map((x) => x && decodeURIComponent(x));
	const page = PAGES[name] ? name : 'overview';
	if (!shell?.root.isConnected) buildShell(); // first time, or after sign-in replaced the app
	for (const a of shell.nav.children) a.setAttribute('aria-current', a.getAttribute('href') === `#/${page}` ? 'page' : 'false');
	const main = h('main', { class: 'main' }, SKELETON[page](param));
	shell.main.replaceWith(main); shell.main = main;
	pageReload = null;
	try {
		await loadTenants();
		await PAGES[page][1](main, param);
		if (shell.main === main) pageReload ??= () => PAGES[page][1](main, param);
		refreshAttention();
	} catch (e) {
		if (e instanceof AuthError) return signOut('Session ended. Sign in again.');
		if (e instanceof NotOperator) return notOperator(e.userId);
		put(main, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: route }, 'Retry'));
	}
}
/**
 * After an action, or Refresh: the page's data again, drawn in place. No skeleton, dialogs stay open, the scroll position is kept, and
 * focus stays on the control it was on (by key) even if that control was redrawn. A failure is shown, not thrown: the action itself worked.
 */
async function reloadPage() {
	if (!pageReload) return;
	const y = window.scrollY, main = shell.main, k = main.contains(document.activeElement) ? keyOf(document.activeElement) : null;
	try {
		await loadTenants(true);
		await pageReload();
		if (shell.main !== main) return; // navigated away meanwhile
		window.scrollTo(0, y);
		if (k && !OPEN.length) focusKey(main, k);
		refreshAttention();
	} catch (e) {
		if (e instanceof AuthError) return signOut('Session ended. Sign in again.');
		if (e instanceof NotOperator) return notOperator(e.userId);
		toast(`Could not refresh: ${e.message}`, { error: true });
	}
}
/** A page's Refresh button: reloads in place, with the usual busy state. */
const refreshButton = () => h('button', { class: 'btn', 'data-key': 'refresh', onclick: (e) => act(e, reloadPage, { busy: 'Refreshing…' }) }, 'Refresh');
async function refreshAttention() {
	const nav = shell?.nav;
	if (!nav) return;
	try {
		const a = await api('GET', '/admin/attention');
		attention = { unknown: a.unknown, problems: a.deadWebhooks + a.rejectedCallbacks24h };
		const set = (id, n) => { const el = [...nav.children].find((x) => x.getAttribute('href') === `#/${id}`); if (!el) return; el.querySelector('.count')?.remove(); if (n) el.append(h('span', { class: 'count' }, n)); };
		set('payments', attention.unknown); set('events', attention.problems);
	} catch { /* the badge is a convenience */ }
}
const head = (title, sub, ...actions) => h('div', { class: 'bar' }, h('div', { class: 'grow' }, h('h1', {}, title), sub ? h('p', { class: 'sub m0' }, sub) : null), actions);
const table = (cols, rows, empty) => rows.length
	? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))), h('tbody', {}, rows)))
	: h('div', { class: 'card empty' }, empty);

// ---- overview -------------------------------------------------------------------------------------------------------------------
const compact = (n) => n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : new Intl.NumberFormat('fr-FR').format(n).replace(/\u202f|\u00a0/g, ' ');
const fmtBytes = (b) => b >= 2 ** 30 ? `${+(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${+(b / 2 ** 20).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tile = (label, value, sub, cls) => h('div', { class: `tile${cls ? ' ' + cls : ''}` }, h('div', { class: 'tl' }, label), h('div', { class: 'tv' }, value), sub ? h('div', { class: 'ts' }, sub) : null);

async function overview(main) {
	const [flt, prov, att, recent, feed] = await Promise.all([api('GET', '/admin/float'), api('GET', '/admin/providers'), api('GET', '/admin/attention'),
		api('GET', '/admin/payments?limit=10'), api('GET', '/admin/events?limit=10')]);

	// what needs a person, most serious first, as toasts; wallets below the floor are grouped so three countries make one toast, not three
	const todo = [];
	if (att.unknown) todo.push({ key: `unknown:${att.unknown}`, level: 'bad', title: `${plural(att.unknown, 'payout')} with an unknown outcome`, why: 'Money may have been sent. A person must decide.', href: '#/payments?status=unknown', action: 'Resolve' });
	const floats = (flt.rows || []).filter((r) => r.status === 'critical' || r.status === 'low');
	for (const [status, level] of [['critical', 'bad'], ['low', 'warn']]) {
		const rows = floats.filter((r) => r.status === status);
		if (rows.length) todo.push({ key: `float-${status}:${rows.map((r) => r.country).join(',')}`, level, title: `Float ${status}: ${rows.map((r) => r.country).join(', ')}`, why: `${rows[0].reasons.join(' ') || 'Below the minimum float'} (${fmtAmount(flt.floor)}).`, href: '#/wallets', action: 'View' });
	}
	if (att.deadWebhooks) todo.push({ key: `dead:${att.deadWebhooks}`, level: 'warn', title: `${plural(att.deadWebhooks, 'webhook')} not delivered`, why: 'A product was not told about a payment.', href: '#/events?source=webhook&problems=1', action: 'Retry' });
	const db = att.database?.bytes != null ? att.database : null;
	if (db && db.bytes >= db.limit * 0.8) todo.push({ key: `db:${Math.floor(db.bytes / 2 ** 28)}`, level: 'warn', title: `Database ${Math.round((db.bytes / db.limit) * 100)}% full`, why: `${fmtBytes(db.bytes)} of ${fmtBytes(db.limit)}. Old webhook payloads are already pruned every hour; look for what else grew.`, href: '#/events', action: 'View' });
	if (att.rejectedCallbacks24h) todo.push({ key: `rejected:${att.rejectedCallbacks24h}`, level: 'warn', title: `${plural(att.rejectedCallbacks24h, 'callback')} rejected (24 h)`, why: 'Failed the signature or shape check.', href: '#/events?source=callback&problems=1', action: 'Inspect' });

	// the last 24 hours, every provider together
	const rows = prov.last24h;
	const sum = (f) => rows.filter(f).reduce((a, r) => ({ n: a.n + r.n, amount: a.amount + (r.amount || 0) }), { n: 0, amount: 0 });
	const inn = sum((r) => r.kind === 'collection' && r.status === 'completed'), out = sum((r) => r.kind === 'disbursement' && r.status === 'completed');
	const done = sum((r) => ['completed', 'failed', 'expired'].includes(r.status)), open = sum((r) => r.status === 'processing');
	const rate = done.n ? Math.round(((inn.n + out.n) / done.n) * 100) : null;
	const kpis = h('div', { class: 'tiles' },
		tile('Collected', `${compact(inn.amount)} FCFA`, plural(inn.n, 'payment')),
		tile('Paid out', `${compact(out.amount)} FCFA`, plural(out.n, 'payment')),
		tile('Success rate', rate === null ? '–' : `${rate}%`, done.n ? `${inn.n + out.n} of ${done.n} settled` : 'nothing settled yet'),
		tile('In progress', String(open.n), att.unknown ? `${att.unknown} unknown, needs a person` : 'waiting on customers or providers', att.unknown ? 'bad' : null));

	const sandbox = prov.data.some((p) => p.id === 'sandbox');
	const live = prov.data.some((p) => p.notes.includes('LIVE'));
	put(main,
		head('Overview', null, h('span', { class: `mode ${live ? 's-completed' : sandbox ? 's-low' : 's-idle'}` }, live ? 'Live' : sandbox ? 'Sandbox: no money moves' : 'Not live'), refreshButton()),
		h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Last 24 hours')), kpis,
		h('div', { class: 'cols' },
			h('section', {}, h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Latest payments'), h('a', { href: '#/payments' }, 'All payments')), paymentList(recent.data)),
			h('section', {}, h('div', { class: 'sec' }, h('h2', { class: 'm0' }, 'Latest events'), h('a', { href: '#/events' }, 'All events')), feedList(feed.data, { compact: true }))),
		db ? h('p', { class: 'muted small' }, `Database: ${fmtBytes(db.bytes)} of ${fmtBytes(db.limit)}`) : null);
	notices(todo);
}

/** A short list for the overview; the full table is on the payments page. */
function paymentList(rows) {
	if (!rows.length) return h('div', { class: 'card empty' }, 'No payments yet.');
	return h('div', { class: 'list' }, rows.map((p) => h('div', { class: 'li click', tabindex: 0, 'data-key': `payment:${p.id}`, onclick: () => paymentDrawer(p.id), onkeydown: (e) => { if (e.key === 'Enter') paymentDrawer(p.id) } },
		avatar(p),
		h('div', { class: 'grow min0' }, h('div', { class: 'ellipsis' }, h('span', { class: 'mono' }, p.reference)), h('div', { class: 'muted small ellipsis' }, tenantChip(p.tenant), ' · ', channel(p), ' · ', ago(p.createdAt))),
		h('span', { class: 'num strong' }, fmtAmount(p.amount)), badge(p.status))));
}

// ---- providers ------------------------------------------------------------------------------------------------------------------
// One section per PSP: what each channel can do on the account right now, and the accounts money is paid from.
const CH_STATUS = { OPERATIONAL: ['Open', 's-completed'], DELAYED: ['Delayed', 's-low'], CLOSED: ['Closed', 's-failed'] };
const chOp = (op) => {
	if (!op) return h('span', { class: 'badge s-idle' }, 'Not on account');
	const [label, cls] = CH_STATUS[op.status] || [op.status.toLowerCase(), 's-idle'];
	const lim = op.min != null || op.max != null ? `${op.min != null ? compact(op.min) : '0'} – ${op.max != null ? compact(op.max) : 'no max'}` : null;
	return h('span', { class: 'chop' }, h('span', { class: `badge ${cls}` }, label), lim ? h('span', { class: 'muted small num' }, lim) : null);
};
const chName = (c) => c.operator === 'bank' ? (c.code === 'PISPI_RTP' ? 'Bank · payment request' : 'Bank · QR code') : (OPERATOR[c.operator] || c.operator);
const flag = (iso3) => COUNTRY[iso3] ? h('img', { class: 'flag', src: `/country/${COUNTRY[iso3][0]}.png`, alt: '', width: 20, height: 20 }) : null;
const ENV = { Live: 's-completed', Sandbox: 's-low', Simulated: 's-low', Simulator: 's-low', Off: 's-idle' };

const pspRows = (prov, p) => prov.last24h.filter((r) => r.provider === p.id || (p.id === 'pispi' && r.rail?.startsWith('pispi')));
const PSP_SUB = 'Every payment provider the gateway uses and what each channel can do on the account right now. Figures are for the last 24 hours.';
async function providersPage(main, id) {
	const prov = await api('GET', '/admin/providers');
	if (id) {
		const p = prov.data.find((x) => x.id === id);
		return put(main, back('#/providers', 'Providers'), p ? [head(h('span', { class: 'chan' }, pspMark(p, 32), p.name, h('span', { class: `mode ${ENV[p.environment] || 's-idle'}` }, p.environment), badge(p.active ? 'active' : 'idle')),
			[p.role, p.endpoint ? [' · ', h('span', { class: 'mono' }, p.endpoint)] : null, '. Figures are for the last 24 hours.'], refreshButton()), pspSection(p, pspRows(prov, p))] : h('div', { class: 'alert bad' }, `No provider ${id}.`));
	}
	put(main, head('Providers', PSP_SUB, refreshButton()), h('div', { class: 'cards' }, prov.data.map((p) => pspCard(p, pspRows(prov, p)))));
}
/** What a provider did in the last 24 hours, from the payments rows the API groups for it. */
function pspStats(rows) {
	const sum = (f) => rows.filter(f).reduce((a, r) => ({ n: a.n + r.n, amount: a.amount + (r.amount || 0) }), { n: 0, amount: 0 });
	return { inn: sum((r) => r.kind === 'collection' && r.status === 'completed'), out: sum((r) => r.kind === 'disbursement' && r.status === 'completed'),
		open: sum((r) => r.status === 'processing'), bad: sum((r) => r.status === 'failed' || r.status === 'unknown') };
}
const pspMark = (p, size = 44) => PSP_LOGO[p.id] ? h('img', { class: 'pmark', src: PSP_LOGO[p.id], alt: '', width: size, height: size }) : h('span', { class: 'pmark mono-mark' }, p.id === 'sandbox' ? 'SB' : p.id.slice(0, 2));
/**
 * A provider as one card of the grid: the same lines in every card whatever the provider, each one line long, so the cards line up.
 * Everything that varies in length (channels, notes, accounts) is on its detail page.
 */
function pspCard(p, rows) {
	const { inn, out, open, bad } = pspStats(rows);
	const ops = (p.channels || []).flatMap((c) => [c.collect, c.payout]).filter(Boolean);
	const closed = ops.filter((x) => x.status === 'CLOSED').length;
	const line = !p.channels ? h('span', { class: 'bad-text' }, 'Channels could not be read')
		: [`${plural(new Set(p.channels.map((c) => c.country)).size, 'country', 'countries')} · ${plural(p.channels.length, 'channel')}`, closed ? h('span', { class: 'bad-text' }, ` · ${closed} closed`) : null];
	const stat = (label, value, warn) => h('div', {}, h('dt', {}, label), h('dd', { class: `num${warn ? ' bad-text' : ''}` }, value));
	return h('a', { class: `xcard${p.active ? '' : ' off'}`, href: `#/providers/${encodeURIComponent(p.id)}`, 'data-key': `psp:${p.id}` },
		h('div', { class: 'xcard-head' }, pspMark(p, 32), h('h2', { class: 'm0 ellipsis' }, p.name), h('span', { class: 'grow' }), badge(p.active ? 'active' : 'idle')),
		h('div', { class: 'xcard-line ellipsis' }, h('span', { class: `mode ${ENV[p.environment] || 's-idle'}` }, p.environment), ' ', p.role),
		h('div', { class: 'xcard-line ellipsis muted' }, line),
		h('dl', { class: 'xcard-stats' }, stat('Collected', fmtAmount(inn.amount)), stat('Paid out', fmtAmount(out.amount)), stat('In progress', String(open.n)), stat('Failed / unknown', String(bad.n), bad.n > 0)));
}
const back = (href, label) => h('a', { class: 'back', href }, `← ${label}`);

// ---- books ----------------------------------------------------------------------------------------------------------------------
// Who owns the money in each wallet: the journal per product, beside what the wallet really holds and what Formance has.
const POOL_NAME = { CIV: "Côte d'Ivoire", SEN: 'Senegal', BFA: 'Burkina Faso', PISPI: 'PI-SPI bank account' };
const signed = (n) => n == null ? '–' : `${n > 0 ? '+' : ''}${fmtAmount(n)}`;
const WALLETS_SUB = 'What each wallet holds and whether the books account for all of it. Open a wallet to see which product owns what.';
async function walletsPage(main, id) {
	const [b, prov] = await Promise.all([api('GET', '/admin/ledger'), api('GET', '/admin/providers').catch((e) => { if (e instanceof AuthError || e instanceof NotOperator) throw e; return null; })]);
	const accounts = Object.fromEntries((prov?.data || []).flatMap((p) => p.accounts.filter((a) => a.kind !== 'alias').map((a) => [a.country, a])));
	const floor = prov?.floor ?? null;
	if (id) {
		const p = b.pools.find((x) => x.pool === id);
		return put(main, back('#/wallets', 'Wallets'), p ? walletDetail(b, p, accounts[p.pool], floor) : h('div', { class: 'alert bad' }, `No wallet ${id}.`));
	}
	put(main, head('Wallets', WALLETS_SUB, adjustButton(b.pools.map((p) => p.pool)), rebuildButton(), refreshButton()), syncStatus(b),
		b.pools.length ? h('div', { class: 'cards' }, b.pools.map((p) => walletCard(b, p, accounts[p.pool], floor)))
			: h('div', { class: 'card empty' }, 'Nothing booked yet. Payments book themselves as they complete; "Rebuild from payments" books the history.'));
}
const poolMark = (pool) => pool === 'PISPI' ? h('img', { class: 'flag', src: '/providers/pispi.png', alt: '', width: 20, height: 20 }) : flag(pool);
const adjustButton = (pools, pool) => h('button', { class: 'btn', 'data-key': 'adjust', onclick: () => adjustModal(pools, pool) }, 'Book an adjustment…');
const rebuildButton = () => h('button', { class: 'btn', 'data-key': 'rebuild', onclick: (e) => act(e, async () => { const r = await api('POST', '/admin/ledger/backfill'); toast(r.added ? `${plural(r.added, 'posting')} added` : 'Already up to date'); await reloadPage(); }, { busy: 'Rebuilding…' }) }, 'Rebuild from payments');
/** Whether the books reached Formance: a banner when a person must act or wait, a quiet line when all is well. */
function syncStatus(b) {
	const o = b.outbox;
	const banner = (level, title, detail, action) => h('div', { class: `banner ${level}`, role: level === 'bad' ? 'alert' : 'status' },
		h('div', { class: 'banner-body' }, h('strong', {}, title), h('div', { class: 'small' }, detail)), action);
	if (b.enabled && b.formanceError) return banner('bad', 'Formance could not be read', `${b.formanceError}. The books are safe in the gateway; the Formance column is missing until it answers.`);
	if (b.enabled && o.stuck) return banner('bad', `${plural(o.stuck, 'posting')} stuck on the way to Formance`,
		`They failed 10 times and are no longer retried. Fix what stopped them (credentials, scopes, the ledger ${b.ledger}), then send them again.`,
		h('button', { class: 'btn', 'data-key': 'retry-stuck', onclick: (e) => act(e, async () => { const r = await api('POST', '/admin/ledger/retry'); toast(`${plural(r.reset, 'posting')} will be sent again`); await reloadPage(); }, { busy: 'Retrying…' }) }, 'Retry stuck postings'));
	if (b.enabled && o.pending) return banner('info', `${plural(o.pending, 'posting')} waiting for Formance`, `They go out with the next sweep, within a minute (ledger ${b.ledger}).`);
	return h('p', { class: 'small muted books-status' }, b.enabled ? `Copied to Formance (ledger ${b.ledger}), nothing waiting.` : 'Kept in the gateway only: set FORMANCE_BASE_URL to copy it to a Formance ledger.');
}
/** The verdict on a wallet: do the books account for what it holds, and does Formance agree. */
function walletVerdict(b, p, a) {
	const unexplained = p.difference != null && p.difference !== 0, formanceOff = b.enabled && p.formance != null && p.formance !== p.total;
	const low = a && a.status !== 'ok';
	const badge_ = p.difference == null ? h('span', { class: 'badge s-idle' }, 'not checked') : unexplained ? h('span', { class: 'badge s-failed' }, `${signed(p.difference)} unexplained`) : h('span', { class: 'badge s-completed' }, 'balanced');
	// one line, worst first
	const note = low ? h('span', { class: 'bad-text' }, a.reasons?.[0] || 'Below the floor') : formanceOff ? h('span', { class: 'bad-text' }, `Formance has ${fmtAmount(p.formance)}`)
		: a ? (a.coverDays == null ? 'No recent payouts' : `${a.coverDays} days of payouts covered`) : p.pool === 'PISPI' ? 'PI-SPI reports no balance' : 'No balance reported';
	return { badge: badge_, note, warn: unexplained || formanceOff || low };
}
/**
 * A wallet as one card of the grid: the same five lines in every card, each one line long, so the cards line up whatever the wallet holds.
 * Who owns the money, the float and Formance are on the wallet's own page.
 */
function walletCard(b, p, a, floor) {
	const v = walletVerdict(b, p, a);
	const stat = (label, value) => h('div', {}, h('dt', {}, label), h('dd', { class: 'num' }, value));
	return h('a', { class: `xcard${v.warn ? ' warn' : ''}`, href: `#/wallets/${encodeURIComponent(p.pool)}`, 'data-key': `wallet:${p.pool}` },
		h('div', { class: 'xcard-head' }, poolMark(p.pool), h('h2', { class: 'm0 ellipsis' }, POOL_NAME[p.pool] || p.pool), h('span', { class: 'grow' }), h('span', { class: 'muted small mono' }, p.pool)),
		h('div', { class: 'xcard-big num' }, p.wallet == null ? h('span', { class: 'muted' }, '–') : fmtAmount(p.wallet)),
		h('div', { class: 'xcard-line' }, v.badge),
		h('div', { class: 'xcard-line ellipsis small muted' }, v.note),
		h('dl', { class: 'xcard-stats' }, stat('Books total', fmtAmount(p.total)), stat('Products', String(p.tenants.length))));
}
/** One wallet: what it holds, who owns it, the studio's float and Formance's copy. */
function walletDetail(b, p, a, floor) {
	const v = walletVerdict(b, p, a);
	const owned = p.tenants.reduce((n, t) => n + t.available + (t.held || 0), 0);
	const rows = [...p.tenants].sort((x, y) => (y.available + (y.held || 0)) - (x.available + (x.held || 0))).map((t) => h('tr', {},
		h('td', {}, tenantChip(t.tenant)), h('td', { class: `num${t.available < 0 ? ' bad-text' : ''}` }, fmtAmount(t.available)), h('td', { class: 'num' }, t.held ? fmtAmount(t.held) : '–'),
		h('td', { class: 'num' }, p.total ? `${Math.round(((t.available + (t.held || 0)) / p.total) * 100)} %` : '–')));
	return [
		head(h('span', { class: 'chan' }, poolMark(p.pool), POOL_NAME[p.pool] || p.pool), p.pool === 'PISPI' ? 'The PI-SPI bank account: money collected by bank transfer and QR code.' : `The pawaPay wallet in ${POOL_NAME[p.pool] || p.pool}: mobile money collected and paid out there.`,
			adjustButton(b.pools.map((x) => x.pool), p.pool), refreshButton()),
		syncStatus(b),
		h('div', { class: 'tiles mt14' },
			tile(p.pool === 'PISPI' ? 'In the bank account' : 'In the wallet', p.wallet == null ? '–' : fmtAmount(p.wallet), v.note, a && a.status !== 'ok' ? 'bad' : null),
			tile('Books total', fmtAmount(p.total), `${fmtAmount(owned)} owned by products`),
			tile('Unexplained', p.difference == null ? '–' : p.difference === 0 ? 'none' : signed(p.difference), p.difference ? 'book it as an adjustment once you know what it is' : 'the books account for every franc', p.difference ? 'bad' : null),
			b.enabled ? tile('Formance', p.formance == null ? '–' : fmtAmount(p.formance), p.formance == null ? 'not read' : p.formance === p.total ? 'matches the books' : 'differs from the books', p.formance != null && p.formance !== p.total ? 'bad' : null)
				: tile('Studio float', fmtAmount(p.unallocated), 'owned by no product')),
		h('h2', { class: 'mt22' }, 'Who owns the money'),
		table([{ label: 'Product' }, { label: 'Available', num: true }, { label: 'Held for payouts', num: true }, { label: 'Share of the books', num: true }], [
			...rows,
			h('tr', { class: 'sum' }, h('td', {}, h('span', { class: 'muted' }, 'Studio float (owned by no product)')), h('td', { class: 'num' }, fmtAmount(p.unallocated)), h('td', {}), h('td', { class: 'num' }, p.total ? `${Math.round((p.unallocated / p.total) * 100)} %` : '–')),
		], 'Nothing booked in this wallet yet.'),
		a ? h('p', { class: 'muted small mt14' }, [`Floor ${floor != null ? fmtAmount(floor) : '–'}`, a.committed ? `${fmtAmount(a.committed)} committed to ${plural(a.committedCount, 'payout')} in flight` : null].filter(Boolean).join(' · ')) : null];
}
function adjustModal(pools, pool) {
	const all = [...new Set([...pools, 'CIV', 'SEN', 'BFA', 'PISPI'])];
	const f = { pool: h('select', {}, all.map((p) => h('option', { value: p, selected: p === pool || null }, `${p}${POOL_NAME[p] ? ` · ${POOL_NAME[p]}` : ''}`))), note: h('input', { maxlength: 200, required: true, placeholder: 'e.g. opening float, pawaPay fees for March' }) };
	const amount = moneyInput({ signed: true, hint: 'Whole FCFA, e.g. 500 000 or -1 200. Positive for money put in, negative for money taken out.' });
	f.amount = amount.input; f.amount.required = true;
	const rules = {
		amount: () => { const n = f.amount.money(); return n == null || Number.isNaN(n) || n === 0 ? 'A whole number of FCFA, not 0: digits and spaces, with a minus for money taken out.' : Math.abs(n) > 1e9 ? 'At most 1 000 000 000 FCFA at a time.' : null; },
		note: () => f.note.value.trim() ? null : 'Say what the money is: it is the only record of why it was booked.',
	};
	onBlurCheck(f.amount, rules.amount); onBlurCheck(f.note, rules.note);
	// what pressing the button will do, in words, so the amount booked is the amount meant
	const summary = h('p', { class: 'adjust-sum', 'aria-live': 'polite' });
	const say = () => { const n = f.amount.money(), pool = f.pool.value;
		put(summary, !n || Number.isNaN(n) ? 'Enter an amount to see what will be booked.' : n > 0 ? ['Adds ', h('strong', {}, fmtAmount(n)), ` to ${pool} unallocated.`] : ['Takes ', h('strong', {}, fmtAmount(-n)), ` out of ${pool} unallocated.`]); };
	f.amount.addEventListener('input', say); f.pool.addEventListener('change', say); say();
	const err = h('div');
	const m = overlay([h('h2', {}, 'Book an adjustment'), h('p', { class: 'muted' }, 'Money in a wallet that belongs to no product: positive for float the studio put in, negative for fees or losses taken out. It cannot be edited later; book the opposite to undo it.'),
		field('Pool', f.pool, 'The country wallet, or the PI-SPI account, the money sits in.'), field('Amount', f.amount, amount.hint), field('What is it', f.note, 'Required. Kept with the posting.'), summary, err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: (e) => {
			if (!check([[f.amount, rules.amount()], [f.note, rules.note()]])) return;
			return act(e, async () => {
				await api('POST', '/admin/ledger/adjustments', { pool: f.pool.value, amount: f.amount.money(), note: f.note.value }); m.close(); toast('Booked'); reloadPage();
			}, { busy: 'Booking…', errorIn: err, onError: fieldFor({ invalid_pool: f.pool, invalid_amount: f.amount, invalid_note: f.note }) });
		} }, 'Book it'))], { center: true, dirty: () => !!(f.amount.value.trim() || f.note.value.trim()) });
	f.amount.focus();
}
/** "2 000 000" or "-1 200" (any kind of space allowed) as a number: null when empty, NaN when it is not a whole amount. */
const parseMoney = (v, signed = false) => { const s = String(v).replace(/[\s\u00a0\u202f]/g, ''); if (!s) return null; return (signed ? /^-?\d{1,13}$/ : /^\d{1,13}$/).test(s) ? Number(s) : NaN; };
/**
 * An amount of money in whole FCFA. A text input, not type="number": a scroll wheel over it must never change an amount, and "1e5", "-" or
 * "." are not amounts. Digits and spaces, a leading minus only when `signed`. The hint repeats the value as it will be read, grouped.
 */
function moneyInput({ value = null, signed = false, hint }) {
	const input = h('input', { type: 'text', inputmode: signed ? 'text' : 'numeric', autocomplete: 'off', spellcheck: 'false', value: value == null ? '' : fmtAmount(value).replace(/ FCFA$/, '') });
	const echo = h('strong');
	const show = () => { const n = parseMoney(input.value, signed); put(echo, n == null || Number.isNaN(n) ? '' : ` = ${signed && n > 0 ? '+' : ''}${fmtAmount(n)}`); };
	input.addEventListener('input', show); show();
	input.money = () => parseMoney(input.value, signed);
	return { input, hint: h('small', { class: 'hint' }, hint, echo) };
}
/** For act(): puts a server error that names a field under that field. `map` is { code: control } or a function of the error. */
const fieldFor = (map) => (x) => { const el = typeof map === 'function' ? map(x) : map[x.code]; if (!el) return false; check([[el, x.message]]); return true; };

function pspSection(p, rows) {
	const { inn, out, open, bad } = pspStats(rows);
	const kpi = (label, value, sub, warn) => h('div', { class: 'kpi' }, h('div', { class: 'pl' }, label), h('div', { class: `kv-big${warn ? ' bad-text' : ''}` }, value), h('div', { class: 'ps' }, sub));

	// within a country, channels with the same collection and payout terms share one row: their logos stack, the limits show once
	const groups = [];
	for (const c of p.channels || []) {
		const key = `${c.country}|${JSON.stringify(c.collect)}|${JSON.stringify(c.payout)}|${c.operator === 'bank' ? c.code : 'mm'}`;
		const g = groups.find((x) => x.key === key);
		if (g) g.items.push(c); else groups.push({ key, country: c.country, items: [c] });
	}
	const logo = (c) => h('img', { class: 'logo', src: `/providers/${c.operator === 'bank' ? 'pispi' : c.operator}.png`, alt: '', title: chName(c), width: 22, height: 22 });
	const channels = p.channels
		? h('table', { class: 'ch' }, h('thead', {}, h('tr', {}, h('th', {}, 'Country'), h('th', {}, 'Channels'), h('th', {}, 'Collections'), h('th', {}, 'Payouts'))),
			h('tbody', {}, groups.map((g, i) => {
				const c = g.items[0], first = !i || groups[i - 1].country !== g.country;
				return h('tr', { class: i && first ? 'grp' : null },
					h('td', {}, first ? h('span', { class: 'chan' }, flag(g.country), COUNTRY[g.country]?.[1] || g.country) : null),
					h('td', {}, h('span', { class: 'chan' }, h('span', { class: 'stack' }, g.items.map(logo)), g.items.map(chName).join(', '))),
					h('td', {}, chOp(c.collect)), h('td', {}, c.operator === 'bank' && !c.payout ? h('span', { class: 'muted small' }, 'Not offered') : chOp(c.payout)));
			})))
		: h('div', { class: 'alert bad' }, `Could not read the channel configuration: ${p.channelsError}`);

	// receiving aliases are configuration, so they stay here; wallet balances, floors and cover are on Wallets
	const aliases = p.accounts.filter((a) => a.kind === 'alias'), wallets = p.accounts.length - aliases.length;
	const alias = (a) => h('div', { class: 'acct' }, h('div', { class: 'acct-top' }, h('span', { class: 'chan' }, flag(a.country), a.label), h('span', { class: 'badge s-info' }, 'collections in')),
		h('code', { class: 'acct-val' }, a.value), a.participant ? h('div', { class: 'muted small' }, `Participant ${a.participant}`) : null);
	const side = p.id === 'pispi' || aliases.length;

	return h('section', { class: `psp${p.active ? '' : ' off'}` },
		p.notes.length ? h('div', { class: 'psp-notes' }, p.notes.map((n) => h('span', { class: 'tag' }, n))) : null,
		h('div', { class: 'kpis' }, kpi('Collected', fmtAmount(inn.amount), plural(inn.n, 'payment')), kpi('Paid out', fmtAmount(out.amount), plural(out.n, 'payment')),
			kpi('In progress', String(open.n), 'waiting'), kpi('Failed / unknown', String(bad.n), 'last 24 h', bad.n > 0)),
		h('div', { class: `psp-body${side ? '' : ' one'}` },
			h('div', { class: 'panel' }, h('h2', {}, 'Channels'), channels,
				wallets ? h('p', { class: 'muted small mt14 mb0' }, `Money is paid out from ${plural(wallets, 'wallet')}: balances, floors and cover are on `, h('a', { class: 'link', href: '#/wallets' }, 'Wallets'), '.') : null),
			side ? h('div', { class: 'panel' }, h('h2', {}, 'Accounts'),
				aliases.length ? h('div', { class: 'accts' }, aliases.map(alias)) : null,
				p.accountsNote ? h('p', { class: 'muted small m0' }, p.accountsNote) : null) : null));
}

// ---- payments -------------------------------------------------------------------------------------------------------------------
function paymentsTable(rows) {
	return table([{ label: 'When' }, { label: 'Tenant' }, { label: 'Type' }, { label: 'PSP' }, { label: 'Channel' }, { label: 'Origin' }, { label: 'Reference' }, { label: 'Counterparty' }, { label: 'Amount', num: true }, { label: 'Status' }],
		rows.map((p) => h('tr', { class: 'click', tabindex: 0, 'data-key': `payment:${p.id}`, onclick: () => paymentDrawer(p.id), onkeydown: (e) => { if (e.key === 'Enter') paymentDrawer(p.id) } },
			h('td', { title: fmtTime(p.createdAt) }, ago(p.createdAt)), h('td', {}, tenantChip(p.tenant)), h('td', {}, p.object === 'collection' ? '↓ in' : '↑ out'), h('td', {}, pspBadge(p)), h('td', {}, h('span', { class: 'chan' }, icon(p), channel(p))), h('td', {}, origin(p)),
			h('td', { class: 'mono' }, p.reference), h('td', { class: 'mono' }, p.counterparty || '–'), h('td', { class: 'num' }, fmtAmount(p.amount)), h('td', {}, badge(p.status)))),
		'No payments match.');
}
async function payments(main) {
	const q = new URLSearchParams(location.hash.split('?')[1] || '');
	const sel = (name, opts) => { const s = h('select', { 'aria-label': name === 'kind' ? 'Direction' : 'Status' }, opts.map(([v, l]) => h('option', { value: v, selected: q.get(name) === v ? true : null }, l))); return s; };
	const status = sel('status', [['', 'Any status'], ['processing', 'Processing'], ['unknown', 'Unknown'], ['completed', 'Completed'], ['failed', 'Failed'], ['expired', 'Expired']]);
	const kind = sel('kind', [['', 'In and out'], ['collection', 'Collections (in)'], ['disbursement', 'Disbursements (out)']]);
	const tenant = tenantSelect(q.get('tenant') || '');
	const find = h('input', { placeholder: 'Find a payment id…', 'aria-label': 'Open payment by id', size: 24 });
	const apply = () => { const p = filters(); history.replaceState(null, '', `#/payments${p.size ? '?' + p : ''}`); load(); };
	for (const el of [status, kind, tenant]) el.addEventListener('change', apply);
	find.addEventListener('keydown', (e) => { if (e.key === 'Enter' && find.value.trim()) paymentDrawer(find.value.trim()) });
	const filters = () => { const p = new URLSearchParams(); if (status.value) p.set('status', status.value); if (kind.value) p.set('kind', kind.value); if (tenant.value.trim()) p.set('tenant', tenant.value.trim()); return p };
	const list = pager({ noun: 'payments',
		fetch: (before, size) => { const p = filters(); p.set('limit', size); if (before) p.set('before', before); return api('GET', `/admin/payments?${p}`) },
		render: (rows) => paymentsTable(rows),
		skeleton: (n) => skTable(['When', 'Tenant', 'Type', 'PSP', 'Channel', 'Origin', 'Reference', 'Counterparty', 'Amount', 'Status'], n) });
	// headline numbers for the same tenant and direction (not status: the tiles are the breakdown by status)
	const kpis = h('div', { class: 'mb20' }, skTiles());
	const loadKpis = async () => {
		const p = new URLSearchParams(); if (kind.value) p.set('kind', kind.value); if (tenant.value.trim()) p.set('tenant', tenant.value.trim());
		try {
			const k = await api('GET', `/admin/payments/stats?${p}`);
			put(kpis, h('div', { class: 'tiles' },
				tile('Completed (24 h)', `${compact(k.completed.amount)} FCFA`, plural(k.completed.n, 'payment')),
				tile('Success rate (24 h)', k.successRate === null ? '–' : `${k.successRate}%`, k.settled ? `${k.completed.n} of ${k.settled} finished` : 'nothing finished yet'),
				tile('In progress', String(k.processing.n), k.processing.n ? `${fmtAmount(k.processing.amount)} waiting` : 'nothing open'),
				tile('Needs a person', String(k.unknown.n), k.unknown.n ? `${fmtAmount(k.unknown.amount)} with an unknown outcome` : 'no unknown payouts', k.unknown.n ? 'bad' : null)));
		} catch (e) { if (e instanceof AuthError || e instanceof NotOperator) throw e; put(kpis); }
	};
	const load = () => Promise.all([list.reset(), loadKpis()]);
	pageReload = () => Promise.all([list.refresh(), loadKpis()]);
	put(main, head('Payments', null, refreshButton()), kpis, h('div', { class: 'bar' }, status, kind, tenant, h('span', { class: 'grow' }), find), list.el);
	await load();
}
async function paymentDrawer(id) {
	const d = overlay(skDrawer(), { label: 'Payment' });
	const render = (p) => {
		const resolvable = p.status === 'processing' || p.status === 'unknown' ? ['completed', 'failed'] : p.status === 'failed' || p.status === 'expired' ? ['completed'] : [];
		const row = (k, v) => v == null || v === '' ? null : [h('dt', {}, k), h('dd', {}, v)];
		d.fill(
			h('div', { class: 'bar' }, h('h1', { class: 'grow mono t16' }, p.id), badge(p.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			p.status === 'unknown' ? h('div', { class: 'alert bad' }, 'The outcome of this payout is unknown. Check the provider dashboard for the money before deciding.') : null,
			h('div', { class: 'card' }, h('dl', { class: 'kv' },
				row('Tenant', tenantChip(p.tenant)), row('Type', p.object), row('Reference', h('span', { class: 'mono' }, p.reference)), row('PSP partner', pspBadge(p)), row(p.rail === 'mobile_money' ? 'Channel (MNO)' : 'Channel', h('span', { class: 'chan' }, icon(p), channel(p))), row('Rail', p.rail), row('Origin', COUNTRY[p.country] ? h('span', { class: 'chan' }, origin(p), COUNTRY[p.country][1]) : null), row('Amount', fmtAmount(p.amount)), row('Counterparty', h('span', { class: 'mono' }, p.counterparty || '')),
				row('PSP payment id', h('span', { class: 'mono' }, p.providerId || '')), row('PSP settlement ref', h('span', { class: 'mono' }, p.providerRef || '')),
				row('Created', fmtTime(p.createdAt)), row('Expires', p.expiresAt ? fmtTime(p.expiresAt) : null), row('Settled', p.settledAt ? fmtTime(p.settledAt) : null), row('Attempts', String(p.attempts)),
				row('Failure shown', p.failure), row('Failure detail', p.failureDetail), row('Metadata', p.metadata ? h('pre', {}, JSON.stringify(p.metadata, null, 2)) : null))),
			resolvable.length ? h('div', { class: 'actions mb16' }, h('button', { class: 'btn primary', onclick: () => resolveModal(p, resolvable, async (np) => { render({ ...np, events: (await api('GET', `/admin/payments/${p.id}`)).events }); }) }, 'Resolve manually…')) : null,
			h('h2', {}, 'History'),
			h('ul', { class: 'timeline' }, p.events.map((e) => h('li', {}, h('strong', {}, e.type), e.type === 'late_completion' ? h('span', { class: 'badge late ml8' }, 'late') : null, ' ', h('span', { class: 'muted' }, `by ${e.actor}`), e.detail ? h('div', {}, e.detail) : null, h('div', { class: 't' }, fmtTime(e.created_at))))));
	};
	try { render(await api('GET', `/admin/payments/${encodeURIComponent(id)}`)) } catch (e) { d.fill(h('h2', {}, 'Payment'), h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function resolveModal(p, outcomes, done) {
	const outcome = h('select', {}, outcomes.map((o) => h('option', { value: o }, o === 'completed' ? 'Completed: the money moved' : 'Failed: the money did not move')));
	const note = h('textarea', { rows: 3, maxlength: 300, required: true, placeholder: 'e.g. Confirmed in the pawaPay dashboard, payout PAID' });
	const err = h('div');
	const m = overlay([h('h2', {}, 'Resolve payment'), h('p', { class: 'muted' }, 'This overrides the gateway and notifies the tenant by webhook. It cannot be undone.'),
		field('Outcome', outcome), field('What you checked', note, 'Required. It is kept in the payment history and shown to other operators.'), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
			h('button', { class: 'btn primary', onclick: (e) => {
				if (!check([[note, note.value.trim() ? null : 'Say what you checked before resolving.']])) return;
				return act(e, async () => { const np = await api('POST', `/admin/payments/${p.id}/resolve`, { outcome: outcome.value, note: note.value }); m.close(); toast('Resolved'); await done(np); }, { busy: 'Resolving…', errorIn: err });
			} }, 'Resolve'))], { center: true, dirty: () => !!note.value.trim() });
}

// ---- tenants --------------------------------------------------------------------------------------------------------------------
async function tenants(main) {
	await loadTenants(true);
	const data = [...TENANTS.values()];
	put(main, head('Tenants', 'The products that use this gateway.', h('button', { class: 'btn primary', onclick: () => tenantForm(null, data.map((t) => t.id)) }, 'New tenant')),
		table([{ label: 'Name' }, { label: 'Id' }, { label: 'Status' }, { label: 'Webhook' }, { label: 'Max payment', num: true }, { label: 'Created' }],
			data.map((t) => h('tr', { class: 'click', tabindex: 0, 'data-key': `tenant:${t.id}`, onclick: () => tenantDrawer(t.id), onkeydown: (e) => { if (e.key === 'Enter') tenantDrawer(t.id) } },
				h('td', {}, h('span', { class: 'chan' }, tenantMark(t, 28), h('strong', {}, t.name))), h('td', { class: 'mono' }, t.id), h('td', {}, badge(t.status)), h('td', { class: 'mono' }, t.webhook_url || '–'), h('td', { class: 'num' }, t.max_amount ? fmtAmount(t.max_amount) : 'default'), h('td', {}, fmtTime(t.created_at)))),
			'No tenants yet. Create one for each product that will use Paygate.'));
}
const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
/** "Côte Pay Shop" -> "cote-pay-shop": what the server accepts as a tenant id, made unique among `taken`. */
function slugFor(name, taken) {
	const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28).replace(/-+$/, '');
	if (base.length < 2) return '';
	let id = base;
	for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
	return id;
}

/** An uploaded image as a 128 px square logo (contained, transparent around), WebP or else PNG: small enough to store with the tenant. */
async function shrinkLogo(file) {
	if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
	const src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('The file could not be read.')); r.readAsDataURL(file); });
	const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('This image could not be opened.')); i.src = src; });
	const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
	const k = Math.min(S / img.naturalWidth, S / img.naturalHeight), w = img.naturalWidth * k, ht = img.naturalHeight * k;
	c.getContext('2d').drawImage(img, (S - w) / 2, (S - ht) / 2, w, ht);
	let out = c.toDataURL('image/webp', 0.9);
	if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
	if (out.length > 60_000) throw new Error('This image is too detailed. Try a simpler one.');
	return out;
}

function tenantForm(t, taken = [], { onSaved } = {}) {
	const f = { id: h('input', { value: t?.id || '', disabled: t ? true : null, required: true, spellcheck: 'false', autocomplete: 'off' }),
		name: h('input', { value: t?.name || '', maxlength: 80, required: true, placeholder: t ? null : 'e.g. Courtly', autocomplete: 'off' }),
		webhook: h('input', { type: 'url', value: t?.webhook_url || '', placeholder: 'https://example.com/paygate/webhook' }), 
		ns: h('input', { value: '', spellcheck: 'false' }),
		key: h('input', { type: 'checkbox', checked: true }) };
	const maxIn = moneyInput({ value: t?.max_amount ?? null, hint: 'Whole FCFA. Leave it empty to use the gateway default.' });
	f.max = maxIn.input;
	const snap = () => [f.id, f.name, f.webhook, f.max, f.ns].map((x) => x.value).join('\u0000'), start = snap();
	const err = h('div'), idHint = h('small', { class: 'hint' });
	const rules = {
		name: () => f.name.value.trim() ? null : 'Give the product a name.',
		id: () => { const v = f.id.value.trim(); return !v ? 'Choose an id.' : !SLUG.test(v) ? 'Start with a letter; 2 to 32 lowercase letters, digits or dashes.' : taken.includes(v) ? 'A tenant already has this id.' : null; },
		webhook: () => {
			const v = f.webhook.value.trim();
			if (!v) return null;
			try { const u = new URL(v); if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null; } catch { /* not a URL */ }
			return 'Use a full https:// address, e.g. https://example.com/paygate/webhook.';
		},
		max: () => { const n = f.max.money(); return n == null || n >= 100 ? null : 'A whole number of FCFA, at least 100: digits and spaces only. Leave it empty to use the gateway default.'; },
	};
	// the logo: undefined = unchanged, null = removed, a data: URL = new
	let logo, current = t?.logo || null;
	const preview = h('span', { class: 'logo-preview' }), remove = h('button', { class: 'btn sm', type: 'button' }, 'Remove'), pickLabel = h('span');
	const showLogo = () => { put(preview, tenantMark({ id: f.id.value || t?.id, name: f.name.value || t?.name, logo: current }, 56)); remove.hidden = !current; put(pickLabel, current ? 'Change' : 'Upload'); };
	const pick = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only' });
	pick.addEventListener('change', async () => {
		const file = pick.files?.[0]; pick.value = '';
		if (!file) return;
		try { logo = current = await shrinkLogo(file); setError(pick, null); showLogo(); } catch (x) { check([[pick, x.message]]); }
	});
	remove.addEventListener('click', () => { logo = null; current = null; showLogo(); });
	const logoHint = h('small', { class: 'hint', id: uid('h') }, 'Optional. PNG, JPEG or WebP, shown at 128 px.'), logoErr = h('small', { class: 'field-err', id: uid('e'), hidden: true }), logoLabel = h('span', { class: 'lbl', id: uid('l') }, 'Logo');
	ERR.set(pick, logoErr);
	pick.setAttribute('aria-describedby', `${logoHint.id} ${logoErr.id}`);
	const logoField = h('div', { class: 'field', role: 'group', 'aria-labelledby': logoLabel.id }, logoLabel,
		h('div', { class: 'logo-pick' }, preview, h('label', { class: 'btn sm' }, pickLabel, pick), remove), logoHint, logoErr);
	// the id follows the name until someone types in it; the hint says whether it is free
	let idTouched = false;
	const checkId = () => {
		const v = f.id.value.trim(), bad = rules.id();
		setError(f.id, v && bad ? bad : null);
		put(idHint, v && !bad ? [h('code', {}, v), ' is free. It cannot be changed later.'] : 'Lowercase letters, digits and dashes, made from the name. It cannot be changed later.');
	};
	if (!t) {
		f.name.addEventListener('input', () => { if (!idTouched) { f.id.value = slugFor(f.name.value, taken); checkId() } if (!current) showLogo(); });
		f.id.addEventListener('input', () => { idTouched = f.id.value !== ''; f.id.value = f.id.value.toLowerCase(); checkId() });
	}
	onBlurCheck(f.name, rules.name); onBlurCheck(f.webhook, rules.webhook); onBlurCheck(f.max, rules.max);
	// what the server says about a field goes under that field
	const serverField = fieldFor((x) => ({ tenant_exists: t ? null : f.id, invalid_tenant: /^id\b/.test(x.message) ? (t ? null : f.id) : f.name, invalid_webhook_url: f.webhook, invalid_max_amount: f.max, invalid_id_namespace: f.ns, invalid_logo: pick, logo_too_large: pick })[x.code]);
	const save = h('button', { class: 'btn primary', onclick: (e) => {
		if (!check([[f.name, rules.name()], ...(t ? [] : [[f.id, rules.id()]]), [f.webhook, rules.webhook()], [f.max, rules.max()]])) return;
		return act(e, async () => {
			const max = f.max.money(), wh = f.webhook.value.trim() || null;
			if (t) { await api('PATCH', `/admin/tenants/${t.id}`, { name: f.name.value, webhookUrl: wh, maxAmount: max, ...(logo !== undefined ? { logo } : {}) }); m.close(); toast('Saved'); await onSaved?.(); reloadPage(); return; }
			const id = f.id.value.trim();
			await api('POST', '/admin/tenants', { id, name: f.name.value, webhookUrl: wh, maxAmount: max, idNamespace: f.ns.value.trim() || null, logo: logo || null });
			m.close(); reloadPage();
			if (f.key.checked) await connectModal(id); else tenantDrawer(id);
		}, { busy: t ? 'Saving…' : 'Creating…', errorIn: err, onError: serverField });
	} }, t ? 'Save' : 'Create tenant');
	const m = overlay([h('h2', {}, t ? `Edit ${t.id}` : 'New tenant'), field('Name', f.name), t ? null : field('Id', f.id, idHint), logoField,
		field('Webhook URL', f.webhook, 'Where payment events are sent. https only; it can be added later.'), field('Max single payment', f.max, maxIn.hint),
		t ? null : h('label', { class: 'check mt14' }, f.key, 'Create an API key and show the webhook secret now'),
		t ? null : h('details', { class: 'adv' }, h('summary', {}, 'Advanced'), field('ID namespace', f.ns, 'Only for a product moved from another gateway: keeps its provider ids unchanged. Leave it empty for a new product.')), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save)], { center: true, dirty: () => logo !== undefined || snap() !== start });
	if (!t) checkId();
	showLogo();
	f.name.focus();
}

/** Everything a new product needs to connect, in one place: its API key (shown once) and its webhook secret. */
async function connectModal(id) {
	let key, secret;
	try { [key, secret] = await Promise.all([api('POST', `/admin/tenants/${id}/keys`, { label: 'default' }), api('GET', `/admin/tenants/${id}/webhook-secret`)]) }
	catch (x) { toast(`Tenant created, but the key or secret could not be fetched: ${x.message}. Create a key from the tenant.`, { error: true }); return tenantDrawer(id) }
	const row = (label, value, note) => [h('label', {}, label, note ? h('small', {}, ` ${note}`) : null), h('div', { class: 'copyrow' }, h('code', { class: 'secret' }, value), h('button', { class: 'btn sm', onclick: () => copy(value) }, 'Copy'))];
	const m = overlay([h('h2', {}, `${id} is ready to connect`), h('p', { class: 'muted' }, 'Give these to the product. The API key is shown only this once: only its hash is stored.'),
		row('API key', key.key, '(Authorization: Bearer …)'), row('Webhook signing secret', secret.secret, '(can be shown again)'),
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { m.close(); tenantDrawer(id) } }, 'Open tenant'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'))], { center: true });
}
async function tenantDrawer(id) {
	const d = overlay(skDrawer(), { label: 'Tenant' });
	const render = async () => {
		const [t, keys, books] = await Promise.all([api('GET', `/admin/tenants/${id}`), api('GET', `/admin/tenants/${id}/keys`), api('GET', '/admin/ledger').catch(() => null)]);
		const owns = (books?.pools || []).flatMap((p) => p.tenants.filter((x) => x.tenant === id).map((x) => ({ pool: p.pool, ...x })));
		d.fill(
			h('div', { class: 'bar' }, tenantMark(t, 44), h('h1', { class: 'grow' }, t.name), badge(t.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'Id'), h('dd', { class: 'mono' }, t.id), h('dt', {}, 'Webhook'), h('dd', { class: 'mono' }, t.webhook_url || '–'), h('dt', {}, 'Max payment'), h('dd', {}, t.max_amount ? fmtAmount(t.max_amount) : 'gateway default'),
				h('dt', {}, 'Secret version'), h('dd', {}, String(t.webhook_version)), h('dt', {}, 'Created'), h('dd', {}, fmtTime(t.created_at)),
				books ? [h('dt', {}, 'Holds'), h('dd', {}, owns.length ? owns.map((x) => h('div', {}, h('strong', { class: x.available < 0 ? 'bad-text' : null }, fmtAmount(x.available)), ` in ${x.pool}`, x.held ? h('span', { class: 'muted' }, ` · ${fmtAmount(x.held)} held`) : null)) : h('span', { class: 'muted' }, 'nothing yet'))] : null)),
			h('div', { class: 'actions left mb20' },
				h('button', { class: 'btn', 'data-key': 'edit', onclick: () => tenantForm(t, [], { onSaved: render }) }, 'Edit'),
				h('button', { class: `btn${t.status === 'active' ? ' danger' : ''}`, 'data-key': 'status', onclick: (e) => {
					const go = async () => { await api('PATCH', `/admin/tenants/${id}`, { status: t.status === 'active' ? 'suspended' : 'active' }); await render(); reloadPage(); };
					return t.status === 'active' ? confirmModal('Suspend tenant?', `${t.name} will be refused on every API call until you reactivate it. Payments already in flight still settle.`, 'Suspend', go) : act(e, go, { busy: 'Reactivating…' });
				} }, t.status === 'active' ? 'Suspend' : 'Reactivate')),
			h('div', { class: 'bar' }, h('h2', { class: 'grow m0' }, 'API keys'), h('button', { class: 'btn sm primary', 'data-key': 'new-key', onclick: () => newKey(id, render) }, 'New key')),
			table([{ label: 'Key' }, { label: 'Label' }, { label: 'Last used' }, { label: h('span', { class: 'sr-only' }, 'Actions') }],
				keys.data.map((k) => h('tr', {}, h('td', { class: 'mono' }, `pgk_${k.id}_…`), h('td', {}, k.label || '–'), h('td', {}, k.revoked_at ? badge('dead') : ago(k.last_used_at)),
					h('td', {}, k.revoked_at ? h('span', { class: 'muted' }, 'revoked') : h('button', { class: 'btn sm danger', onclick: () => confirmModal('Revoke key?', `pgk_${k.id}_… stops working immediately. Anything still using it will get 401.`, 'Revoke', async () => { await api('DELETE', `/admin/tenants/${id}/keys/${k.id}`); await render(); }) }, 'Revoke')))),
				'No keys yet.'),
			h('h2', { class: 'mt22' }, 'Webhook signing secret'),
			h('div', { class: 'actions left mt0' },
				h('button', { class: 'btn', 'data-key': 'reveal', onclick: (e) => act(e, async () => { const s = await api('GET', `/admin/tenants/${id}/webhook-secret`); secretModal(`Webhook secret (v${s.version})`, 'Give this to the product so it can verify webhooks. Treat it like a password.', s.secret); }, { busy: 'Revealing…' }) }, 'Reveal'),
				h('button', { class: 'btn danger', 'data-key': 'rotate', onclick: () => confirmModal('Rotate signing secret?', 'Webhooks are signed with the new secret immediately. The product must update its secret first, or it will reject events.', 'Rotate', async () => { const s = await api('POST', `/admin/tenants/${id}/webhook-secret`); secretModal(`New webhook secret (v${s.version})`, 'Give this to the product now.', s.secret); await render(); }) }, 'Rotate…')));
	};
	try { await render() } catch (e) { d.fill(h('h2', {}, 'Tenant'), h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function newKey(tenantId, after) {
	const label = h('input', { maxlength: 80, placeholder: 'e.g. production backend' }), err = h('div');
	const m = overlay([h('h2', {}, 'New API key'), field('Label', label, 'Optional: where the key will be used, so you know which one to revoke.'), err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn primary', onclick: (e) => act(e, async () => {
			const k = await api('POST', `/admin/tenants/${tenantId}/keys`, { label: label.value.trim() || undefined }); m.close(); secretModal('API key created', 'Copy it now. Only its hash is stored, so it cannot be shown again.', k.key); await after();
		}, { busy: 'Creating…', errorIn: err }) }, 'Create'))], { center: true });
}

// ---- failed webhooks ------------------------------------------------------------------------------------------------------------
// ---- events ---------------------------------------------------------------------------------------------------------------------
// One feed: payment status changes, provider callbacks in, webhooks out. Bodies are untrusted and only ever shown as text.
const SOURCE = { payment: ['Payment', '●'], callback: ['Callback in', '↘'], webhook: ['Webhook out', '↗'] };
const dayLabel = (ms) => { const d = new Date(ms), t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
	return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const payLink = (id) => id ? h('a', { class: 'mono', href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); paymentDrawer(id) } }, id) : null;
const who = (actor) => !actor ? null : actor.startsWith('admin:') ? `by operator ${actor.slice(6) === 'operator' ? '(admin key)' : actor.slice(6)}` : `by ${actor}`;

function feedItem(e, { compact = false, onChange } = {}) {
	const [label, glyph] = SOURCE[e.source];
	let title, meta;
	if (e.source === 'payment') {
		title = [`${e.kind === 'disbursement' ? 'Payout' : 'Collection'} ${e.type.replace(/_/g, ' ')}`, e.amount != null ? h('span', { class: 'muted' }, ` · ${fmtAmount(e.amount)}`) : null];
		meta = [tenantChip(e.tenant), payLink(e.paymentId), who(e.actor), e.detail];
	} else if (e.source === 'callback') {
		title = [pspLogo(e.provider), `${PSP[e.provider] || e.provider} callback `, h('span', { class: 'mono' }, e.type)];
		meta = [e.status === 'accepted' ? 'Signature and shape accepted' : 'Rejected: failed the signature or shape check'];
	} else {
		title = [h('span', { class: 'mono' }, e.type), ' to ', tenantChip(e.tenant)];
		meta = [payLink(e.paymentId), e.attempts ? plural(e.attempts, 'attempt') : 'not sent yet', e.detail];
	}
	const retry = e.source === 'webhook' && e.status !== 'delivered' && !compact
		? h('button', { class: 'btn sm', onclick: (ev) => act(ev, async () => { await api('POST', `/admin/webhooks/${e.id}/retry`); toast('Queued for delivery'); onChange?.() }, { busy: 'Queuing…' }) }, e.status === 'dead' ? 'Retry' : 'Send now')
		: null;
	const body = !compact && e.body ? h('details', { class: 'ev-body' }, h('summary', {}, e.source === 'callback' ? 'Body as received' : 'Payload'), h('pre', {}, pretty(e.body))) : null;
	return h('li', { class: `ev${e.problem ? ' problem' : ''}` },
		h('time', { class: 'ev-time', datetime: new Date(e.at).toISOString(), title: fmtTime(e.at) }, compact ? ago(e.at) : clock(e.at)),
		e.source === 'payment' && compact ? avatar(e) : h('span', { class: `src src-${e.source}`, title: label }, h('span', { 'aria-hidden': 'true' }, glyph), compact ? null : ` ${label}`),
		h('div', { class: 'ev-main' }, h('div', { class: 'ev-title' }, title), h('div', { class: 'ev-meta' }, meta.filter(Boolean).flatMap((m, i) => i ? [' · ', m] : [m])), body),
		h('div', { class: 'ev-side' }, h('span', { class: `badge s-${e.source === 'callback' ? (e.problem ? 'failed' : 'ok') : e.status}` }, e.type === 'late_completion' ? 'late' : e.status.replace(/_/g, ' ')), retry));
}

function feedList(items, opts = {}) {
	if (!items.length) return h('div', { class: 'card empty' }, opts.compact ? 'Nothing has happened yet.' : 'No events match.');
	if (opts.compact) return h('ul', { class: 'feed compact' }, items.map((e) => feedItem(e, opts)));
	const out = []; let day = null;
	for (const e of items) { const d = dayLabel(e.at); if (d !== day) { day = d; out.push(h('li', { class: 'day' }, d)) } out.push(feedItem(e, opts)) }
	return h('ul', { class: 'feed' }, out);
}

async function events(main) {
	const q = new URLSearchParams(location.hash.split('?')[1] || '');
	let source = ['payment', 'callback', 'webhook'].includes(q.get('source')) ? q.get('source') : '';
	const problems = h('input', { type: 'checkbox', checked: q.get('problems') === '1' ? true : null });
	const tenant = tenantSelect(q.get('tenant') || '');
	const payment = h('input', { placeholder: 'Payment id', value: q.get('payment') || '', 'aria-label': 'Payment id', size: 22 });
	const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Source' });
	const drawSeg = () => put(seg, [['', 'All'], ['payment', 'Payments'], ['callback', 'Callbacks in'], ['webhook', 'Webhooks out']].map(([v, l]) =>
		h('button', { type: 'button', 'aria-pressed': String(source === v), onclick: () => { source = v; drawSeg(); apply() } }, l)));
	drawSeg();

	const params = () => { const p = new URLSearchParams(); if (source) p.set('source', source); if (problems.checked) p.set('problems', '1'); if (tenant.value.trim()) p.set('tenant', tenant.value.trim()); if (payment.value.trim()) p.set('payment', payment.value.trim()); return p };
	const list = pager({ noun: 'events',
		fetch: (before, size) => { const p = params(); p.set('limit', size); if (before) p.set('before', before); return api('GET', `/admin/events?${p}`) },
		render: (items) => [source === 'callback' && (tenant.value.trim() || payment.value.trim()) ? h('p', { class: 'muted small' }, 'Provider callbacks belong to no tenant or payment, so those filters hide them.') : null,
			feedList(items, { onChange: () => list.refresh() })],
		skeleton: (n) => skFeed(n) });
	const load = list.reset;
	const apply = () => { const p = params(); history.replaceState(null, '', `#/events${p.size ? '?' + p : ''}`); load(); };
	problems.addEventListener('change', apply); tenant.addEventListener('change', apply); payment.addEventListener('change', apply);

	pageReload = () => list.refresh();
	put(main, head('Events', 'Everything that happened, newest first: payment status changes, provider callbacks in, and webhooks out to products.', refreshButton()),
		h('div', { class: 'bar' }, seg, h('label', { class: 'check' }, problems, 'Needs attention'), h('span', { class: 'grow' }), tenant, payment), list.el);
	await load();
}

start();
