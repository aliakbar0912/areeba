'use strict';
/* Shifa License Panel — dependency-free SPA */
(() => {
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; e.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return e;
};
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDay = (ms) => ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Lifetime';
const ago = (ms) => { if (!ms) return '—'; const s = (Date.now() - ms) / 1000; if (s < 60) return 'abhi'; if (s < 3600) return Math.floor(s / 60) + ' min pehle'; if (s < 86400) return Math.floor(s / 3600) + ' ghante pehle'; return Math.floor(s / 86400) + ' din pehle'; };

const ICON = {
  dash: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
  key: '<path d="M14 2a7 7 0 0 0-6.7 9L2 16.3V22h5.7l.8-.8V19h2v-2h2l1.2-1.2A7 7 0 1 0 14 2Zm3.5 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>',
  update: '<path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z"/>',
  audit: '<path d="M4 3h16v4H4V3Zm0 7h16v4H4v-4Zm0 7h10v4H4v-4Z"/>',
  gear: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2l-.4-2.6H9.9l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 3 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h4.2l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  logout: '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm7 4-1.4 1.4L17 10H9v2h8l-1.4 1.6L17 15l4-4-4-4Z"/>',
  menu: '<path d="M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/>',
  search: '<path d="m21 20-5.2-5.2a7 7 0 1 0-1.4 1.4L19.6 21 21 20ZM5 10a5 5 0 1 1 10 0A5 5 0 0 1 5 10Z"/>',
};
const svg = (p, cls = '') => { const s = `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor">${p}</svg>`; const d = h('span'); d.innerHTML = s; return d.firstChild; };

// ---------- state + api ----------
const S = { me: null, csrf: null, view: 'dash', sideOpen: false };
async function api(method, path, body, { raw } = {}) {
  const opt = { method, headers: {} };
  if (S.csrf && method !== 'GET') opt.headers['X-CSRF-Token'] = S.csrf;
  if (body != null) {
    if (raw) { opt.body = body; }
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opt);
  let j = null; try { j = await res.json(); } catch {}
  if (res.status === 401 && S.me) { S.me = null; render(); }
  if (!res.ok) throw Object.assign(new Error((j && j.error) || res.statusText), { code: j && j.code, status: res.status });
  return j;
}

// ---------- toasts ----------
const toastWrap = h('div', { class: 'toast-wrap' });
function toast(msg, kind = 'ok') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastWrap.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(16px)'; setTimeout(() => t.remove(), 250); }, 3200);
}

// ---------- modal ----------
function modal(title, bodyNode, footNodes) {
  const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(); } });
  const close = () => ov.remove();
  const m = h('div', { class: 'modal' },
    h('div', { class: 'hd' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close }, '✕')),
    h('div', { class: 'bd' }, bodyNode),
    footNodes && h('div', { class: 'ft' }, footNodes));
  ov.append(m); document.body.append(ov);
  return { close, ov };
}
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copy ho gaya'), () => {}); }

// ============================ LOGIN ============================
function Login() {
  const wrap = h('div', { class: 'login-wrap' });
  let needOtp = false;
  const u = h('input', { placeholder: 'admin', autocomplete: 'username' });
  const p = h('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const otp = h('input', { class: 'mono', placeholder: '000000', inputmode: 'numeric', maxlength: 6 });
  const otpField = h('div', { class: 'field hidden' }, h('label', {}, 'Authenticator code'), otp);
  const err = h('div', { class: 'small', style: 'color:var(--bad);min-height:18px' });
  const btn = h('button', { class: 'btn primary', style: 'width:100%;justify-content:center', onclick: submit }, 'Login');

  async function submit() {
    err.textContent = ''; btn.disabled = true; btn.textContent = '';
    btn.append(h('span', { class: 'spin' }));
    try {
      const r = await api('POST', '/api/admin/login', { username: u.value.trim(), password: p.value, otp: otp.value.trim() });
      S.me = { username: r.username, totp_enabled: r.totp_enabled }; S.csrf = r.csrf;
      toast('Welcome, ' + r.username); render();
    } catch (e) {
      if (e.code === 'BAD_OTP' || (needOtp === false && /authenticator/i.test(e.message))) {}
      if (e.code === 'BAD_OTP') { needOtp = true; otpField.classList.remove('hidden'); otp.focus(); }
      // If server requires OTP, reveal the field
      err.textContent = e.message || 'Login fail';
      if (/code/i.test(e.message)) { otpField.classList.remove('hidden'); }
      btn.disabled = false; btn.textContent = 'Login';
    }
  }
  [u, p, otp].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));

  wrap.append(h('div', { class: 'login-card' },
    h('div', { class: 'brand-row' }, h('div', { class: 'logo' }, '+'),
      h('div', {}, h('h1', {}, 'Shifa License Panel'), h('p', {}, 'Medical Store — Admin'))),
    h('div', { class: 'field' }, h('label', {}, 'Username'), u),
    h('div', { class: 'field' }, h('label', {}, 'Password'), p),
    otpField, err, btn,
    h('p', { class: 'small muted center', style: 'margin:16px 0 0' }, 'Sirf authorized admin ke liye.')));
  setTimeout(() => u.focus(), 50);
  return wrap;
}

