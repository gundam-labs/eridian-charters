import axios from 'axios';

export const STORAGE_TOKEN = 'meridian_token';

const api = axios.create({
  // Same-origin by default: Vercel rewrites /api/* to the Railway API (frontend/vercel.json)
  // and Vite proxies it in dev, so the browser never makes a cross-site call.
  // Set VITE_API_DIRECT=true to call VITE_API_URL directly instead (needs CORS_ORIGINS on the API).
  baseURL: import.meta.env.VITE_API_DIRECT === 'true' ? (import.meta.env.VITE_API_URL || '') : '',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem(STORAGE_TOKEN);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status;
    const url = err.config?.url || '';
    // A failed login/invite is not a session expiry
    if (status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/accept-invite')) {
      localStorage.removeItem(STORAGE_TOKEN);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login?expired=1';
      }
    }
    return Promise.reject(err);
  }
);

/** Extract a human readable message from an axios error ({error} from API). */
export async function errMsg(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { const j = JSON.parse(await data.text()); return j.error || 'Request failed'; } catch { return 'Request failed'; }
  }
  if (data && typeof data === 'object' && data.error) return data.error;
  if (typeof data === 'string' && data) return data.slice(0, 200);
  if (err?.response?.status) return `Request failed (${err.response.status})`;
  return err?.message || 'Network error — is the API reachable?';
}

export function errText(err) {
  const data = err?.response?.data;
  if (data && typeof data === 'object' && data.error) return data.error;
  if (err?.response?.status) return `Request failed (${err.response.status})`;
  return err?.message || 'Network error — is the API reachable?';
}

/** Fetch a PDF with the auth header and open it in a new tab. */
export async function openPdf(path) {
  // Open the window synchronously so popup blockers allow it
  const win = window.open('', '_blank');
  if (win) win.document.write('<p style="font-family:sans-serif;padding:2rem;color:#0b1b33">Preparing document…</p>');
  try {
    const res = await api.get(path, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
    if (win) win.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (win) win.close();
    throw new Error(await errMsg(e));
  }
}

export default api;
