import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

const FilterContext = createContext();

export function FilterProvider({ children }) {
  const [options, setOptions] = useState({ marcas: [], tipos: [], stores: [], years: [] });
  const [filters, setFilters] = useState({
    marca: null,
    tipo: null,
    store: null,
  });

  useEffect(() => {
    api.getFilters().then(setOptions).catch(err => console.error('Failed to load filters:', err));
  }, []);

  const setFilter = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ marca: null, tipo: null, store: null });
  }, []);

  const getFilterParams = useCallback(() => {
    const params = {};
    if (filters.marca) params.marca = filters.marca;
    if (filters.tipo) params.tipo = filters.tipo;
    if (filters.store) params.store = filters.store;
    return params;
  }, [filters]);

  return (
    <FilterContext.Provider value={{ options, filters, setFilter, clearFilters, getFilterParams }}>
      {children}
    </FilterContext.Provider>
  );
}

export const useFilters = () => useContext(FilterContext);
