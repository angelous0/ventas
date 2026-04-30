import { createContext, useContext, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * FiltersContext: estado global de filtros del módulo Ventas.
 *
 * Filtros gestionados:
 *  - periodo:  'ytd' | '7' | '30' | '12m'  (default 'ytd')
 *  - tiendas:  string[] (x_nombre)
 *  - marcas:   string[] (UUIDs de prod_marcas)
 *  - tipos:    string[] (UUIDs de prod_tipos)
 *
 * Persistencia: URL search params. Refresh mantiene el estado.
 *  - ?periodo=ytd&tiendas=GR238,GM209&marcas=uuid1,uuid2&tipos=...
 *
 * Uso:
 *  const { filters, setFilters, setPeriodo, setTiendas, ... } = useFilters();
 *
 * Las páginas que no usen un filtro global lo ignoran. Para mandar al backend:
 *  - filters.tiendas.join(',') si la API espera CSV
 *  - filters.tiendas si la API espera array
 */

const PERIODOS_VALIDOS = ['ytd', '7', '30', '12m', 'custom'];
const DEFAULT_PERIODO = 'ytd';

const FiltersContext = createContext(null);

function parseList(s) {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function joinList(arr) {
  if (!arr || arr.length === 0) return '';
  return arr.join(',');
}

export function FiltersProvider({ children }) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Lee del URL (fuente de verdad)
  const filters = useMemo(() => {
    const periodo = searchParams.get('periodo') || DEFAULT_PERIODO;
    return {
      periodo: PERIODOS_VALIDOS.includes(periodo) ? periodo : DEFAULT_PERIODO,
      desde: searchParams.get('desde') || '',  // YYYY-MM-DD (solo si periodo=custom)
      hasta: searchParams.get('hasta') || '',
      tiendas: parseList(searchParams.get('tiendas')),
      marcas: parseList(searchParams.get('marcas')),
      tipos: parseList(searchParams.get('tipos')),
    };
  }, [searchParams]);

  // Setter genérico que actualiza el URL preservando los demás params
  const setFilters = useCallback((patch) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null || v === undefined || v === '' ||
            (Array.isArray(v) && v.length === 0)) {
          next.delete(k);
        } else if (Array.isArray(v)) {
          next.set(k, joinList(v));
        } else {
          next.set(k, String(v));
        }
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Setters individuales para conveniencia
  const setPeriodo = useCallback((v) => setFilters({ periodo: v }), [setFilters]);
  const setTiendas = useCallback((v) => setFilters({ tiendas: v }), [setFilters]);
  const setMarcas = useCallback((v) => setFilters({ marcas: v }), [setFilters]);
  const setTipos = useCallback((v) => setFilters({ tipos: v }), [setFilters]);

  const setRango = useCallback((desde, hasta) => {
    setFilters({ periodo: 'custom', desde, hasta });
  }, [setFilters]);

  const limpiarTodo = useCallback(() => {
    setFilters({ periodo: DEFAULT_PERIODO, desde: '', hasta: '', tiendas: [], marcas: [], tipos: [] });
  }, [setFilters]);

  const algunFiltro = filters.periodo !== DEFAULT_PERIODO ||
    filters.tiendas.length > 0 || filters.marcas.length > 0 || filters.tipos.length > 0;

  const value = useMemo(() => ({
    filters, setFilters, setPeriodo, setTiendas, setMarcas, setTipos, setRango,
    limpiarTodo, algunFiltro,
  }), [filters, setFilters, setPeriodo, setTiendas, setMarcas, setTipos, setRango, limpiarTodo, algunFiltro]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters() {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters debe usarse dentro de <FiltersProvider>');
  return ctx;
}

/**
 * Helper: convierte filtros globales a parámetros para la API.
 * Adapta los nombres según lo que cada endpoint espera.
 *
 * Ejemplos:
 *   buildApiParams(filters, { periodo: 'vista', tiendas: 'tienda', marcas: 'marca_id', tipos: 'tipo_id' })
 *   → { vista: 'ytd', tienda: 'GR238,GM209', marca_id: 'uuid1', tipo_id: 'uuid2' }
 */
export function buildApiParams(filters, mapping = {}) {
  const out = {};
  const map = {
    periodo: mapping.periodo ?? 'periodo',
    tiendas: mapping.tiendas ?? 'tiendas',
    marcas: mapping.marcas ?? 'marcas',
    tipos: mapping.tipos ?? 'tipos',
  };
  if (filters.periodo) out[map.periodo] = filters.periodo;
  if (filters.tiendas?.length) out[map.tiendas] = joinList(filters.tiendas);
  if (filters.marcas?.length) out[map.marcas] = joinList(filters.marcas);
  if (filters.tipos?.length) out[map.tipos] = joinList(filters.tipos);
  return out;
}

export const PERIODOS = [
  { value: 'ytd',    label: 'YTD (acumulado año)' },
  { value: '12m',    label: 'Últimos 12 meses' },
  { value: '30',     label: 'Últimos 30 días' },
  { value: '7',      label: 'Últimos 7 días' },
  { value: 'custom', label: 'Personalizado…' },
];