// ============================ SHELL ============================
const NAVS = [
  ['dash', 'Dashboard', ICON.dash],
  ['licenses', 'Licenses', ICON.key],
  ['updates', 'Updates', ICON.update],
  ['audit', 'Audit Log', ICON.audit],
  ['settings', 'Settings', ICON.gear],
];
function Shell(viewNode) {
  const side = h('div', { class: 'side' + (S.sideOpen ? ' open' : '') },
    h('div', { class: 'logo-row' }, h('div', { class: 'logo' }, '+'),
      h('div', {}, h('b', {}, 'Shifa'), h('span', {}, 'License Panel'))),
    ...NAVS.map(([id, label, icon]) => h('a', {
      class: 'nav' + (S.view === id ? ' active' : ''), onclick: () => { S.view = id; S.sideOpen = false; render(); },
    }, svg(icon), label)),
    h('div', { class: 'spacer' }),
    h('div', { class: 'foot' }, 'v1 • ' + (S.me ? S.me.username : '')));
  const title = NAVS.find((n) => n[0] === S.view)?.[1] || '';
  const bar = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', style: 'display:none', id: 'mBtn', onclick: () => { S.sideOpen = !S.sideOpen; render(); } }, svg(ICON.menu)),
    h('h2', {}, title), h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: 'Theme', onclick: toggleTheme }, '◐'),
    h('button', { class: 'btn ghost sm', onclick: logout }, svg(ICON.logout, ''), 'Logout'));
  const main = h('div', { class: 'main' }, bar, h('div', { class: 'content' }, viewNode));
  const shell = h('div', { class: 'shell' }, side, main);
  setTimeout(() => { if (window.innerWidth <= 860) $('#mBtn').style.display = 'grid'; }, 0);
  return shell;
}
function toggleTheme() {
  const r = document.documentElement;
  const t = r.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  r.setAttribute('data-theme', t); try { localStorage.setItem('shifa-theme', t); } catch {}
}
async function logout() { try { await api('POST', '/api/admin/logout'); } catch {} S.me = null; render(); }

// ============================ DASHBOARD ============================
function Dashboard() {
  const wrap = h('div', {}, h('div', { class: 'center', style: 'padding:40px' }, h('span', { class: 'spin' })));
  api('GET', '/api/admin/stats').then((r) => {
    const s = r.stats;
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'cards' },
      stat('Total Licenses', s.licenses_total, 'brand'),
      stat('Active', s.licenses_active, 'ok'),
      stat('Suspended', s.licenses_suspended, 'warn'),
      stat('Revoked', s.licenses_revoked, 'bad'),
      stat('Devices Online', s.devices_online, 'ok'),
      stat('Active Devices', s.devices_active),
      stat('Expired', s.licenses_expired, s.licenses_expired ? 'warn' : ''),
      stat('Live Updates', s.releases)));
    const rows = (r.recent || []).map((a) => h('tr', {},
      h('td', { class: 'small muted' }, ago(a.at)),
      h('td', {}, h('b', {}, a.actor)),
      h('td', {}, actionBadge(a.action)),
      h('td', { class: 'small mono muted' }, a.target || '—')));
    wrap.append(h('div', { class: 'panel' },
      h('div', { class: 'hd' }, h('h3', {}, 'Recent Activity')),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Admin'), h('th', {}, 'Action'), h('th', {}, 'Target'))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'Abhi koi activity nahi.')))))));
  }).catch((e) => { wrap.innerHTML = ''; wrap.append(h('div', { class: 'empty' }, e.message)); });
  return wrap;
}
const stat = (k, v, cls = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)));
function actionBadge(a) {
  const map = { 'login.ok': 'active', 'login.fail': 'revoked', 'license.create': 'active', 'license.suspended': 'suspended', 'license.revoked': 'revoked', 'license.active': 'active', 'release.upload': 'active' };
  return h('span', { class: 'badge ' + (map[a] || 'expired') }, a);
}

