import { api, accountsAvailable } from './api.js';
import { encodeWorld } from './world.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (sel, root = document) => root.querySelector(sel);

// ctx: { getWorld(), loadScene(text, opts), makeThumb(), toast(msg), getCloud(), setCloud(c) }
export async function initAccount(ctx) {
  const panel = $('#panel');
  const body = $('#panelBody');
  const accountBtn = $('#accountBtn');
  const galleryBtn = $('#galleryBtn');
  const reportsBtn = $('#reportsBtn');
  const feedbackBtn = $('#feedbackBtn');

  if (!(await accountsAvailable())) return; // plain static copy: keep the buttons hidden
  let user = null;
  for (const b of [accountBtn, galleryBtn, feedbackBtn]) b.hidden = false;

  async function refreshMe() {
    user = (await api('GET', '/api/me')).user;
    // The Reports button always shows for admins, and for anyone picked to look at a report while one is waiting.
    // The red circle with the count only appears while something is waiting.
    const waiting = user ? user.pendingReports || 0 : 0;
    reportsBtn.hidden = !(user && (user.isAdmin || waiting > 0));
    const badge = $('.count', reportsBtn);
    badge.hidden = waiting === 0;
    badge.textContent = waiting;
    reportsBtn.title = waiting ? `${waiting} report${waiting > 1 ? 's' : ''} waiting for review` : 'Reports waiting for review';
    // the chat button shows how many conversations have something new to read
    const unread = user ? user.feedbackUnread || 0 : 0;
    const fbBadge = $('.count', feedbackBtn);
    fbBadge.hidden = unread === 0;
    fbBadge.textContent = unread;
    feedbackBtn.title = unread ? `${unread} conversation${unread > 1 ? 's' : ''} with something new` : 'Ask for a feature or report an error, and chat about it until it is closed';
    $('span', accountBtn).textContent = user ? user.username : '';
    accountBtn.setAttribute('aria-label', user ? `Account: ${user.username}` : 'Sign in');
    accountBtn.title = user ? 'Your dioramas and settings' : 'Sign in or create an account';
  }
  await refreshMe();
  // keep the Reports button honest without a page refresh when you come back to the tab (no timer, so the database can still sleep)
  const recheck = () => user && !document.hidden && refreshMe().catch(() => {});
  document.addEventListener('visibilitychange', recheck);

  // ---------- panel helpers ----------
  function open(html, { wide = false, full = false } = {}) {
    body.innerHTML = html;
    panel.classList.toggle('wide', wide);
    panel.classList.toggle('full', full);
    if (!panel.open) panel.showModal();
    return body;
  }
  const close = () => panel.open && panel.close();
  const fail = (el, err) => {
    el.textContent = err.message;
    el.hidden = false;
  };
  panel.addEventListener('click', (e) => {
    if (e.target === panel && !panel.classList.contains('full')) close(); // click on the backdrop
  });

  // ---------- sign in / create account ----------
  function authView({ mode = 'login', message = '', after = null, skippable = false } = {}) {
    const signup = mode === 'signup';
    const el = open(`
      <div class="authbrand">🧱 Cubeloft</div>
      <h2>${signup ? 'Create an account' : 'Sign in'}</h2>
      ${message ? `<p class="hint">${esc(message)}</p>` : ''}
      <form id="authForm" autocomplete="on">
        <label>Username
          <input name="username" autocomplete="username" maxlength="20" required autocapitalize="none" spellcheck="false">
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" maxlength="200" required>
        </label>
        ${signup ? '<p class="hint">Use a made-up username, not your real name. 3–20 letters, numbers or underscores — capital letters are kept. Passwords need 8+ characters. There is no email, so write your password down — it can\'t be reset by email.</p>' : ''}
        <p class="error" id="authError" hidden></p>
        <div class="row">
          <button type="button" data-act="close">${skippable ? 'Continue without an account' : 'Cancel'}</button>
          <button type="submit" class="primary">${signup ? 'Create account' : 'Sign in'}</button>
        </div>
      </form>
      <p class="hint center">${signup ? 'Already have an account?' : 'New here?'} <button type="button" class="link" data-act="switch">${signup ? 'Sign in' : 'Create an account'}</button></p>`, { full: true });
    $('[name=username]', el).focus();
    $('[data-act=close]', el).onclick = close;
    $('[data-act=switch]', el).onclick = () => authView({ mode: signup ? 'login' : 'signup', message, after, skippable });
    $('#authForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('POST', signup ? '/api/signup' : '/api/login', { username: f.get('username'), password: f.get('password') });
        await refreshMe();
        ctx.statusChanged && ctx.statusChanged();
        ctx.toast(`Hi ${user.username}!`);
        close();
        if (ctx.onSignedIn) ctx.onSignedIn();
        if (after) after();
      } catch (err) {
        fail($('#authError', el), err);
      }
    };
  }

  const needSignIn = (message, after) => authView({ mode: 'login', message, after });

  // ---------- save online ----------
  async function saveView() {
    const world = ctx.getWorld();
    const cloud = ctx.getCloud();
    const updating = cloud && cloud.mine;
    const collab = updating && cloud.isOwner === false; // a classmate editing someone else's diorama
    const { classes } = await api('GET', '/api/classes').catch(() => ({ classes: [] }));
    const inClass = updating && cloud.visibility === 'class';
    if (collab) return collabSaveView(world, cloud);
    const el = open(`
      <h2>${updating ? 'Save changes' : 'Save to your account'}</h2>
      <form id="saveForm">
        <label>Title <input name="title" maxlength="80" required value="${esc(updating ? cloud.title : world.meta.title || '')}" placeholder="e.g. Chapter 3: The Little House"></label>
        <fieldset>
          <legend>Who can see it?</legend>
          <label class="inline"><input type="radio" name="vis" value="private" ${updating && (cloud.visibility === 'gallery' || inClass) ? '' : 'checked'}> Only me</label>
          <label class="inline"><input type="radio" name="vis" value="gallery" ${updating && cloud.visibility === 'gallery' ? 'checked' : ''}> In my gallery (everyone signed in can look)</label>
          ${classes.length ? `<label class="inline"><input type="radio" name="vis" value="class" ${inClass ? 'checked' : ''}> In a class gallery (only that class can look):
            <select name="classId">${classes.map((c) => `<option value="${c.id}" ${inClass && cloud.classId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="inline"><input type="checkbox" name="classEdit" ${inClass && cloud.classEdit ? 'checked' : ''}> Let people in that class edit it too (only if you chose a class above)</label>` : ''}
        </fieldset>
        <label>Optional: a code people must enter to open this diorama
          <input name="code" maxlength="40" autocomplete="off" placeholder="${updating && cloud.hasCode ? 'Leave blank to keep the current code' : 'Leave blank for no code'}">
        </label>
        ${updating && cloud.hasCode ? '<label class="inline"><input type="checkbox" name="clearCode"> Remove the code</label>' : ''}
        <p class="error" id="saveError" hidden></p>
        <div class="row">
          <button type="button" data-act="close">Cancel</button>
          ${updating ? '<button type="submit" value="new">Save as a new one</button>' : ''}
          <button type="submit" value="save" class="primary">${updating ? 'Save changes' : 'Save'}</button>
        </div>
      </form>`);
    $('[data-act=close]', el).onclick = close;
    $('#saveForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const asNew = e.submitter && e.submitter.value === 'new';
      const code = (f.get('code') || '').trim();
      const payload = {
        id: updating && !asNew ? cloud.id : undefined,
        title: f.get('title'),
        data: await encodeWorld(world),
        thumb: ctx.makeThumb(),
        visibility: f.get('vis'),
        explicit: true, // choosing who can see it (autosave never changes that)
        classId: f.get('vis') === 'class' ? Number(f.get('classId')) : undefined,
        classEdit: f.get('vis') === 'class' && f.get('classEdit') === 'on',
      };
      if (code) payload.code = code;
      else if (f.get('clearCode')) payload.code = '';
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      try {
        const res = await api('POST', '/api/dioramas', payload);
        world.meta.title = payload.title;
        ctx.setCloud({ id: res.id, title: payload.title, mine: true, isOwner: true, visibility: payload.visibility, classId: payload.classId, classEdit: payload.classEdit, hasCode: !!code || (updating && cloud.hasCode && !f.get('clearCode')) });
        ctx.toast(payload.visibility === 'gallery' ? 'Saved — it is in your gallery.' : payload.visibility === 'class' ? 'Saved — shared with your class.' : 'Saved to your account.');
        close();
      } catch (err) {
        for (const b of el.querySelectorAll('button')) b.disabled = false;
        fail($('#saveError', el), err);
      }
    };
  }

  // A classmate's save: the title and the scene only. Who can see it, and its code, stay with the owner.
  function collabSaveView(world, cloud) {
    const el = open(`
      <h2>Save changes</h2>
      <p>${esc(cloud.owner)} let your class edit this diorama. Your changes are saved for everyone in the class, and replace what is there now.</p>
      <form id="saveForm">
        <label>Title <input name="title" maxlength="80" required value="${esc(cloud.title)}"></label>
        <p class="error" id="saveError" hidden></p>
        <div class="row">
          <button type="button" data-act="close">Cancel</button>
          <button type="submit" class="primary">Save changes</button>
        </div>
      </form>`);
    $('[data-act=close]', el).onclick = close;
    $('#saveForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const title = new FormData(e.target).get('title');
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      try {
        await api('POST', '/api/dioramas', { id: cloud.id, title, data: await encodeWorld(world), thumb: ctx.makeThumb() });
        world.meta.title = title;
        ctx.setCloud({ ...cloud, title });
        ctx.toast('Saved for your class.');
        close();
      } catch (err) {
        for (const b of el.querySelectorAll('button')) b.disabled = false;
        fail($('#saveError', el), err);
      }
    };
  }

  // ---------- opening dioramas ----------
  async function openDiorama(id) {
    try {
      const d = await api('GET', `/api/dioramas/${id}`);
      await ctx.loadScene(d.data, { shared: !d.mine, cloud: { id: d.id, title: d.title, owner: d.owner, mine: d.mine, isOwner: d.isOwner, visibility: d.visibility, classId: d.classId, classEdit: d.classEdit } });
      close();
    } catch (err) {
      if (err.data && err.data.locked === 'gallery') return unlockView({ kind: 'gallery', id: err.data.ownerId, owner: err.data.owner, then: () => openDiorama(id) });
      if (err.data && err.data.locked === 'diorama') return unlockView({ kind: 'diorama', id: err.data.id, owner: err.data.owner, then: () => openDiorama(id) });
      ctx.toast(err.message);
    }
  }

  function unlockView({ kind, id, owner, then }) {
    const el = open(`
      <h2>Code needed</h2>
      <p>${kind === 'gallery' ? `${esc(owner)}'s gallery` : `A diorama by ${esc(owner)}`} needs a code. Ask ${esc(owner)} for it.</p>
      <form id="unlockForm">
        <label>Code <input name="code" autocomplete="off" maxlength="40" required></label>
        <p class="error" id="unlockError" hidden></p>
        <div class="row"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Open</button></div>
      </form>`);
    $('[name=code]', el).focus();
    $('[data-act=close]', el).onclick = close;
    $('#unlockForm', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/unlock', { kind, id, code: new FormData(e.target).get('code') });
        then();
      } catch (err) {
        fail($('#unlockError', el), err);
      }
    };
  }

  const cards = (items, { mine = false, takedown = false } = {}) =>
    items.length
      ? `<div class="cards">${items
          .map(
            (d) => `<div class="dcard">
              <button class="dthumb" data-open="${d.id}" title="Open">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : `<span>${d.locked ? 'Locked' : 'No picture'}</span>`}</button>
              <div class="dtitle">${d.locked ? '[Locked] ' : ''}${esc(d.title)}</div>
              <div class="dmeta">${mine ? (d.visibility === 'gallery' ? 'In my gallery' : d.visibility === 'class' ? 'Class: ' + esc(d.className || '') : 'Only me') + (d.hasCode ? ' · needs a code' : '') : `by <button class="link" data-user="${esc(d.owner)}">${esc(d.owner)}</button>`}</div>
              ${mine ? `<div class="dactions"><button data-open="${d.id}">Open</button>${d.visibility === 'gallery' && !d.hasCode ? `<button data-link="${d.id}">Copy link</button>` : ''}<button data-del="${d.id}">Delete</button></div>` : takedown ? `<div class="dactions"><button data-takedown="${d.id}">Take down</button></div>` : ''}
            </div>`,
          )
          .join('')}</div>`
      : '<p class="hint">Nothing here yet.</p>';

  function wireCards(el) {
    el.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openDiorama(Number(b.dataset.open))));
    el.querySelectorAll('[data-user]').forEach((b) => (b.onclick = () => userGalleryView(b.dataset.user)));
    el.querySelectorAll('[data-link]').forEach(
      (b) =>
        (b.onclick = async () => {
          const url = `${location.origin}${location.pathname}#d=${b.dataset.link}`;
          try {
            await api('GET', `/api/dioramas/${b.dataset.link}/public`); // only everyone-gallery dioramas without a code can be linked
          } catch {
            ctx.toast('This diorama is not public, so it has no link.');
            return;
          }
          try {
            await navigator.clipboard.writeText(url);
            ctx.toast('Link copied. Anyone can open it, no sign-in needed.');
          } catch {
            window.prompt('Copy this link:', url);
          }
        }),
    );
  }

  // ---------- my dioramas ----------
  async function mineView() {
    open('<h2>My dioramas</h2><p class="hint">Loading…</p>', { wide: true });
    try {
      const { dioramas } = await api('GET', '/api/dioramas/mine');
      const el = open(
        `<h2>${esc(user.username)}${user.isAdmin ? ' <small>(admin)</small>' : ''}</h2>
        ${cards(dioramas, { mine: true })}
        <h3>Gallery code</h3>
        <p class="hint">${user.hasGalleryCode ? 'Your gallery needs a code to open.' : 'Anyone signed in can open your gallery.'} You can ask for a code so only people you tell can look.</p>
        <form id="codeForm" class="inlineform">
          <input name="code" maxlength="40" autocomplete="off" placeholder="New gallery code (3+ characters)">
          <button class="primary">Set code</button>
          ${user.hasGalleryCode ? '<button type="button" data-act="clear">Remove code</button>' : ''}
        </form>
        <p class="error" id="codeError" hidden></p>
        <div class="row"><button type="button" data-act="signout">Sign out</button><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      el.querySelectorAll('[data-del]').forEach(
        (b) =>
          (b.onclick = async () => {
            if (!confirm('Delete this diorama for good?')) return;
            try {
              await api('DELETE', `/api/dioramas/${b.dataset.del}`);
              if (ctx.getCloud() && String(ctx.getCloud().id) === b.dataset.del) ctx.setCloud(null);
              mineView();
            } catch (err) {
              ctx.toast(err.message);
            }
          }),
      );
      $('[data-act=close]', el).onclick = close;
      $('[data-act=signout]', el).onclick = async () => {
        await api('POST', '/api/logout', {});
        await refreshMe();
        ctx.setCloud(null);
        ctx.onSignedOut && ctx.onSignedOut(); // your diorama must not stay on screen
        ctx.statusChanged && ctx.statusChanged();
        ctx.toast('Signed out. Your diorama is saved in your account.');
        close();
      };
      const setCode = async (code) => {
        try {
          await api('PUT', '/api/me/gallery-code', { code });
          await refreshMe();
          ctx.toast(code ? 'Gallery code set.' : 'Gallery code removed.');
          mineView();
        } catch (err) {
          fail($('#codeError', el), err);
        }
      };
      $('#codeForm', el).onsubmit = (e) => {
        e.preventDefault();
        setCode(new FormData(e.target).get('code'));
      };
      const clear = $('[data-act=clear]', el);
      if (clear) clear.onclick = () => setCode(null);
    } catch (err) {
      ctx.toast(err.message);
      close();
    }
  }

  // ---------- gallery ----------
  async function galleryView() {
    open('<h2>Gallery</h2><p class="hint">Loading…</p>', { wide: true });
    try {
      const g = await api('GET', '/api/gallery');
      const { classes } = await api('GET', '/api/classes');
      const el = open(
        `<h2>Gallery</h2>
        <p class="hint">Dioramas other people chose to share. Be kind — use Report if something isn't okay.</p>
        <h3>My classes</h3>
        <div class="chips">${classes.length ? classes.map((c) => `<button class="chip" data-class="${c.id}">${esc(c.name)} <small>${c.members}</small></button>`).join('') : '<span class="hint">You are not in a class yet.</span>'}</div>
        <form id="joinForm" class="inlineform">
          <input name="code" maxlength="12" autocomplete="off" placeholder="Class code">
          <button class="primary">Join a class</button>
          <button type="button" data-act="newclass">Start a class</button>
        </form>
        <p class="error" id="classError" hidden></p>
        <h3>People</h3>
        <div class="chips">${g.members.length ? g.members.map((m) => `<button class="chip" data-user="${esc(m.username)}">${m.locked ? '[Locked] ' : ''}${esc(m.username)} <small>${m.count}</small></button>`).join('') : '<span class="hint">No one has shared anything yet.</span>'}</div>
        <h3>Newest</h3>
        ${cards(g.recent)}
        <div class="row"><button type="button" data-act="feedback">Feedback: request a feature or report an error</button><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      $('[data-act=feedback]', el).onclick = feedbackListView;
      wireCards(el);
      el.querySelectorAll('[data-class]').forEach((b) => (b.onclick = () => classView(Number(b.dataset.class))));
      $('#joinForm', el).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const joined = await api('POST', '/api/classes/join', { code: new FormData(e.target).get('code') });
          ctx.toast(`You joined ${joined.name}.`);
          classView(joined.id);
        } catch (err) {
          fail($('#classError', el), err);
        }
      };
      $('[data-act=newclass]', el).onclick = async () => {
        const name = (prompt('What is the class called? (for example: Period 3 English)') || '').trim();
        if (!name) return;
        try {
          const made = await api('POST', '/api/classes', { name });
          ctx.toast(`Class started. Share the code ${made.code} with your students.`);
          classView(made.id);
        } catch (err) {
          fail($('#classError', el), err);
        }
      };
      $('[data-act=close]', el).onclick = close;
    } catch (err) {
      ctx.toast(err.message);
      close();
    }
  }

  // ---------- a class gallery ----------
  async function classView(id) {
    try {
      const c = await api('GET', `/api/classes/${id}`);
      const el = open(
        `<h2>${esc(c.name)}</h2>
        <p class="hint">Run by ${esc(c.owner)}. Only people in this class can see what is shared here.</p>
        ${c.manage ? `<p>Class code: <b class="code">${esc(c.code)}</b><br><small class="hint">Give this code to your students (Gallery, then Join a class).</small></p>` : ''}
        ${cards(c.dioramas, { takedown: c.manage })}
        <p>People</p>
        <ul class="members">${c.members
          .map(
            (m) => `<li><span>${esc(m.username)}${m.isOwner ? ' <small class="hint">(teacher)</small>' : ''}</span>${
              c.manage && !m.isOwner
                ? `<details class="menu"><summary aria-label="Options for ${esc(m.username)}" title="Options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></summary><div class="menulist"><button type="button" data-transfer="${esc(m.username)}">Make teacher</button><button type="button" class="danger" data-remove="${esc(m.username)}">Remove from class</button></div></details>`
                : ''
            }</li>`,
          )
          .join('')}</ul>
        <p class="error" id="classError" hidden></p>
        <div class="row"><button type="button" data-act="back">← Gallery</button>${c.isOwner ? '<button type="button" class="danger" data-act="delete">Delete class</button>' : '<button type="button" data-act="leave">Leave class</button>'}<button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      el.addEventListener('click', (e) => el.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; }));
      const run = (fn) => async () => {
        try {
          await fn();
        } catch (err) {
          fail($('#classError', el), err);
        }
      };
      el.querySelectorAll('[data-takedown]').forEach((b) => (b.onclick = run(async () => {
        if (!confirm('Take this diorama out of the class? The author keeps it (only they can see it).')) return;
        await api('POST', `/api/classes/${id}/takedown`, { dioramaId: Number(b.dataset.takedown) });
        classView(id);
      })));
      el.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = run(async () => {
        if (!confirm(`Remove ${b.dataset.remove} from the class? Their dioramas leave the class but they keep them.`)) return;
        await api('POST', `/api/classes/${id}/remove`, { username: b.dataset.remove });
        classView(id);
      })));
      el.querySelectorAll('[data-transfer]').forEach((b) => (b.onclick = run(async () => {
        if (!confirm(`Hand this class over to ${b.dataset.transfer}? They become the teacher and can remove people, change the code and delete the class. You stay in the class as a member.`)) return;
        await api('POST', `/api/classes/${id}/transfer`, { username: b.dataset.transfer });
        ctx.toast(`${b.dataset.transfer} now runs the class.`);
        classView(id);
      })));
      const del = $('[data-act=delete]', el);
      if (del) del.onclick = run(async () => {
        if (!confirm('Delete this class? Everyone is removed and the dioramas shared to it go back to being private. This cannot be undone.')) return;
        await api('DELETE', `/api/classes/${id}`);
        ctx.toast('Class deleted.');
        galleryView();
      });
      const leave = $('[data-act=leave]', el);
      if (leave) leave.onclick = run(async () => {
        if (!confirm('Leave this class? Your dioramas in it will go back to being private.')) return;
        await api('POST', `/api/classes/${id}/leave`, {});
        ctx.toast('You left the class.');
        galleryView();
      });
      $('[data-act=back]', el).onclick = galleryView;
      $('[data-act=close]', el).onclick = close;
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  async function userGalleryView(username) {
    try {
      const g = await api('GET', `/api/gallery/${encodeURIComponent(username)}`);
      if (g.locked) return unlockView({ kind: 'gallery', id: g.ownerId, owner: g.owner, then: () => userGalleryView(username) });
      const el = open(
        `<h2>${esc(g.owner)}'s gallery</h2>${cards(g.dioramas)}
        <div class="row"><button type="button" data-act="back">← All galleries</button><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      $('[data-act=back]', el).onclick = galleryView;
      $('[data-act=close]', el).onclick = close;
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  // ---------- reviewing reports ----------
  async function reportsView() {
    try {
      const { reports } = await api('GET', '/api/reports'); // no window until there is something to show
      if (!reports.length) {
        await refreshMe(); // someone else already dealt with it: a picked reviewer's button goes away
        if (user && user.isAdmin) {
          const el = open('<h2>Reports</h2><p class="hint">Nothing is waiting for you.</p><div class="row"><button type="button" class="primary" data-act="close">Close</button></div>');
          $('[data-act=close]', el).onclick = close;
        }
        return;
      }
      const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const el = open(
        `<h2>Reports to review</h2>
        <p class="hint">${user.isAdmin ? "You see reports about members' dioramas. A report about an admin's diorama goes to a different admin, or to a random person if there is no other admin. If nobody else can be picked, it is left for Claude to handle." : 'You were picked to look at these reports. Open the diorama, then decide.'}</p>
        ${
          reports.length
            ? reports
                .map(
                  (r) => `<div class="rrow" data-id="${r.id}">
              <div><b>${esc(r.title)}</b> by ${esc(r.owner)}${r.visibility === 'gallery' ? '' : ' (hidden)'}</div>
              <div class="reason">“${esc(r.reason)}”</div>
              <div class="hint">${r.reporter ? 'Reported by ' + esc(r.reporter) + ' · ' : ''}${esc(when(r.createdAt))}${r.pickedForYou ? ' · you were picked to review this' : ''}</div>
              <div class="dactions">
                <button data-do="open" data-diorama="${r.dioramaId}">Open</button>
                <button data-do="dismiss">Dismiss</button>
                <button data-do="hide">Hide from gallery</button>
                <button data-do="delete">Delete</button>
              </div></div>`,
                )
                .join('')
            : '<p class="hint">Nothing is waiting for you.</p>'
        }
        <div class="row"><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      $('[data-act=close]', el).onclick = close;
      el.querySelectorAll('.rrow').forEach((row) => {
        const id = Number(row.dataset.id);
        row.querySelectorAll('[data-do]').forEach((b) => {
          b.onclick = async () => {
            const what = b.dataset.do;
            if (what === 'open') return openDiorama(Number(b.dataset.diorama));
            if (what === 'delete' && !confirm('Delete this diorama for good? The owner will lose it.')) return;
            try {
              await api('POST', `/api/reports/${id}/action`, { action: what });
              ctx.toast(what === 'dismiss' ? 'Report dismissed.' : what === 'hide' ? 'Hidden from the gallery.' : 'Diorama deleted.');
              await refreshMe();
              if (user && user.pendingReports > 0) reportsView();
              else close(); // nothing left: this window closes (and a picked reviewer's button goes away)
            } catch (err) {
              ctx.toast(err.message);
            }
          };
        });
      });
    } catch (err) {
      ctx.toast(err.message);
      close();
      await refreshMe().catch(() => {});
    }
  }

  // ---------- report ----------
  // ---------- feedback: requests and errors are chats, open until someone closes them ----------
  const whenText = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const KIND_NAMES = { feature: 'Feature request', error: 'Something broken' };

  async function feedbackListView() {
    open('<h2>Feedback</h2><p class="hint">Loading…</p>');
    try {
      const { feedback } = await api('GET', '/api/feedback');
      refreshMe().catch(() => {});
      const row = (f) => `<button type="button" data-thread="${f.id}" class="${f.unread ? 'unread' : ''}">
          <span>${f.unread ? '● ' : ''}${esc(f.message.length > 90 ? f.message.slice(0, 90) + '…' : f.message)}</span>
          <span class="meta">${KIND_NAMES[f.kind] || f.kind}${user.isAdmin ? ' · from ' + esc(f.from) : ''} · ${f.replies} repl${f.replies === 1 ? 'y' : 'ies'} · ${esc(whenText(f.updatedAt))}${f.status === 'open' ? '' : ' · closed'}</span>
        </button>`;
      const el = open(
        `<h2>Feedback</h2>
        <p class="hint">${user.isAdmin ? 'Open requests from everyone. Open one to reply or close it.' : 'Ask for a feature or tell us something is broken. It becomes a chat: we can answer you, you can answer back, until it is closed.'}</p>
        <div class="threadlist">${feedback.length ? feedback.map(row).join('') : '<span class="hint">Nothing here yet.</span>'}</div>
        <div class="row"><button type="button" data-act="close">Close</button><button type="button" class="primary" data-act="new">New request</button></div>`,
      );
      $('[data-act=close]', el).onclick = close;
      $('[data-act=new]', el).onclick = feedbackView;
      el.querySelectorAll('[data-thread]').forEach((b) => (b.onclick = () => chatView(Number(b.dataset.thread))));
    } catch (err) {
      ctx.toast(err.message);
      close();
    }
  }

  // A new request: the first message of a chat.
  function feedbackView() {
    const el = open(`
      <h2>New request</h2>
      <p class="hint">Tell the developer what you would like, or what went wrong. You can keep talking about it afterwards.</p>
      <form id="feedbackForm">
        <label>What is it? <select name="kind"><option value="feature">I want a new feature</option><option value="error">Something is broken</option></select></label>
        <label>Details <textarea name="message" rows="5" maxlength="1000" required></textarea></label>
        <p class="error" id="feedbackError" hidden></p>
        <div class="row"><button type="button" data-act="back">Back</button><button type="submit" class="primary">Send</button></div>
      </form>`);
    $('[data-act=back]', el).onclick = feedbackListView;
    $('#feedbackForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const sent = await api('POST', '/api/feedback', { kind: f.get('kind'), message: f.get('message') });
        ctx.toast('Thanks — it was sent. Replies will show here.');
        chatView(sent.id);
      } catch (err) {
        fail($('#feedbackError', el), err);
      }
    };
  }

  // One conversation. New messages show up on their own while this window is open (checked every few seconds).
  async function chatView(id) {
    open('<h2>Conversation</h2><p class="hint">Loading…</p>');
    let thread;
    try {
      thread = await api('GET', `/api/feedback/${id}`);
    } catch (err) {
      ctx.toast(err.message);
      return feedbackListView();
    }
    refreshMe().catch(() => {});
    const bubble = (m) => `<div class="bubble${m.mine ? ' mine' : ''}"><small>${m.mine ? 'You' : esc(m.fromDev ? m.from + ' (developer)' : m.from)} · ${esc(whenText(m.createdAt))}</small>${esc(m.text)}</div>`;
    const closed = thread.status !== 'open';
    const el = open(
      `<h2>${KIND_NAMES[thread.kind] || 'Conversation'} <small>${closed ? 'closed' : 'open'}${user.isAdmin && !thread.mine ? ' · from ' + esc(thread.from) : ''}</small></h2>
      <div class="chatlog" id="chatLog"></div>
      ${
        closed
          ? '<p class="hint">This conversation is closed. Start a new request if there is more to say.</p>'
          : `<form id="chatForm" class="chatform"><textarea name="message" rows="2" maxlength="1000" placeholder="Write a message (Enter sends, Shift+Enter for a new line)" required></textarea><button type="submit" class="primary">Send</button></form>
             <p class="error" id="chatError" hidden></p>`
      }
      <div class="row"><button type="button" data-act="back">Back</button>${closed ? '' : '<button type="button" data-act="done">Close conversation</button>'}</div>`,
    );
    const log = $('#chatLog', el);
    let shown = -1;
    const draw = (t) => {
      if (t.messages.length === shown) return;
      const atEnd = shown < 0 || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      shown = t.messages.length;
      log.innerHTML = t.messages.map(bubble).join('');
      if (atEnd) log.scrollTop = log.scrollHeight;
    };
    draw(thread);
    $('[data-act=back]', el).onclick = feedbackListView;
    if (closed) return;
    const reload = async () => {
      const t = await api('GET', `/api/feedback/${id}`);
      draw(t);
      if (t.status !== 'open') chatView(id); // closed by the other side: show it as closed
    };
    const timer = setInterval(() => {
      if (!panel.open || !body.contains(log)) return clearInterval(timer); // another window replaced this one
      if (!document.hidden) reload().then(() => refreshMe().catch(() => {})).catch(() => {});
    }, 5000);
    const form = $('#chatForm', el);
    const box = $('textarea', form);
    box.focus();
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/feedback/${id}/messages`, { message: box.value });
        box.value = '';
        await reload();
        $('#chatError', el).hidden = true;
      } catch (err) {
        fail($('#chatError', el), err);
      }
    };
    $('[data-act=done]', el).onclick = async () => {
      if (!confirm('Close this conversation? Nobody can reply after it is closed.')) return;
      try {
        await api('POST', `/api/feedback/${id}/done`);
        clearInterval(timer);
        chatView(id);
      } catch (err) {
        fail($('#chatError', el), err);
      }
    };
  }

  function reportView(id, title) {
    const el = open(`
      <h2>Report</h2>
      <p>Tell us what's wrong with “${esc(title)}”. A person will look at it.</p>
      <form id="reportForm">
        <label>What is the problem? <input name="reason" maxlength="300" required autocomplete="off"></label>
        <p class="error" id="reportError" hidden></p>
        <div class="row"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Send report</button></div>
      </form>`);
    $('[data-act=close]', el).onclick = close;
    $('#reportForm', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/report', { dioramaId: id, reason: new FormData(e.target).get('reason') });
        ctx.toast('Thanks — your report was sent.');
        close();
      } catch (err) {
        fail($('#reportError', el), err);
      }
    };
  }

  // ---------- toolbar ----------
  reportsBtn.onclick = reportsView;
  accountBtn.onclick = () => (user ? mineView() : authView());
  feedbackBtn.onclick = () => (user ? feedbackListView() : needSignIn('Sign in to send feedback and chat about it.', feedbackListView));
  galleryBtn.onclick = () => (user ? galleryView() : needSignIn('Sign in to see the gallery.', galleryView));

  // Asked every time the site opens while nobody is signed in.
  function promptIfSignedOut() {
    if (user) return;
    authView({ mode: 'login', skippable: true, message: 'Sign in to save your dioramas online and see the class gallery — or skip this and just build.' });
  }

  // The main Save button: first save asks for a title and who can see it; later saves just update.
  async function save() {
    if (!user) return needSignIn('Sign in to save your diorama to your account.', save);
    const cloud = ctx.getCloud();
    if (cloud && cloud.mine) {
      const ok = await ctx.saveNow();
      ctx.toast(ok ? 'Saved to your account.' : 'Could not save. Check your connection and try again.');
    } else {
      saveView();
    }
  }

  return { openGallery: galleryView, save, promptIfSignedOut, report: (id, title) => reportView(id, title), isSignedIn: () => !!user };
}
