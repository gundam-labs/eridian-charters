import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { STORAGE_TOKEN } from '../api';

const AuthContext = createContext(null);

export const homeFor = (role) => ({
  member: '/m', sales: '/s', ops: '/o', pilot: '/p', admin: '/admin',
}[role] || '/login');

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_TOKEN);
    if (!token) { setLoading(false); return; }
    api.get('/api/auth/me')
      .then(r => setUser(r.data?.user || r.data))
      .catch(() => { localStorage.removeItem(STORAGE_TOKEN); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  const applySession = useCallback((data) => {
    localStorage.setItem(STORAGE_TOKEN, data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/api/auth/login', { email, password });
    return applySession(r.data);
  }, [applySession]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_TOKEN);
    setUser(null);
    window.location.href = '/login';
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, applySession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