// ============================ LICENSES ============================
function Licenses() {
  const wrap = h('div', {});
  const q = h('input', { placeholder: 'Key / customer / shop / phone…', oninput: debounce(load, 250) });
  let statusFilter = '';
  const list = h('div', {});
  const filters = h('div', { class: 'seg' }, ...[['', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['revoked', 'Revoked']].map(([v, l]) =>
    h('button', { class: statusFilter === v ? 'on' : '', onclick: (e) => { statusFilter = v; [...e.target.parentNode.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); load(); } }, l)));

  wrap.append(h('div', { class: 'panel' },
    h('div', { class: 'hd' },
      h('h3', {}, 'Licenses'),
      h('div', { class: 'grow' }),
      h('div', { class: 'search' }, svg(ICON.search), q),
      filters,
      h('button', { class: 'btn primary', onclick: createLicense }, svg(ICON.plus), 'New License')),
    h('div', { class: 'tbl-wrap' }, list)));

  function load() {
    list.innerHTML = '<div class="center" style="padding:30px"><span class="spin"></span></div>';
    api('GET', `/api/admin/licenses?q=${encodeURIComponent(q.value)}&status=${statusFilter}`).then((r) => {
      list.innerHTML = '';
      if (!r.licenses.length) { list.append(h('div', { class: 'empty' }, 'Koi license nahi mila.')); return; }
      const tb = h('tbody', {});
      r.licenses.forEach((l) => tb.append(licRow(l, load)));
      list.append(h('table', {}, h('thead', {}, h('tr', {},
        h('th', {}, 'Key'), h('th', {}, 'Customer'), h('th', {}, 'Status'), h('th', {}, 'Devices'), h('th', {}, 'Expiry'), h('th', {}, ''))), tb));
    }).catch((e) => { list.innerHTML = ''; list.append(h('div', { class: 'empty' }, e.message)); });
  }
  load();
  return wrap;
}
function licRow(l, reload) {
  return h('tr', {},
    h('td', {}, h('span', { class: 'mono copyable', title: 'Copy', onclick: () => copy(l.key) }, l.key)),
    h('td', {}, h('b', {}, l.customer), l.shop && h('div', { class: 'small muted' }, l.shop)),
    h('td', {}, statusBadge(l)),
    h('td', {}, `${l.active_devices}/${l.max_devices}`),
    h('td', { class: 'small' }, l.expires_at ? fmtDay(l.expires_at) : h('span', { class: 'muted' }, 'Lifetime')),
    h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => openLicense(l.id, reload) }, 'Manage')));
}
function statusBadge(l) {
  let s = l.status;
  if (s === 'active' && l.expires_at && l.expires_at < Date.now()) s = 'expired';
  const label = { active: 'Active', suspended: 'Suspended', revoked: 'Revoked', expired: 'Expired' }[s];
  return h('span', { class: 'badge ' + s }, h('span', { class: 'dot' }), label);
}

function createLicense() {
  const f = {};
  const mk = (key, label, attrs = {}, hint) => { const i = h('input', attrs); f[key] = i; return h('div', { class: 'field' }, h('label', {}, label), i, hint && h('div', { class: 'hint' }, hint)); };
  const plan = h('select', {}, ...['standard', 'pro', 'trial'].map((p) => h('option', { value: p }, p)));
  const body = h('div', {},
    mk('customer', 'Customer Name *', { placeholder: 'Haji Medical Store' }),
    h('div', { class: 'row' }, mk('shop', 'Shop / Branch', { placeholder: 'Main Branch' }), mk('city', 'City', { placeholder: 'Karachi' })),
    h('div', { class: 'row' }, mk('phone', 'Phone', { placeholder: '03xx-xxxxxxx' }), h('div', { class: 'field' }, h('label', {}, 'Plan'), plan)),
    h('div', { class: 'row' },
      mk('valid_days', 'Valid for (days)', { type: 'number', min: 0, placeholder: 'khaali = lifetime' }, 'Khaali chhodein to lifetime.'),
      mk('max_devices', 'Max Devices', { type: 'number', min: 1, value: 1 })),
    mk('grace_hours', 'Offline grace (hours)', { type: 'number', min: 0, value: 72 }, 'Itni der bina internet chalega, phir verify lazmi.'),
    mk('message', 'In-app message', { placeholder: 'Optional — customer ke software mein dikhega' }));
  const save = h('button', { class: 'btn primary', onclick: submit }, 'Create');
  const { close } = modal('New License', body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), save]);
  async function submit() {
    if (!f.customer.value.trim()) { toast('Customer naam zaroori hai', 'bad'); return; }
    save.disabled = true;
    try {
      const payload = { customer: f.customer.value, shop: f.shop.value, city: f.city.value, phone: f.phone.value, plan: plan.value,
        valid_days: f.valid_days.value || null, max_devices: +f.max_devices.value || 1, grace_hours: +f.grace_hours.value || 0, message: f.message.value };
      const r = await api('POST', '/api/admin/licenses', payload);
      close(); showKey(r.license.key); if (S.reloadLicenses) S.reloadLicenses();
    } catch (e) { toast(e.message, 'bad'); save.disabled = false; }
  }
}
function showKey(key) {
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Ye license key customer ko dein. Software mein daal kar activate karenge:'),
    h('div', { class: 'keybox' }, h('span', { class: 'k mono' }, key), h('button', { class: 'btn sm primary', onclick: () => copy(key) }, 'Copy')),
    h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Key dobara list se bhi copy ki ja sakti hai.'));
  modal('License Ready ✅', body, [h('button', { class: 'btn primary', onclick: (e) => e.target.closest('.overlay').remove() }, 'Done')]);
}

