import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

const FilterContext = createContext();

export function FilterProvider({ children }) {
  const [options, setOptions] = useState({ marcas: [], tipos: [], stores: [], years: [] });
  const [filters, setFilters] = useState({
    marcas: [],
    tipos: [],
    stores: [],
  });

  useEffect(() => {
    api.getFilters().then(setOptions).catch(err => console.error('Failed to load filters:', err));
  }, []);

  const setFilterArray = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ marcas: [], tipos: [], stores: [] });
  }, []);

  const getFilterParams = useCallback(() => {
    const params = {};
    if (filters.marcas.length > 0) params.marca = filters.marcas.join(',');
    if (filters.tipos.length > 0) params.tipo = filters.tipos.join(',');
    if (filters.stores.length > 0) params.store = filters.stores.join(',');
    return params;
  }, [filters]);

  const hasFilters = filters.marcas.length > 0 || filters.tipos.length > 0 || filters.stores.length > 0;

  return (
    <FilterContext.Provider value={{ options, filters, setFilterArray, clearFilters, getFilterParams, hasFilters }}>
      {children}
    </FilterContext.Provider>
  );
}

export const useFilters = () => useContext(FilterContext);
