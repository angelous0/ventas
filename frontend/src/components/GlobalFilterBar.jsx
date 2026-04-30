import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api';
import { useFilters, PERIODOS } from '../context/FiltersContext';
import { MultiSelect } from './ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';
import { Filter, X, Calendar } from 'lucide-react';
import { format } from 'date-fns';

/**
 * GlobalFilterBar: barra sticky en la parte superior del Layout.
 *
 * Renderiza los filtros globales (período + multi-select de tiendas/marcas/tipos)
 * conectados al FiltersContext. Cualquier página que use useFilters() responde
 * automáticamente a cambios aquí.
 *
 * Carga los catálogos UNA sola vez al montar.
 */
export function GlobalFilterBar() {
  const { filters, setPeriodo, setTiendas, setMarcas, setTipos, setRango, limpiarTodo, algunFiltro } = useFilters();

  const [optTiendas, setOptTiendas] = useState([]);
  const [optMarcas, setOptMarcas] = useState([]);
  const [optTipos, setOptTipos] = useState([]);

  useEffect(() => {
    api.get('/catalogos/tiendas')
      .then(r => setOptTiendas((r.data || []).map(t => ({ value: t.value, label: t.label || t.value }))))
      .catch(() => {});
    api.get('/catalogos/marcas')
      .then(r => setOptMarcas((r.data || []).map(m => ({ value: String(m.id), label: m.nombre }))))
      .catch(() => {});
    api.get('/catalogos/tipos')
      .then(r => setOptTipos((r.data || []).map(t => ({ value: String(t.id), label: t.nombre }))))
      .catch(() => {});
  }, []);

  const periodoLabel = useMemo(() => {
    if (filters.periodo === 'custom' && filters.desde && filters.hasta) {
      try {
        return `${format(new Date(filters.desde), 'd MMM yy')} → ${format(new Date(filters.hasta), 'd MMM yy')}`;
      } catch { return 'Personalizado'; }
    }
    return PERIODOS.find(p => p.value === filters.periodo)?.label || 'YTD';
  }, [filters.periodo, filters.desde, filters.hasta]);

  const handlePeriodoChange = (v) => {
    if (v === 'custom') {
      // Si no hay fechas, abre con default último mes
      if (!filters.desde || !filters.hasta) {
        const hoy = new Date();
        const haceMes = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        setRango(format(haceMes, 'yyyy-MM-dd'), format(hoy, 'yyyy-MM-dd'));
      } else {
        setPeriodo('custom');
      }
    } else {
      setPeriodo(v);
    }
  };

  return (
    <div className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 border-b">
      <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-1 hidden md:inline">Filtros</span>

        {/* Período */}
        <div className="flex items-center gap-1">
          <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={filters.periodo} onValueChange={handlePeriodoChange}>
            <SelectTrigger className="h-8 w-[210px] text-xs"><SelectValue>{periodoLabel}</SelectValue></SelectTrigger>
            <SelectContent>
              {PERIODOS.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.periodo === 'custom' && (
            <RangoCustomPicker
              desde={filters.desde}
              hasta={filters.hasta}
              onChange={setRango}
            />
          )}
        </div>

        {/* Multi-selects */}
        <div className="w-[180px]">
          <MultiSelect options={optTiendas} value={filters.tiendas} onChange={setTiendas}
            placeholder="Todas las tiendas" emptyText="Sin tiendas" className="h-8" />
        </div>
        <div className="w-[180px]">
          <MultiSelect options={optMarcas} value={filters.marcas} onChange={setMarcas}
            placeholder="Todas las marcas" emptyText="Sin marcas" className="h-8" />
        </div>
        <div className="w-[180px]">
          <MultiSelect options={optTipos} value={filters.tipos} onChange={setTipos}
            placeholder="Todos los tipos" emptyText="Sin tipos" className="h-8" />
        </div>

        {algunFiltro && (
          <Button variant="ghost" size="sm" onClick={limpiarTodo} className="h-8 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" /> Limpiar
          </Button>
        )}

        <div className="ml-auto text-[10px] text-muted-foreground hidden lg:block">
          Filtros se mantienen al refrescar
        </div>
      </div>
    </div>
  );
}

/**
 * Popover con dos inputs date para el rango personalizado.
 * Incluye presets útiles: este mes, mes pasado, este trimestre, mismo mes año pasado.
 */
function RangoCustomPicker({ desde, hasta, onChange }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(desde || '');
  const [h, setH] = useState(hasta || '');

  useEffect(() => { setD(desde || ''); setH(hasta || ''); }, [desde, hasta]);

  const aplicar = () => {
    if (d && h && d <= h) {
      onChange(d, h);
      setOpen(false);
    }
  };

  const preset = (offsetDesde, offsetHasta, scope = 'month') => {
    const today = new Date();
    let dt1, dt2;
    if (scope === 'month') {
      dt1 = new Date(today.getFullYear(), today.getMonth() + offsetDesde, 1);
      dt2 = new Date(today.getFullYear(), today.getMonth() + offsetHasta + 1, 0);
    } else if (scope === 'sameMonthLastYear') {
      const m = today.getMonth();
      dt1 = new Date(today.getFullYear() - 1, m, 1);
      dt2 = new Date(today.getFullYear() - 1, m + 1, 0);
    } else if (scope === 'thisQuarter') {
      const q = Math.floor(today.getMonth() / 3);
      dt1 = new Date(today.getFullYear(), q * 3, 1);
      dt2 = today;
    }
    const f = (dt) => format(dt, 'yyyy-MM-dd');
    setD(f(dt1)); setH(f(dt2));
    onChange(f(dt1), f(dt2));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 px-2 text-xs gap-1">
          <Calendar className="h-3.5 w-3.5" /> Editar rango
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-3" align="start">
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rango personalizado</div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">Desde</label>
              <input type="date" value={d} max={h || undefined}
                onChange={e => setD(e.target.value)}
                className="w-full h-8 px-2 text-xs border rounded bg-background" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">Hasta</label>
              <input type="date" value={h} min={d || undefined}
                onChange={e => setH(e.target.value)}
                className="w-full h-8 px-2 text-xs border rounded bg-background" />
            </div>
          </div>

          <div className="border-t pt-2 space-y-1">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Presets</div>
            <div className="grid grid-cols-2 gap-1">
              <PresetBtn onClick={() => preset(0, 0)}>Este mes</PresetBtn>
              <PresetBtn onClick={() => preset(-1, -1)}>Mes pasado</PresetBtn>
              <PresetBtn onClick={() => preset(0, 0, 'thisQuarter')}>Este trimestre</PresetBtn>
              <PresetBtn onClick={() => preset(0, 0, 'sameMonthLastYear')}>
                Mismo mes año pasado
              </PresetBtn>
            </div>
          </div>

          <div className="flex justify-end gap-1 border-t pt-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} className="h-7 text-xs">Cancelar</Button>
            <Button size="sm" onClick={aplicar} disabled={!d || !h || d > h} className="h-7 text-xs">Aplicar</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PresetBtn({ onClick, children }) {
  return (
    <button onClick={onClick}
      className="text-[11px] px-2 py-1 rounded border hover:bg-accent transition-colors text-left">
      {children}
    </button>
  );
}