function openLicense(id, reloadList) {
  const body = h('div', {}, h('div', { class: 'center', style: 'padding:30px' }, h('span', { class: 'spin' })));
  const { close, ov } = modal('License Details', body);
  ov.querySelector('.modal').classList.add('wide');
  const refresh = () => api('GET', '/api/admin/licenses/' + id).then((r) => renderDetail(r.license, r.devices)).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'empty' }, e.message)); });
  function renderDetail(l, devices) {
    body.innerHTML = '';
    const act = (label, cls, fn) => h('button', { class: 'btn sm ' + cls, onclick: fn }, label);
    const statusActions = h('div', { class: 'flex wrap', style: 'margin:4px 0 16px' },
      l.status !== 'active' && act('Activate', 'primary', () => changeStatus(l.id, 'active', '')),
      l.status !== 'suspended' && act('Suspend', 'warn', () => askReason('Suspend', (reason) => changeStatus(l.id, 'suspended', reason))),
      l.status !== 'revoked' && act('Revoke / Ban', 'danger', () => askReason('Revoke', (reason) => changeStatus(l.id, 'revoked', reason))),
      act('+30 days', '', () => extend(l.id, 30)),
      act('+365 days', '', () => extend(l.id, 365)),
      act('Edit', 'ghost', () => editLicense(l, refresh)),
      l.status === 'active' && act('📴 Offline Activation', 'primary', () => offlineActivationDialog(l, refresh)));
    const info = h('div', { class: 'kv' },
      h('div', { class: 'lbl' }, 'Key'), h('div', { class: 'mono copyable', onclick: () => copy(l.key) }, l.key),
      h('div', { class: 'lbl' }, 'Customer'), h('div', {}, l.customer + (l.shop ? ' — ' + l.shop : '')),
      h('div', { class: 'lbl' }, 'Phone / City'), h('div', {}, [l.phone, l.city].filter(Boolean).join(' • ') || '—'),
      h('div', { class: 'lbl' }, 'Status'), h('div', {}, statusBadge(l), l.status_reason ? h('span', { class: 'small muted' }, '  ' + l.status_reason) : ''),
      h('div', { class: 'lbl' }, 'Plan'), h('div', {}, l.plan),
      h('div', { class: 'lbl' }, 'Expiry'), h('div', {}, l.expires_at ? fmtDate(l.expires_at) : 'Lifetime'),
      h('div', { class: 'lbl' }, 'Devices'), h('div', {}, `${l.active_devices} / ${l.max_devices} used`),
      h('div', { class: 'lbl' }, 'Offline grace'), h('div', {}, l.grace_hours + ' hours'),
      l.message && h('div', { class: 'lbl' }, 'App message'), l.message && h('div', {}, l.message));
    const cmdBadge = (s) => h('span', { class: 'badge ' + ({ pending: 'suspended', done: 'active', failed: 'revoked', cancelled: 'expired' }[s] || 'expired') }, { pending: 'Pending', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[s] || s);
    const devCards = devices.map((d) => {
      const active = d.status === 'active';
      const users = d.users || [];
      return h('div', { class: 'dev-card' },
        h('div', { class: 'dev-top' },
          h('div', { class: 'dev-id' },
            h('b', {}, d.name || 'PC'),
            h('span', { class: 'badge ' + (active ? 'active' : d.status === 'banned' ? 'revoked' : 'expired') }, d.status),
            h('div', { class: 'small muted' }, (d.os || '—') + ' • v' + (d.app_version || '?') + ' • last seen ' + ago(d.last_seen) + (d.last_ip ? ' • ' + d.last_ip : '')),
            Math.abs(d.clock_skew_ms) > 120000 ? h('div', { class: 'small', style: 'color:var(--warn)' }, 'Is PC ka clock ghalat hai') : ''),
          h('div', { class: 'flex wrap' },
            active ? h('button', { class: 'btn sm', onclick: () => devAction(d.id, 'remove') }, 'Remove') : h('button', { class: 'btn sm', onclick: () => devAction(d.id, 'reset') }, 'Re-enable'),
            d.status === 'banned' ? h('button', { class: 'btn sm', onclick: () => devAction(d.id, 'unban') }, 'Unban') : h('button', { class: 'btn sm danger', onclick: () => devAction(d.id, 'ban') }, 'Ban'))),
        active && h('div', { class: 'dev-actions' },
          h('button', { class: 'btn sm primary', onclick: () => resetPasswordDialog(d, refresh) }, '🔑 Password Reset'),
          h('button', { class: 'btn sm warn', onclick: () => fullResetDialog(d, refresh) }, '♻ Full Reset')),
        users.length ? h('div', { class: 'dev-sec' },
          h('div', { class: 'dev-label' }, 'Software ke login accounts'),
          h('div', { class: 'chips' }, ...users.map((u) => h('span', { class: 'chip' + (u.active ? '' : ' off') }, u.email, h('i', {}, u.role))))) : '',
        d.commands && d.commands.length ? h('div', { class: 'dev-sec' },
          h('div', { class: 'dev-label' }, 'Remote commands'),
          ...d.commands.map((c) => h('div', { class: 'cmd-row' },
            cmdBadge(c.status),
            h('span', {}, c.label || c.type),
            h('span', { class: 'small muted' }, ago(c.created_at) + (c.result ? ' — ' + c.result : '')),
            c.status === 'pending' ? h('button', { class: 'btn sm ghost right', onclick: () => cancelCmd(c.id) }, 'Cancel') : ''))) : '');
    });
    const devTable = h('div', { style: 'margin-top:8px' },
      h('h3', { style: 'font-size:15px;margin:0 0 10px' }, 'Devices (' + devices.length + ')'),
      devCards.length ? h('div', { class: 'dev-list' }, devCards) : h('div', { class: 'empty panel' }, 'Abhi kisi PC par activate nahi hua.'));
    async function cancelCmd(id) { try { await api('POST', `/api/admin/commands/${id}/cancel`); toast('Command cancel'); refresh(); } catch (e) { toast(e.message, 'bad'); } }
    body.append(statusActions, info, h('hr', { class: 'sep' }), devTable);

    async function changeStatus(id, status, reason) { try { await api('POST', `/api/admin/licenses/${id}/status`, { status, reason }); toast('Status: ' + status); refresh(); reloadList && reloadList(); } catch (e) { toast(e.message, 'bad'); } }
    async function extend(id, days) { try { const r = await api('POST', `/api/admin/licenses/${id}/extend`, { days }); toast('Expiry: ' + fmtDay(r.expires_at)); refresh(); reloadList && reloadList(); } catch (e) { toast(e.message, 'bad'); } }
    async function devAction(did, action) { if ((action === 'ban' || action === 'remove') && !confirm('Pakka ' + action + '?')) return; try { await api('POST', `/api/admin/devices/${did}/action`, { action }); toast('Device: ' + action); refresh(); } catch (e) { toast(e.message, 'bad'); } }
  }
  refresh();
}
function genPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(10); crypto.getRandomValues(b);
  return Array.from(b, (x) => A[x % A.length]).join('');
}
function resetPasswordDialog(d, done) {
  const users = d.users || [];
  const sel = h('select', {},
    h('option', { value: '' }, 'Owner account (ADMIN) — default'),
    ...users.map((u) => h('option', { value: u.email }, `${u.email} (${u.role})`)));
  const custom = h('input', { placeholder: 'ya email khud likhein (optional)' });
  const pw = h('input', { class: 'mono', value: genPassword() });
  const body = h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, `PC: `, h('b', {}, d.name || 'PC'), '. Customer jo login password bhool gaya hai, uska naya password yahan set karein.'),
    h('div', { class: 'field' }, h('label', {}, 'Kis account ka password?'), sel),
    h('div', { class: 'field' }, custom),
    h('div', { class: 'field' }, h('label', {}, 'Naya password'),
      h('div', { class: 'flex' }, pw, h('button', { class: 'btn sm', onclick: () => { pw.value = genPassword(); } }, 'Naya'), h('button', { class: 'btn sm', onclick: () => copy(pw.value) }, 'Copy')),
      h('div', { class: 'hint' }, 'Ye password customer ko phone/WhatsApp par bata dein. Password yahan se hash ban kar jata hai — plain text kahin save nahi hota.')),
    h('div', { class: 'note' }, 'Customer ka software online hote hi (zyada se zyada ' + Math.round((+S.hbSeconds || 300) / 60) + ' minute) naya password lag jayega. Agar software band hai to agli dafa kholne par lagega.'));
  const save = h('button', { class: 'btn primary', onclick: submit }, 'Reset Password');
  const { close } = modal('🔑 Login Password Reset', body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), save]);
  async function submit() {
    if (pw.value.length < 6) { toast('Password kam az kam 6 characters', 'bad'); return; }
    save.disabled = true;
    try {
      await api('POST', `/api/admin/devices/${d.id}/command`, { type: 'reset_password', email: custom.value.trim() || sel.value, password: pw.value });
      copy(pw.value);
      toast('Password reset bhej diya (password copy ho gaya)');
      close(); done && done();
    } catch (e) { toast(e.message, 'bad'); save.disabled = false; }
  }
}
function fullResetDialog(d, done) {
  const conf = h('input', { class: 'mono', placeholder: 'RESET' });
  const body = h('div', {},
    h('div', { class: 'note warn' }, h('b', {}, 'Dhyan se: '), 'Is PC par software bilkul naye install jaisa ho jayega — login accounts, settings aur saara data hat kar setup screen aayegi, aur license dobara activate karna hoga.'),
    h('ul', { class: 'small muted' },
      h('li', {}, 'Purana data delete NAHI hota — usi PC par backup folder mein mehfooz ho jata hai.'),
      h('li', {}, 'Is PC ka device slot khaali ho jayega, taake fresh install usi key se activate ho sake.'),
      h('li', {}, 'Software online hote hi reset ho kar khud restart hoga.')),
    h('div', { class: 'field' }, h('label', {}, 'Confirm karne ke liye RESET likhein'), conf));
  const go = h('button', { class: 'btn danger', onclick: submit }, 'Full Reset');
  const { close } = modal('♻ Full Reset — ' + (d.name || 'PC'), body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), go]);
  async function submit() {
    if (conf.value.trim() !== 'RESET') { toast('RESET likhein', 'bad'); return; }
    go.disabled = true;
    try { await api('POST', `/api/admin/devices/${d.id}/command`, { type: 'full_reset', confirm: 'RESET' }); toast('Full reset bhej diya'); close(); done && done(); }
    catch (e) { toast(e.message, 'bad'); go.disabled = false; }
  }
}
function offlineActivationDialog(l, done) {
  const req = h('textarea', { rows: 4, class: 'mono', placeholder: 'SHIFA-REQ:...' });
  const days = h('input', { type: 'number', min: 1, max: 3650, value: 365 });
  const outBox = h('div', { class: 'hidden' });
  const body = h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Jis PC par internet nahi, wahan software ki lock screen par "Offline Activation" dabane se Request Code aata hai. Customer woh code aapko bhejega — yahan paste karein.'),
    h('div', { class: 'field' }, h('label', {}, 'Request Code'), req),
    h('div', { class: 'field' }, h('label', {}, 'Bina internet kitne din chale?'), days,
      h('div', { class: 'hint' }, 'Itne din baad (ya license expiry par, jo pehle aaye) software ek dafa naya code ya internet mangega. Suspend/Reset commands sirf tab pohanchte hain jab PC online aaye.')),
    outBox);
  const go = h('button', { class: 'btn primary', onclick: submit }, 'Activation Code banayein');
  const { close } = modal('📴 Offline Activation — ' + l.customer, body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Close'), go]);
  async function submit() {
    go.disabled = true;
    try {
      const r = await api('POST', `/api/admin/licenses/${l.id}/offline-activate`, { request_code: req.value, days: +days.value });
      outBox.innerHTML = '';
      const code = h('textarea', { rows: 6, class: 'mono', readonly: true }, r.activation_code);
      outBox.append(h('div', { class: 'field' }, h('label', {}, 'Activation Code — ye customer ko bhejein'), code,
        h('div', { class: 'flex', style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', onclick: () => copy(r.activation_code) }, 'Copy Activation Code'),
          h('span', { class: 'small muted' }, `${r.days} din offline chalega`))));
      outBox.classList.remove('hidden');
      copy(r.activation_code);
      toast('Activation code ban gaya (copy ho gaya)');
      done && done();
    } catch (e) { toast(e.message, 'bad'); }
    go.disabled = false;
  }
}
function askReason(title, cb) {
  const ta = h('textarea', { rows: 3, placeholder: 'Wajah (customer ke software mein dikhegi)…' });
  const { close } = modal(title + ' — Reason', h('div', { class: 'field' }, h('label', {}, 'Message'), ta),
    [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => { close(); cb(ta.value.trim()); } }, 'Confirm')]);
  setTimeout(() => ta.focus(), 50);
}
function editLicense(l, done) {
  const f = {};
  const mk = (k, label, attrs = {}) => { const i = h('input', { value: l[k] ?? '', ...attrs }); f[k] = i; return h('div', { class: 'field' }, h('label', {}, label), i); };
  const body = h('div', {},
    h('div', { class: 'row' }, mk('customer', 'Customer'), mk('shop', 'Shop')),
    h('div', { class: 'row' }, mk('phone', 'Phone'), mk('city', 'City')),
    h('div', { class: 'row' }, mk('max_devices', 'Max Devices', { type: 'number', min: 1 }), mk('grace_hours', 'Grace (hours)', { type: 'number', min: 0 })),
    h('div', { class: 'field' }, h('label', {}, 'In-app message'), f.message = h('input', { value: l.message || '' })));
  const save = h('button', { class: 'btn primary', onclick: submit }, 'Save');
  const { close } = modal('Edit License', body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), save]);
  async function submit() {
    save.disabled = true;
    try { await api('PATCH', '/api/admin/licenses/' + l.id, { customer: f.customer.value, shop: f.shop.value, phone: f.phone.value, city: f.city.value, max_devices: +f.max_devices.value, grace_hours: +f.grace_hours.value, message: f.message.value }); toast('Saved'); close(); done && done(); }
    catch (e) { toast(e.message, 'bad'); save.disabled = false; }
  }
}

