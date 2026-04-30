import axios from 'axios';

export const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export const formatSoles = (n) => {
  if (n == null) return '—';
  return `S/ ${Number(n).toLocaleString('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

export const formatSolesDec = (n) => {
  if (n == null) return '—';
  return `S/ ${Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const formatNum = (n) => {
  if (n == null) return '—';
  return Number(n).toLocaleString('es-PE', { maximumFractionDigits: 0 });
};

export const formatPct = (n) => {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
};

export const api = axios.create({ baseURL: API });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('ventas_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
