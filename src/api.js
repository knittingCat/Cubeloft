// Inside the maxos window (this page in a frame, opened with ?embed=maxos) the browser blocks cookies, so the signed-in
// person is carried by a session token that the page keeps itself and sends with every request.
const MAXOS_ORIGIN = 'https://maxos-1oe3.onrender.com';
export const embedded = (() => {
  try {
    return window.parent !== window && new URLSearchParams(location.search).get('embed') === 'maxos';
  } catch {
    return false;
  }
})();
let sessionToken = null;
try {
  if (embedded) sessionToken = sessionStorage.getItem('cubeloft_token');
} catch {}
export const getSessionToken = () => sessionToken;
function keepToken(token) {
  sessionToken = token;
  try {
    token ? sessionStorage.setItem('cubeloft_token', token) : sessionStorage.removeItem('cubeloft_token');
  } catch {}
}

// Tiny wrapper for the server API. The custom header is required by the server (blocks cross-site forms).
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'blockscape', ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((json && json.error) || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}

// False on the plain GitHub Pages copy of the site (no server), true when the account server is there.
export async function accountsAvailable() {
  try {
    const res = await fetch('/api/me', { headers: { 'x-requested-with': 'blockscape' } });
    if (!res.ok) return false;
    const json = await res.json();
    return 'user' in json;
  } catch {
    return false;
  }
}

// Embedded in maxos: ask the maxos page for the person's maxos token and trade it for a Cubeloft session.
// Resolves with the user, or null when nobody is signed in to maxos (or this is not the maxos window).
export async function maxosSignIn() {
  if (!embedded) return null;
  if (sessionToken) {
    try {
      const { user } = await api('GET', '/api/me');
      if (user) return user;
    } catch {}
    keepToken(null);
  }
  const maxosToken = await new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (e) => {
      if (e.origin !== MAXOS_ORIGIN || e.source !== window.parent || !e.data || e.data.type !== 'maxos-token') return;
      done(typeof e.data.token === 'string' ? e.data.token : null);
    };
    const timer = setTimeout(() => done(null), 6000);
    addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'cubeloft-ready' }, MAXOS_ORIGIN);
  });
  if (!maxosToken) return null;
  try {
    const res = await api('POST', '/api/sso/maxos', { token: maxosToken });
    keepToken(res.token);
    return res.user;
  } catch {
    return null;
  }
}

export async function endSession() {
  await api('POST', '/api/logout', {});
  keepToken(null);
}