// ============================ UPDATES ============================
function Updates() {
  const wrap = h('div', {});
  const list = h('div', {});
  wrap.append(h('div', { class: 'panel' },
    h('div', { class: 'hd' }, h('h3', {}, 'App Updates'), h('div', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: uploadRelease }, svg(ICON.plus), 'Upload Update')),
    h('div', { class: 'tbl-wrap' }, list)));
  wrap.append(h('p', { class: 'small muted', style: 'margin-top:12px' },
    'Upload kiya hua installer sab customers ke software ko signature verify ke baad khud mil jayega. "Mandatory" update na karne par software lock ho jayega.'));
  function load() {
    list.innerHTML = '<div class="center" style="padding:30px"><span class="spin"></span></div>';
    api('GET', '/api/admin/releases').then((r) => {
      list.innerHTML = '';
      if (!r.releases.length) { list.append(h('div', { class: 'empty' }, 'Abhi koi update upload nahi hua.')); return; }
      const tb = h('tbody', {});
      r.releases.forEach((rel) => tb.append(h('tr', {},
        h('td', {}, h('b', {}, 'v' + rel.version), rel.mandatory ? h('span', { class: 'badge revoked', style: 'margin-left:6px' }, 'Mandatory') : ''),
        h('td', {}, h('span', { class: 'badge ' + (rel.active ? 'active' : 'expired') }, rel.active ? 'Live' : 'Off')),
        h('td', { class: 'small' }, rel.channel),
        h('td', { class: 'small' }, (rel.size / 1048576).toFixed(1) + ' MB'),
        h('td', { class: 'small mono muted', title: rel.sha256 }, rel.sha256.slice(0, 12) + '…'),
        h('td', { class: 'small' }, rel.downloads),
        h('td', { class: 'small' }, fmtDay(rel.created_at)),
        h('td', { class: 'right flex' },
          h('button', { class: 'btn sm', onclick: () => toggle(rel.id) }, rel.active ? 'Turn off' : 'Turn on'),
          h('button', { class: 'btn sm danger', onclick: () => del(rel.id, rel.version) }, 'Delete')))));
      list.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'State'), h('th', {}, 'Channel'), h('th', {}, 'Size'), h('th', {}, 'SHA-256'), h('th', {}, 'Downloads'), h('th', {}, 'Date'), h('th', {}, ''))), tb));
    }).catch((e) => { list.innerHTML = ''; list.append(h('div', { class: 'empty' }, e.message)); });
  }
  async function toggle(id) { try { await api('POST', `/api/admin/releases/${id}/toggle`); load(); } catch (e) { toast(e.message, 'bad'); } }
  async function del(id, v) { if (!confirm('Delete v' + v + '?')) return; try { await api('DELETE', '/api/admin/releases/' + id); toast('Deleted'); load(); } catch (e) { toast(e.message, 'bad'); } }
  load();
  return wrap;
}
function uploadRelease() {
  const ver = h('input', { placeholder: '1.0.1' });
  const channel = h('select', {}, ...['stable', 'beta'].map((c) => h('option', { value: c }, c)));
  const notes = h('textarea', { rows: 2, placeholder: 'Kya naya hai (optional)' });
  const mand = h('input', { type: 'checkbox' });
  const file = h('input', { type: 'file', accept: '.exe,.zip,.msi' });
  const bar = h('div', { class: 'progress hidden' }, h('i', { style: 'width:0%' }));
  const save = h('button', { class: 'btn primary', onclick: submit }, 'Upload');
  const body = h('div', {},
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Version *'), ver), h('div', { class: 'field' }, h('label', {}, 'Channel'), channel)),
    h('div', { class: 'field' }, h('label', {}, 'Release notes'), notes),
    h('div', { class: 'field' }, h('label', { class: 'flex' }, mand, ' Mandatory update (purani version block)')),
    h('div', { class: 'field' }, h('label', {}, 'Installer file *'), file),
    bar);
  const { close } = modal('Upload Update', body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), save]);
  async function submit() {
    if (!/^\d+\.\d+\.\d+/.test(ver.value.trim())) { toast('Version 1.0.0 format mein do', 'bad'); return; }
    if (!file.files[0]) { toast('File select karein', 'bad'); return; }
    const fobj = file.files[0];
    save.disabled = true; bar.classList.remove('hidden');
    const qs = new URLSearchParams({ version: ver.value.trim(), channel: channel.value, file_name: fobj.name, mandatory: mand.checked ? '1' : '0', notes: notes.value });
    // XHR for progress
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/releases?' + qs.toString());
    xhr.setRequestHeader('X-CSRF-Token', S.csrf);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstChild.style.width = (e.loaded / e.total * 100).toFixed(0) + '%'; };
    xhr.onload = () => { save.disabled = false; let j = null; try { j = JSON.parse(xhr.responseText); } catch {} if (xhr.status === 200 && j && j.ok) { toast('Update upload ho gaya ✅'); close(); if (S.reloadUpdates) S.reloadUpdates(); } else { toast((j && j.error) || 'Upload fail', 'bad'); bar.classList.add('hidden'); } };
    xhr.onerror = () => { save.disabled = false; toast('Network error', 'bad'); };
    xhr.send(fobj);
  }
}

