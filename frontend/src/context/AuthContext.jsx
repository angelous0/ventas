import { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const AuthContext = createContext(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(localStorage.getItem('ventas_token'));

  useEffect(() => {
    if (token) axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    else delete axios.defaults.headers.common['Authorization'];
  }, [token]);

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (r) => r,
      (error) => {
        if (error.response?.status === 401 && token) {
          localStorage.removeItem('ventas_token');
          setToken(null);
          setUser(null);
          delete axios.defaults.headers.common['Authorization'];
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, [token]);

  useEffect(() => {
    const verify = async () => {
      const saved = localStorage.getItem('ventas_token');
      if (!saved) { setLoading(false); return; }
      try {
        axios.defaults.headers.common['Authorization'] = `Bearer ${saved}`;
        const res = await axios.get(`${API}/auth/me`);
        setUser(res.data);
        setToken(saved);
      } catch {
        localStorage.removeItem('ventas_token');
        setToken(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    verify();
  }, []);

  const login = async (username, password) => {
    const res = await axios.post(`${API}/auth/login`, { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem('ventas_token', access_token);
    setToken(access_token);
    setUser(userData);
    return userData;
  };

  const logout = () => {
    localStorage.removeItem('ventas_token');
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
    isAdmin: () => user?.rol === 'admin',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
