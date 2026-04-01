import axios from 'axios';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export const api = {
  getFilters: () => axios.get(`${API}/filters`).then(r => r.data),
  getKpis: (params) => axios.get(`${API}/kpis`, { params }).then(r => r.data),
  getSalesTrend: (params) => axios.get(`${API}/sales-trend`, { params }).then(r => r.data),
  getSalesByYear: (params) => axios.get(`${API}/sales-by-year`, { params }).then(r => r.data),
  getYearMonthly: (params) => axios.get(`${API}/year-monthly`, { params }).then(r => r.data),
  getSalesByMarca: (params) => axios.get(`${API}/sales-by-marca`, { params }).then(r => r.data),
  getSalesByTipo: (params) => axios.get(`${API}/sales-by-tipo`, { params }).then(r => r.data),
  getMarcaTrend: (params) => axios.get(`${API}/marca-trend`, { params }).then(r => r.data),
  getSalesByStore: (params) => axios.get(`${API}/sales-by-store`, { params }).then(r => r.data),
  getStoreTimeline: (params) => axios.get(`${API}/store-timeline`, { params }).then(r => r.data),
  sendChatMessage: (data) => axios.post(`${API}/chat`, data).then(r => r.data),
  getChatHistory: (params) => axios.get(`${API}/chat/history`, { params }).then(r => r.data),
  newChatSession: () => axios.post(`${API}/chat/new`).then(r => r.data),
  getTopClients: (params) => axios.get(`${API}/top-clients`, { params }).then(r => r.data),
  getClientYears: (params) => axios.get(`${API}/client-years`, { params }).then(r => r.data),
  exportExcel: (params) => {
    const queryString = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([_, v]) => v != null))
    ).toString();
    window.open(`${API}/export/excel?${queryString}`, '_blank');
  },
};

export const COLORS = ['#4F46E5', '#38BDF8', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#64748B', '#0EA5E9', '#A855F7'];
export const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export const formatCurrency = (val) => {
  if (val == null || isNaN(val)) return 'S/ 0';
  if (Math.abs(val) >= 1000000) return `S/ ${(val / 1000000).toFixed(1)}M`;
  if (Math.abs(val) >= 1000) return `S/ ${(val / 1000).toFixed(1)}K`;
  return `S/ ${Number(val).toFixed(0)}`;
};

export const formatCurrencyFull = (val) => {
  if (val == null || isNaN(val)) return 'S/ 0.00';
  return `S/ ${Number(val).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const formatNumber = (val) => {
  if (val == null || isNaN(val)) return '0';
  return Number(Math.round(val)).toLocaleString('es-PE');
};

export const formatPercent = (val) => {
  if (val == null || isNaN(val)) return '-';
  return `${val > 0 ? '+' : ''}${val.toFixed(1)}%`;
};

export const calcChange = (current, prev) => {
  if (!prev || prev === 0) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
};