// ============================ AUDIT ============================
function Audit() {
  const wrap = h('div', {});
  const list = h('div', {});
  wrap.append(h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h3', {}, 'Audit Log'),
    h('div', { class: 'grow' }), h('button', { class: 'btn sm', onclick: load }, 'Refresh')),
    h('div', { class: 'tbl-wrap' }, list)));
  function load() {
    list.innerHTML = '<div class="center" style="padding:30px"><span class="spin"></span></div>';
    api('GET', '/api/admin/audit?limit=300').then((r) => {
      list.innerHTML = '';
      const tb = h('tbody', {});
      r.audit.forEach((a) => tb.append(h('tr', {},
        h('td', { class: 'small muted', style: 'white-space:nowrap' }, fmtDate(a.at)),
        h('td', {}, h('b', {}, a.actor)),
        h('td', {}, actionBadge(a.action)),
        h('td', { class: 'small mono' }, a.target || '—'),
        h('td', { class: 'small muted' }, a.details || ''),
        h('td', { class: 'small mono muted' }, a.ip || ''))));
      list.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Admin'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'Details'), h('th', {}, 'IP'))),
        tb.children.length ? tb : h('tbody', {}, h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'Khaali.')))));
    }).catch((e) => { list.innerHTML = ''; list.append(h('div', { class: 'empty' }, e.message)); });
  }
  load();
  return wrap;
}

// ============================ SETTINGS ============================
function Settings() {
  const wrap = h('div', {});
  // --- security settings ---
  const sec = h('div', { class: 'panel', style: 'margin-bottom:18px' });
  sec.append(h('div', { class: 'hd' }, h('h3', {}, 'Security & Policy')));
  const secBody = h('div', { style: 'padding:16px 18px' });
  sec.append(secBody);
  const f = {};
  api('GET', '/api/admin/settings').then((r) => {
    const s = r.settings;
    const mk = (k, label, attrs, hint) => { const i = h('input', { value: s[k], ...attrs }); f[k] = i; return h('div', { class: 'field' }, h('label', {}, label), i, hint && h('div', { class: 'hint' }, hint)); };
    secBody.append(
      h('div', { class: 'row' },
        mk('heartbeat_seconds', 'Online check interval (seconds)', { type: 'number', min: 30 }, 'Software kitni dair baad server se verify kare.'),
        mk('default_grace_hours', 'Default offline grace (hours)', { type: 'number', min: 0 }, 'Nayi license par default.')),
      h('div', { class: 'row' },
        mk('max_clock_skew_minutes', 'Max clock skew (minutes)', { type: 'number', min: 1 }, 'PC ka time itne se zyada aage/peeche ho to lock.'),
        h('div', { class: 'field' })),
      h('div', { class: 'field' }, h('label', {}, 'Global announcement (sab apps mein dikhega)'), f.announcement = h('textarea', { rows: 2 }, s.announcement || '')),
      h('button', { class: 'btn primary', onclick: saveSettings }, 'Save Settings'));
  });
  async function saveSettings() {
    try { await api('POST', '/api/admin/settings', { heartbeat_seconds: f.heartbeat_seconds.value, default_grace_hours: f.default_grace_hours.value, max_clock_skew_minutes: f.max_clock_skew_minutes.value, announcement: f.announcement.value }); toast('Settings saved'); }
    catch (e) { toast(e.message, 'bad'); }
  }
  wrap.append(sec);

  // --- account ---
  const acc = h('div', { class: 'panel', style: 'margin-bottom:18px' }, h('div', { class: 'hd' }, h('h3', {}, 'Admin Account')));
  const accBody = h('div', { style: 'padding:16px 18px' });
  const cur = h('input', { type: 'password', placeholder: 'Current password' });
  const nw = h('input', { type: 'password', placeholder: 'New password (min 10 chars)' });
  accBody.append(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Current password'), cur), h('div', { class: 'field' }, h('label', {}, 'New password'), nw)),
    h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/admin/change-password', { current: cur.value, next: nw.value }); toast('Password change ho gaya'); cur.value = nw.value = ''; } catch (e) { toast(e.message, 'bad'); } } }, 'Change Password'));
  acc.append(accBody);
  wrap.append(acc);

  // --- 2FA ---
  const twofa = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h3', {}, 'Two-Factor Authentication (2FA)'), h('div', { class: 'grow' }),
    h('span', { class: 'badge ' + (S.me.totp_enabled ? 'active' : 'expired') }, S.me.totp_enabled ? 'Enabled' : 'Off')));
  const tBody = h('div', { style: 'padding:16px 18px' });
  if (S.me.totp_enabled) {
    const pw = h('input', { type: 'password', placeholder: 'Password to disable' });
    tBody.append(h('p', { class: 'muted' }, '2FA on hai. Disable karne ke liye password dein:'),
      h('div', { class: 'field' }, pw),
      h('button', { class: 'btn danger', onclick: async () => { try { await api('POST', '/api/admin/2fa/disable', { password: pw.value }); toast('2FA disabled'); S.me.totp_enabled = false; render(); } catch (e) { toast(e.message, 'bad'); } } }, 'Disable 2FA'));
  } else {
    tBody.append(h('p', { class: 'muted' }, 'Google/Microsoft Authenticator se extra security. Enable karein:'),
      h('button', { class: 'btn primary', onclick: setup2fa }, 'Setup 2FA'));
  }
  twofa.append(tBody);
  wrap.append(twofa);
  function setup2fa() {
    api('POST', '/api/admin/2fa/setup').then((r) => {
      const otp = h('input', { class: 'mono', placeholder: '000000', maxlength: 6, inputmode: 'numeric' });
      const body = h('div', {},
        h('p', { class: 'muted' }, '1) Apne Authenticator app mein ye secret manually add karein:'),
        h('div', { class: 'keybox' }, h('span', { class: 'k mono', style: 'font-size:14px;word-break:break-all' }, r.secret), h('button', { class: 'btn sm', onclick: () => copy(r.secret) }, 'Copy')),
        h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Ya ye link kisi QR generator mein daalein: ', h('span', { class: 'mono small copyable', onclick: () => copy(r.uri) }, 'otpauth link (copy)')),
        h('div', { class: 'field', style: 'margin-top:14px' }, h('label', {}, '2) App ka 6-digit code daal kar confirm karein'), otp));
      const { close } = modal('Setup 2FA', body, [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/api/admin/2fa/enable', { otp: otp.value.trim() }); toast('2FA enabled ✅'); S.me.totp_enabled = true; close(); render(); } catch (e) { toast(e.message, 'bad'); } } }, 'Enable')]);
      setTimeout(() => otp.focus(), 50);
    }).catch((e) => toast(e.message, 'bad'));
  }
  return wrap;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ============================ RENDER ============================
function render() {
  const app = $('#app');
  app.innerHTML = '';
  if (!document.body.contains(toastWrap)) document.body.append(toastWrap);
  if (!S.me) { app.append(Login()); return; }
  let view;
  if (S.view === 'dash') view = Dashboard();
  else if (S.view === 'licenses') { view = Licenses(); S.reloadLicenses = () => { if (S.view === 'licenses') render(); }; }
  else if (S.view === 'updates') { view = Updates(); S.reloadUpdates = () => { if (S.view === 'updates') render(); }; }
  else if (S.view === 'audit') view = Audit();
  else if (S.view === 'settings') view = Settings();
  app.append(Shell(view));
}

(async function init() {
  try { const t = localStorage.getItem('shifa-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch {}
  try { const r = await api('GET', '/api/admin/me'); if (r.authed) { S.me = { username: r.username, totp_enabled: r.totp_enabled }; S.csrf = r.csrf; } } catch {}
  render();
})();
})();
