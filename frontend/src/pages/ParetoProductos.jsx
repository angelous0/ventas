import { useEffect, useState, useCallback, Fragment, useMemo } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Loader2, Target, Search, CheckCircle2, AlertTriangle, XCircle, Ghost, ChevronDown, ChevronRight, DollarSign, Package, Boxes, LineChart as LineChartIcon, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from 'recharts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip';
import ExportarVentas from '../components/ExportarVentas';
import { useFilters } from '../context/FiltersContext';

const ESTADO_CONFIG = {
  saludable:       { label: 'Saludable',     cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-300', Icon: CheckCircle2 },
  bajo:            { label: 'Bajo stock',    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-300', Icon: AlertTriangle },
  sin_stock:       { label: 'Sin stock',     cls: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 border-red-300', Icon: XCircle },
  muerto:          { label: 'Muerto',        cls: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-300', Icon: Ghost },
  sin_movimiento:  { label: 'Sin mov.',      cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400 border-zinc-200', Icon: Ghost },
};
import { toast } from 'sonner';

export default function ParetoProductos() {
  const { filters } = useFilters();
  const [grupos, setGrupos] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [metrica, setMetrica] = useState('ventas'); // 'ventas' | 'unidades'
  const [expandido, setExpandido] = useState(null); // key del grupo abierto
  const [pivotData, setPivotData] = useState({});  // key → {tallas, colores, ...}
  const [pivotLoading, setPivotLoading] = useState({});
  const [stockDialog, setStockDialog] = useState(null); // {grupo, loading, data}
  const [ventasDialog, setVentasDialog] = useState(null); // {grupo, loading, data}
  const [timelineDialog, setTimelineDialog] = useState(null); // {tmpl_id, modelo, loading, data}

  // Filtros globales del FiltersContext convertidos a CSV para el backend.
  // Memoizados para evitar refetches por nueva referencia en cada render.
  const tiendaCsv = useMemo(() => filters.tiendas.join(','), [filters.tiendas]);
  const marcaCsv = useMemo(() => filters.marcas.join(','), [filters.marcas]);
  const tipoCsv = useMemo(() => filters.tipos.join(','), [filters.tipos]);

  // Para los diálogos de drill-down: si hay exactamente UNA tienda elegida la
  // resaltamos como "tienda activa". Con multi (>1) no resaltamos una sola; los
  // diálogos siguen filtrando por backend con CSV pero el header muestra "N tiendas".
  const tiendaSel = filters.tiendas.length === 1 ? filters.tiendas[0] : '';
  const tiendaLabel = filters.tiendas.length === 0
    ? ''
    : filters.tiendas.length === 1
      ? filters.tiendas[0]
      : `${filters.tiendas.length} tiendas`;

  // Debounce del query de búsqueda (350ms) para no spamear backend al tipear
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Si los filtros globales cambian, los pivots cacheados quedan inválidos
  // (se calcularon con otra tienda/marca/tipo). Limpiamos al cambio.
  useEffect(() => {
    setPivotData({});
    setExpandido(null);
  }, [tiendaCsv, marcaCsv, tipoCsv]);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const params = { anio_compara: 2025 };
      if (tiendaCsv) params.tienda = tiendaCsv;
      if (marcaCsv) params.marca_id = marcaCsv;
      if (tipoCsv) params.tipo_id = tipoCsv;
      if (qDebounced) params.q = qDebounced;
      const res = await api.get('/productos-odoo/grupos', { params });
      setGrupos(res.data.items || []);
      setTotal(res.data.total_ventas || 0);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [tiendaCsv, marcaCsv, tipoCsv, qDebounced]);

  useEffect(() => { cargar(); }, [cargar]);

  // El query `q` ya se aplica en backend (matchea modelo + marca + tipo + entalle + tela
  // contra el product_template), así que no necesitamos filtrar de nuevo en JS.
  const baseFiltrada = grupos;

  const ordenados = [...baseFiltrada].sort((a, b) => (b[metrica] || 0) - (a[metrica] || 0));
  const totalMetrica = ordenados.reduce((s, g) => s + (g[metrica] || 0), 0);
  let acum = 0;
  const filtrados = ordenados.map(g => {
    const val = g[metrica] || 0;
    acum += val;
    return {
      ...g,
      _share: totalMetrica > 0 ? (val / totalMetrica) * 100 : 0,
      _acum: totalMetrica > 0 ? (acum / totalMetrica) * 100 : 0,
    };
  });

  const maxMetrica = Math.max(...filtrados.map(i => i[metrica] || 0), 1);
  const idx80 = filtrados.findIndex(i => i._acum >= 80);
  const vitales = idx80 === -1 ? filtrados.length : idx80 + 1;

  // Cargar pivot color×talla al expandir (se reusa también para el modal de stock)
  const fetchPivot = useCallback(async (g) => {
    if (pivotData[g.key]) return pivotData[g.key];
    setPivotLoading(p => ({ ...p, [g.key]: true }));
    try {
      const params = {};
      if (g.marca_id) params.marca_id = g.marca_id;
      if (g.tipo_id) params.tipo_id = g.tipo_id;
      if (g.entalle_id) params.entalle_id = g.entalle_id;
      if (g.tela_id) params.tela_id = g.tela_id;
      if (tiendaCsv) params.tienda = tiendaCsv;
      const res = await api.get('/productos-odoo/grupo-color-talla', { params });
      setPivotData(p => ({ ...p, [g.key]: res.data }));
      return res.data;
    } catch (e) {
      toast.error('Error al cargar pivot');
      return null;
    } finally { setPivotLoading(p => ({ ...p, [g.key]: false })); }
  }, [pivotData, tiendaCsv]);

  const togglePivot = async (g) => {
    if (expandido === g.key) { setExpandido(null); return; }
    setExpandido(g.key);
    if (!pivotData[g.key]) await fetchPivot(g);
  };

  // Abrir modal con desglose de modelos que componen el stock total del grupo
  const openStockDialog = async (g, e) => {
    e.stopPropagation(); // no expandir la fila
    setStockDialog({ grupo: g, loading: !pivotData[g.key], data: pivotData[g.key] || null });
    if (!pivotData[g.key]) {
      const data = await fetchPivot(g);
      setStockDialog({ grupo: g, loading: false, data });
    }
  };

  // Abrir modal con timeline de un modelo específico (Modelo · ventas a través del tiempo)
  // Si onlyTienda=false, ignora el filtro de tienda activo (vista global del modelo).
  const openTimelineDialog = async (tmpl_id, modelo, onlyTienda = true) => {
    if (!tmpl_id) {
      toast.error('Modelo sin ID — no se puede mostrar timeline');
      return;
    }
    setTimelineDialog({ tmpl_id, modelo, loading: true, data: null, onlyTienda });
    try {
      const params = { tmpl_id, meses: 18 };
      if (tiendaCsv && onlyTienda) params.tienda = tiendaCsv;
      const res = await api.get('/productos-odoo/grupo-modelo-timeline', { params });
      setTimelineDialog({ tmpl_id, modelo, loading: false, data: res.data, onlyTienda });
    } catch (e) {
      toast.error('Error al cargar timeline');
      setTimelineDialog(null);
    }
  };

  // Abrir modal con desglose de ventas (modelo × color × talla) para el grupo
  const openVentasDialog = async (g, e) => {
    e.stopPropagation();
    setVentasDialog({ grupo: g, loading: true, data: null });
    try {
      const params = {};
      if (g.marca_id) params.marca_id = g.marca_id;
      if (g.tipo_id) params.tipo_id = g.tipo_id;
      if (g.entalle_id) params.entalle_id = g.entalle_id;
      if (g.tela_id) params.tela_id = g.tela_id;
      if (tiendaCsv) params.tienda = tiendaCsv;
      const res = await api.get('/productos-odoo/grupo-ventas-detalle', { params });
      setVentasDialog({ grupo: g, loading: false, data: res.data });
    } catch (e) {
      toast.error('Error al cargar desglose de ventas');
      setVentasDialog(null);
    }
  };

  // Totales (sobre filtrados ya con _share/_acum)
  const totales = filtrados.reduce((acc, g) => ({
    ventas: acc.ventas + (g.ventas || 0),
    unidades: acc.unidades + (g.unidades || 0),
    tickets: acc.tickets + (g.tickets || 0),
    clientes: acc.clientes + (g.clientes_unicos || 0),
    stock: acc.stock + (g.stock || 0),
  }), { ventas: 0, unidades: 0, tickets: 0, clientes: 0, stock: 0 });

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Target className="h-6 w-6 text-primary" /> Pareto por producto
          </h1>
        <p className="text-sm text-muted-foreground">
          Agrupado por <span className="font-medium">marca · tipo · entalle · tela</span> · YTD 2026 ·
          <span className="font-semibold text-foreground ml-1">{filtrados.length}</span> combinaciones ·
          Ventas <span className="font-semibold text-foreground">{formatSoles(totales.ventas)}</span> ·
          Stock <span className="font-semibold text-foreground">{formatNum(totales.stock)}</span> und
          {tiendaLabel && <span className="ml-2 text-primary">· Tienda: <b>{tiendaLabel}</b></span>}
        </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-muted rounded-md p-0.5">
            <Button
              size="sm"
              variant={metrica === 'ventas' ? 'default' : 'ghost'}
              className="h-7 gap-1"
              onClick={() => setMetrica('ventas')}
            >
              <DollarSign className="h-3.5 w-3.5" /> Soles
            </Button>
            <Button
              size="sm"
              variant={metrica === 'unidades' ? 'default' : 'ghost'}
              className="h-7 gap-1"
              onClick={() => setMetrica('unidades')}
            >
              <Package className="h-3.5 w-3.5" /> Unidades
            </Button>
          </div>
          <ExportarVentas tienda={tiendaSel || null} />
        </div>
      </div>

      {/* Buscador local. Marca / Tipo / Tienda viven en la barra global (FiltersContext). */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar modelo / marca / tipo / entalle / tela..." value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
          {q && q !== qDebounced && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Banner 80/20 */}
      {!loading && idx80 !== -1 && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-4 flex items-start gap-3">
            <Target className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div className="text-sm">
              <span className="font-semibold">{vitales} combinacion{vitales !== 1 ? 'es' : ''}</span> concentran el <span className="font-semibold">80%</span> de las ventas
              ({formatSoles(filtrados.slice(0, vitales).reduce((s, it) => s + it.ventas, 0))}).
              Las otras {filtrados.length - vitales} aportan el 20% restante.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla Pareto */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Pareto de ventas</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-320px)]">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="w-7"></th>
                    <th className="text-left py-2 px-3 w-8">#</th>
                    <th className="text-left py-2 px-3">Marca</th>
                    <th className="text-left py-2 px-3">Tipo</th>
                    <th className="text-left py-2 px-3">Entalle</th>
                    <th className="text-left py-2 px-3">Tela</th>
                    <th className="text-left py-2 px-3 w-[18%]">Distribución</th>
                    <th className="text-right py-2 px-3">{metrica === 'ventas' ? 'Ventas' : 'Unidades'}</th>
                    <th className="text-right py-2 px-3">%</th>
                    <th className="text-right py-2 px-3">Acum %</th>
                    <th className="text-right py-2 px-3">Tickets</th>
                    <th className="text-right py-2 px-3">Clientes</th>
                    <th className="text-right py-2 px-3">vs 2025</th>
                    <th className="text-right py-2 px-3">Stock</th>
                    <th className="text-right py-2 px-3" title="Venta promedio por día (unidades YTD / días transcurridos)">Vta/día</th>
                    <th className="text-right py-2 px-3" title="Stock / Venta diaria: cuántos días dura el stock al ritmo actual">Días cob.</th>
                    <th className="text-left py-2 px-3">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map((g, i) => {
                    const destacada = i < vitales;
                    const valor = g[metrica] || 0;
                    const abierto = expandido === g.key;
                    const pivot = pivotData[g.key];
                    return (
                      <Fragment key={g.key}>
                        <tr className={`border-b hover:bg-muted/20 cursor-pointer ${destacada ? 'bg-primary/5' : ''}`} onClick={() => togglePivot(g)}>
                          <td className="py-2 px-1 text-muted-foreground">
                            {abierto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="py-2 px-3 text-muted-foreground font-mono text-xs">{i + 1}</td>
                          <td className="py-2 px-3 font-medium">{g.marca}</td>
                          <td className="py-2 px-3">{g.tipo}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.entalle}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.tela}</td>
                          <td className="py-2 px-3">
                            <div className="relative h-4">
                              <div className="absolute inset-y-0 left-0 bg-primary/70 rounded-sm" style={{ width: `${(valor / maxMetrica) * 100}%` }} />
                              <div className="absolute top-0 bottom-0 border-r-2 border-amber-500 dark:border-amber-400"
                                   style={{ left: `${Math.min(g._acum, 100)}%` }} />
                            </div>
                          </td>
                          <td className="text-right tabular-nums py-2 px-3 font-medium">
                            {valor > 0 ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); openVentasDialog(g, e); }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-background hover:bg-primary hover:text-primary-foreground hover:border-primary text-foreground font-semibold cursor-pointer transition-colors"
                                title="Ver qué se vendió (modelo · color · talla)"
                              >
                                <span>{metrica === 'ventas' ? formatSoles(g.ventas) : formatNum(g.unidades)}</span>
                                <Search className="h-3 w-3 opacity-60" />
                              </button>
                            ) : (
                              <span className="text-muted-foreground">{metrica === 'ventas' ? formatSoles(g.ventas) : formatNum(g.unidades)}</span>
                            )}
                          </td>
                          <td className="text-right tabular-nums py-2 px-3">{g._share.toFixed(2)}%</td>
                          <td className={`text-right tabular-nums py-2 px-3 font-semibold ${destacada ? 'text-primary' : 'text-muted-foreground'}`}>
                            {g._acum.toFixed(2)}%
                          </td>
                          <td className="text-right tabular-nums py-2 px-3">{formatNum(g.tickets)}</td>
                          <td className="text-right tabular-nums py-2 px-3">{formatNum(g.clientes_unicos)}</td>
                          <td className={`text-right tabular-nums py-2 px-3 font-medium ${g.var_pct == null ? 'text-muted-foreground' : g.var_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {g.var_pct == null ? '—' : formatPct(g.var_pct)}
                          </td>
                          <td className="text-right tabular-nums py-2 px-3">
                            {g.stock > 0 ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); openStockDialog(g, e); }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-background hover:bg-primary hover:text-primary-foreground hover:border-primary text-foreground font-semibold cursor-pointer transition-colors"
                                title="Ver modelos que componen este stock"
                              >
                                <span>{formatNum(g.stock)}</span>
                                <Boxes className="h-3 w-3 opacity-60" />
                              </button>
                            ) : <span className="text-muted-foreground">{formatNum(g.stock)}</span>}
                          </td>
                          <td className="text-right tabular-nums py-2 px-3 text-muted-foreground">
                            {g.venta_diaria > 0 ? g.venta_diaria.toFixed(1) : '—'}
                          </td>
                          <td className={`text-right tabular-nums py-2 px-3 ${
                            g.dias_cobertura == null ? 'text-muted-foreground' :
                            g.dias_cobertura < 14 ? 'text-amber-600 font-semibold' :
                            g.dias_cobertura < 30 ? 'text-amber-500' : ''
                          }`}>
                            {g.dias_cobertura == null ? '—' : `${g.dias_cobertura.toFixed(0)}d`}
                          </td>
                          <td className="py-2 px-3">
                            {(() => {
                              const cfg = ESTADO_CONFIG[g.estado_stock];
                              if (!cfg) return null;
                              const Icon = cfg.Icon;
                              return (
                                <Badge variant="outline" className={`${cfg.cls} text-[10px] gap-1`}>
                                  <Icon className="h-2.5 w-2.5" />{cfg.label}
                                </Badge>
                              );
                            })()}
                          </td>
                        </tr>
                        {abierto && (
                          <tr key={g.key + '-pivot'}>
                            <td colSpan={17} className="bg-muted/20 p-0">
                              {pivotLoading[g.key] ? (
                                <div className="flex items-center justify-center h-24"><Loader2 className="h-5 w-5 animate-spin" /></div>
                              ) : pivot && pivot.colores && pivot.colores.length > 0 ? (
                                <TooltipProvider delayDuration={150}><div className="px-4 py-3">
                                  <div className="text-xs text-muted-foreground mb-2">
                                    {pivot.total_colores} colores · {pivot.tallas.length} tallas · valores: <b>vendido / stock</b>
                                    {tiendaLabel && <span className="ml-2 text-primary">· Tienda: {tiendaLabel}</span>}
                                  </div>
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                      <thead className="text-muted-foreground border-b">
                                        <tr>
                                          <th className="text-left py-1.5 px-2">Color</th>
                                          {pivot.tallas.map(t => (
                                            <th key={t} className="text-right py-1.5 px-2 w-16">{t}</th>
                                          ))}
                                          <th className="text-right py-1.5 px-2 font-semibold">Vendido</th>
                                          <th className="text-right py-1.5 px-2 font-semibold">Stock</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {pivot.colores.map(c => (
                                          <tr key={c.color} className="border-b border-muted/40 hover:bg-background/50">
                                            <td className="py-1.5 px-2 font-medium">{c.color}</td>
                                            {pivot.tallas.map(t => {
                                              const v = c.tallas_ventas[t] || 0;
                                              const s = c.tallas_stock[t] || 0;
                                              const otras = c.tallas_otras?.[t] || {};
                                              const otrasEntries = Object.entries(otras)
                                                .filter(([t2]) => !tiendaSel || t2 !== tiendaSel)
                                                .sort((a, b) => b[1] - a[1]);
                                              const totalOtras = otrasEntries.reduce((acc, [, q]) => acc + q, 0);
                                              const modelos = c.tallas_modelos?.[t] || [];
                                              const modelosNuevos = modelos.filter(m => m.es_nuevo);
                                              const modelosEnTiendas = modelos.filter(m => !m.es_nuevo);
                                              const sinStock = v > 0 && s === 0;
                                              const vacio = v === 0 && s === 0;

                                              const cellContent = (
                                                <span>
                                                  {v > 0 ? formatNum(v) : '0'}
                                                  <span className="text-muted-foreground">/{s > 0 ? formatNum(s) : '0'}</span>
                                                </span>
                                              );

                                              return (
                                                <td key={t} className={`text-right tabular-nums py-1.5 px-2 ${sinStock ? 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 font-semibold' : vacio ? 'text-muted-foreground/40' : ''}`}>
                                                  {vacio && otrasEntries.length === 0 ? '—' : (
                                                    <Tooltip delayDuration={150}>
                                                      <TooltipTrigger asChild>
                                                        <span className="cursor-help">{vacio ? '—' : cellContent}</span>
                                                      </TooltipTrigger>
                                                      <TooltipContent side="top" className="bg-popover text-popover-foreground border shadow-md max-w-md">
                                                        <div className="text-xs space-y-1.5">
                                                          <div className="font-semibold border-b pb-1">{c.color} · talla {t}</div>
                                                          <div className="grid grid-cols-2 gap-x-3">
                                                            <span className="text-muted-foreground">Vendido YTD:</span>
                                                            <span className="text-right font-medium">{formatNum(v)}</span>
                                                            {tiendaSel && (
                                                              <Fragment>
                                                                <span className="text-muted-foreground">Stock {tiendaSel}:</span>
                                                                <span className="text-right font-medium">{formatNum(s)}</span>
                                                              </Fragment>
                                                            )}
                                                          </div>
                                                          {otrasEntries.length > 0 && (
                                                            <div className="border-t pt-1.5">
                                                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                                                                Stock por tienda ({formatNum(totalOtras)})
                                                              </div>
                                                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                                                {otrasEntries.map(([t2, q]) => (
                                                                  <Fragment key={t2}>
                                                                    <span className="text-foreground">{t2}:</span>
                                                                    <span className="text-right tabular-nums font-medium">{formatNum(q)}</span>
                                                                  </Fragment>
                                                                ))}
                                                              </div>
                                                            </div>
                                                          )}
                                                          {modelosEnTiendas.length > 0 && (
                                                            <div className="border-t pt-1.5">
                                                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                                                                Modelos en circulación ({modelosEnTiendas.length})
                                                              </div>
                                                              <div className="space-y-0.5 max-h-40 overflow-auto">
                                                                {modelosEnTiendas.slice(0, 8).map(m => (
                                                                  <div key={m.modelo} className="flex items-center justify-between gap-2">
                                                                    <span className="font-medium truncate">{m.modelo}</span>
                                                                    <span className="text-muted-foreground text-[10px] shrink-0">
                                                                      {Object.entries(m.ubicaciones).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([k, q]) => `${k}:${formatNum(q)}`).join(' · ')}
                                                                    </span>
                                                                  </div>
                                                                ))}
                                                                {modelosEnTiendas.length > 8 && (
                                                                  <div className="text-[10px] text-muted-foreground italic">+ {modelosEnTiendas.length - 8} más...</div>
                                                                )}
                                                              </div>
                                                            </div>
                                                          )}
                                                          {modelosNuevos.length > 0 && (
                                                            <div className="border-t pt-1.5">
                                                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                                                                <span className="text-emerald-600 dark:text-emerald-400">🆕 Nuevos</span> ({modelosNuevos.length}) — solo en almacén
                                                              </div>
                                                              <div className="space-y-0.5 max-h-32 overflow-auto">
                                                                {modelosNuevos.slice(0, 8).map(m => (
                                                                  <div key={m.modelo} className="flex items-center justify-between gap-2">
                                                                    <span className="font-medium truncate text-emerald-700 dark:text-emerald-300">{m.modelo}</span>
                                                                    <span className="text-muted-foreground text-[10px] shrink-0">
                                                                      {Object.entries(m.ubicaciones).map(([k, q]) => `${k}:${formatNum(q)}`).join(' · ')}
                                                                    </span>
                                                                  </div>
                                                                ))}
                                                                {modelosNuevos.length > 8 && (
                                                                  <div className="text-[10px] text-muted-foreground italic">+ {modelosNuevos.length - 8} más...</div>
                                                                )}
                                                              </div>
                                                            </div>
                                                          )}
                                                          {otrasEntries.length === 0 && tiendaSel && s === 0 && (
                                                            <div className="text-amber-600 text-[11px]">⚠ Sin stock en ninguna tienda</div>
                                                          )}
                                                        </div>
                                                      </TooltipContent>
                                                    </Tooltip>
                                                  )}
                                                </td>
                                              );
                                            })}
                                            <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(c.unidades_total)}</td>
                                            <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(c.stock_total)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="text-[10px] text-muted-foreground mt-2 flex gap-3 flex-wrap">
                                    <span><span className="inline-block w-3 h-3 bg-red-100 dark:bg-red-950/40 align-middle mr-1"></span>Vendió pero sin stock (oportunidad perdida)</span>
                                    <span>· Formato: <b>vendido</b> / stock {tiendaLabel ? `en ${tiendaLabel}` : ''}</span>
                                    <span>· 💡 Hover en una celda → modelos disponibles · 🆕 = nuevo (solo TALLER/AP)</span>
                                  </div>
                                </div></TooltipProvider>
                              ) : (
                                <div className="text-center text-xs text-muted-foreground py-3">Sin datos color×talla</div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-primary/20 bg-muted/50 font-semibold">
                  <tr>
                    <td colSpan={6} className="py-2 px-3 text-xs uppercase tracking-wide text-muted-foreground">
                      TOTAL ({filtrados.length} combinaciones)
                    </td>
                    <td className="py-2 px-3"></td>
                    <td className="text-right tabular-nums py-2 px-3">
                      {metrica === 'ventas' ? formatSoles(totales.ventas) : formatNum(totales.unidades)}
                    </td>
                    <td className="text-right tabular-nums py-2 px-3">100%</td>
                    <td className="text-right tabular-nums py-2 px-3">—</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(totales.tickets)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(totales.clientes)}</td>
                    <td className="text-right tabular-nums py-2 px-3 text-muted-foreground">—</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(totales.stock)}</td>
                    <td className="text-right tabular-nums py-2 px-3 text-muted-foreground">—</td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3"></td>
                  </tr>
                </tfoot>
              </table>
              <div className="px-4 py-2 text-[11px] text-muted-foreground border-t flex items-center gap-4">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-primary/70 rounded-sm inline-block" /> Share</span>
                <span className="flex items-center gap-1.5"><span className="w-0.5 h-3 bg-amber-500 inline-block" /> Acumulado</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-primary/5 border border-primary/20 rounded-sm inline-block" /> Dentro del 80%</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal: desglose de modelos que componen el stock total del grupo */}
      <StockModelosDialog
        open={!!stockDialog}
        onClose={() => setStockDialog(null)}
        state={stockDialog}
        tiendaSel={tiendaSel}
        onClickModelo={openTimelineDialog}
      />

      {/* Modal: desglose de ventas YTD por modelo · color · talla */}
      <VentasDetalleDialog
        open={!!ventasDialog}
        onClose={() => setVentasDialog(null)}
        state={ventasDialog}
        tiendaSel={tiendaSel}
        metrica={metrica}
        onClickModelo={openTimelineDialog}
      />

      {/* Modal: timeline de ventas de UN modelo específico */}
      <ModeloTimelineDialog
        open={!!timelineDialog}
        onClose={() => setTimelineDialog(null)}
        state={timelineDialog}
        tiendaSel={tiendaSel}
        onReabrir={openTimelineDialog}
      />
    </div>
  );
}

// =================================================================
// Dialog: muestra los modelos que componen el stock total de un grupo
// (marca · tipo · entalle · tela). Agrega los datos ya cargados del pivot.
// =================================================================
function StockModelosDialog({ open, onClose, state, tiendaSel, onClickModelo }) {
  const { grupo, loading, data } = state || {};

  // Agregar modelos del pivot.
  // Si hay filtro de tienda → solo cuenta el stock de esa tienda (matchea el "16" de la fila).
  // Si no → suma todas las ubicaciones (modo global).
  const modelos = useMemo(() => {
    if (!data || !data.colores) return [];
    const acum = {};
    for (const c of data.colores) {
      const tallasModelos = c.tallas_modelos || {};
      for (const talla of Object.keys(tallasModelos)) {
        for (const m of (tallasModelos[talla] || [])) {
          const ubic = m.ubicaciones || {};
          const cantidad = tiendaSel
            ? Number(ubic[tiendaSel] || 0)
            : Number(m.total || 0);
          // Si hay filtro de tienda y este modelo no tiene stock ahí → saltar
          if (tiendaSel && cantidad === 0) continue;
          if (cantidad === 0) continue;

          const key = m.modelo;
          if (!acum[key]) {
            acum[key] = {
              tmpl_id: m.tmpl_id || null,
              modelo: m.modelo,
              total: 0,
              colores: new Set(),
              tallas: new Set(),
              es_nuevo: m.es_nuevo,
              ultima_venta: m.ultima_venta || null,
            };
          }
          acum[key].total += cantidad;
          acum[key].colores.add(c.color);
          acum[key].tallas.add(talla);
          if (!m.es_nuevo) acum[key].es_nuevo = false;
          // Quedarnos con la fecha más reciente entre celdas del mismo modelo
          if (m.ultima_venta && (!acum[key].ultima_venta || m.ultima_venta > acum[key].ultima_venta)) {
            acum[key].ultima_venta = m.ultima_venta;
          }
        }
      }
    }
    const arr = Object.values(acum).map(m => ({
      ...m,
      colores: Array.from(m.colores),
      tallas: Array.from(m.tallas),
    }));
    arr.sort((a, b) => b.total - a.total);
    return arr;
  }, [data, tiendaSel]);

  // Formato fecha dd/mm/yy + indicador relativo si es reciente
  const fmtFecha = (iso) => {
    if (!iso) return <span className="text-muted-foreground/60">nunca</span>;
    const d = new Date(iso + 'T12:00:00');
    const hoy = new Date();
    const dias = Math.floor((hoy - d) / (1000 * 60 * 60 * 24));
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const fecha = `${dd}/${mm}/${yy}`;
    if (dias === 0) return `${fecha} · hoy`;
    if (dias === 1) return `${fecha} · ayer`;
    if (dias < 30) return `${fecha} · hace ${dias}d`;
    return fecha;
  };
  const colorFecha = (iso) => {
    if (!iso) return 'text-red-600 dark:text-red-400';
    const dias = Math.floor((new Date() - new Date(iso + 'T12:00:00')) / (1000 * 60 * 60 * 24));
    if (dias > 365) return 'text-red-600 dark:text-red-400';
    if (dias > 180) return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
  };

  const totalStock = modelos.reduce((s, m) => s + m.total, 0);
  const totalNuevos = modelos.filter(m => m.es_nuevo).length;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-primary" /> Modelos en stock
          </DialogTitle>
          {grupo && (
            <DialogDescription>
              <b>{grupo.marca}</b> · {grupo.tipo} · {grupo.entalle} · {grupo.tela}
              {tiendaSel && <span className="ml-2 text-primary">· Tienda: <b>{tiendaSel}</b></span>}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center h-40"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : modelos.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">Sin modelos con stock para este grupo.</div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground border-b pb-2">
              <b className="text-foreground">{modelos.length}</b> modelos · <b className="text-foreground">{formatNum(totalStock)}</b> unidades en total
              {tiendaSel && <> · en <b className="text-primary">{tiendaSel}</b></>}
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-2 px-2">Modelo</th>
                  <th className="text-right py-2 px-2 w-20">Cantidad</th>
                  <th className="text-left py-2 px-2 w-36">Última venta {tiendaSel && <span className="text-[10px] font-normal">en {tiendaSel}</span>}</th>
                </tr>
              </thead>
              <tbody>
                {modelos.map((m, i) => (
                  <tr key={m.modelo} className={`border-b hover:bg-muted/30 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                    <td className="py-1.5 px-2 font-medium">
                      {m.es_nuevo && <span className="text-[10px] mr-1" title="Solo en TALLER/AP">🆕</span>}
                      {m.tmpl_id ? (
                        <button
                          onClick={() => onClickModelo && onClickModelo(m.tmpl_id, m.modelo)}
                          className="hover:text-primary hover:underline cursor-pointer text-left"
                          title="Ver timeline de ventas"
                        >
                          {m.modelo} <LineChartIcon className="inline h-3 w-3 opacity-50 ml-0.5" />
                        </button>
                      ) : m.modelo}
                    </td>
                    <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(m.total)}</td>
                    <td className={`py-1.5 px-2 text-xs tabular-nums whitespace-nowrap ${colorFecha(m.ultima_venta)}`}>
                      {fmtFecha(m.ultima_venta)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 bg-muted/40 font-semibold">
                <tr>
                  <td className="py-2 px-2 text-xs uppercase text-muted-foreground">Total</td>
                  <td className="text-right tabular-nums py-2 px-2">{formatNum(totalStock)}</td>
                  <td className="py-2 px-2"></td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// =================================================================
// Dialog: desglose de ventas YTD por modelo · color · talla.
// Llama al endpoint /grupo-ventas-detalle con los IDs del grupo.
// =================================================================
function VentasDetalleDialog({ open, onClose, state, tiendaSel, metrica, onClickModelo }) {
  const { grupo, loading, data } = state || {};
  const items = data?.items || [];
  const totalUnidades = data?.total_unidades || 0;
  const totalVentas = data?.total_ventas || 0;
  const totalLineas = data?.total_lineas || 0;

  // Agrupar por modelo para vista colapsada
  const porModelo = useMemo(() => {
    const acum = {};
    for (const it of items) {
      if (!acum[it.modelo]) {
        acum[it.modelo] = {
          tmpl_id: it.tmpl_id || null,
          modelo: it.modelo, unidades: 0, ventas: 0, tickets: 0,
          variantes: [], primera_venta: null, ultima_venta: null,
        };
      }
      acum[it.modelo].unidades += it.unidades;
      acum[it.modelo].ventas += it.ventas;
      acum[it.modelo].tickets += it.tickets;
      acum[it.modelo].variantes.push({
        color: it.color, talla: it.talla, unidades: it.unidades, ventas: it.ventas,
        primera_venta: it.primera_venta, ultima_venta: it.ultima_venta,
      });
      // Conservar fechas extremas a nivel modelo
      if (it.primera_venta && (!acum[it.modelo].primera_venta || it.primera_venta < acum[it.modelo].primera_venta)) {
        acum[it.modelo].primera_venta = it.primera_venta;
      }
      if (it.ultima_venta && (!acum[it.modelo].ultima_venta || it.ultima_venta > acum[it.modelo].ultima_venta)) {
        acum[it.modelo].ultima_venta = it.ultima_venta;
      }
    }
    const arr = Object.values(acum);
    for (const m of arr) m.variantes.sort((a, b) => b.unidades - a.unidades);
    arr.sort((a, b) => b.unidades - a.unidades);
    return arr;
  }, [items]);

  const [verDetalle, setVerDetalle] = useState(false);

  // Formato fecha dd/mm/yy + indicador relativo si es reciente
  const fmtFecha = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00');
    const hoy = new Date();
    const dias = Math.floor((hoy - d) / (1000 * 60 * 60 * 24));
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const fecha = `${dd}/${mm}/${yy}`;
    if (dias === 0) return `${fecha} · hoy`;
    if (dias === 1) return `${fecha} · ayer`;
    if (dias < 30) return `${fecha} · hace ${dias}d`;
    return fecha;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5 text-primary" /> Desglose de ventas YTD
          </DialogTitle>
          {grupo && (
            <DialogDescription>
              <b>{grupo.marca}</b> · {grupo.tipo} · {grupo.entalle} · {grupo.tela}
              {tiendaSel && <span className="ml-2 text-primary">· Tienda: <b>{tiendaSel}</b></span>}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center h-40"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">Sin ventas en este grupo.</div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground border-b pb-2 flex flex-wrap gap-x-4 gap-y-1 items-center">
              <span><b className="text-foreground">{porModelo.length}</b> modelos</span>
              <span><b className="text-foreground">{totalLineas}</b> variantes</span>
              <span><b className="text-foreground">{formatNum(totalUnidades)}</b> unidades</span>
              <span><b className="text-foreground">{formatSoles(totalVentas)}</b></span>
              {tiendaSel && <span className="text-primary">· {tiendaSel}</span>}
              <button
                onClick={() => setVerDetalle(v => !v)}
                className="ml-auto text-xs text-primary hover:underline"
              >
                {verDetalle ? '▾ Ocultar variantes' : '▸ Ver color · talla'}
              </button>
            </div>

            {!verDetalle ? (
              // Vista compacta: por modelo
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-2 px-2">Modelo</th>
                    <th className="text-right py-2 px-2 w-20">Unidades</th>
                    <th className="text-right py-2 px-2 w-28">Ventas</th>
                    <th className="text-left py-2 px-2 w-32">Última venta</th>
                    <th className="text-left py-2 px-2 w-24 text-[10px]">Primera venta</th>
                    <th className="text-right py-2 px-2 w-16 text-[10px]">Variantes</th>
                  </tr>
                </thead>
                <tbody>
                  {porModelo.map((m, i) => (
                    <tr key={m.modelo} className={`border-b hover:bg-muted/30 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                      <td className="py-1.5 px-2 font-medium">
                        {m.tmpl_id ? (
                          <button
                            onClick={() => onClickModelo && onClickModelo(m.tmpl_id, m.modelo)}
                            className="hover:text-primary hover:underline cursor-pointer text-left"
                            title="Ver timeline de ventas"
                          >
                            {m.modelo} <LineChartIcon className="inline h-3 w-3 opacity-50 ml-0.5" />
                          </button>
                        ) : m.modelo}
                      </td>
                      <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(m.unidades)}</td>
                      <td className="text-right tabular-nums py-1.5 px-2">{formatSoles(m.ventas)}</td>
                      <td className="py-1.5 px-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{fmtFecha(m.ultima_venta)}</td>
                      <td className="py-1.5 px-2 text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">{fmtFecha(m.primera_venta)}</td>
                      <td className="text-right tabular-nums py-1.5 px-2 text-[10px] text-muted-foreground">{m.variantes.length}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/40 font-semibold">
                  <tr>
                    <td className="py-2 px-2 text-xs uppercase text-muted-foreground">Total</td>
                    <td className="text-right tabular-nums py-2 px-2">{formatNum(totalUnidades)}</td>
                    <td className="text-right tabular-nums py-2 px-2">{formatSoles(totalVentas)}</td>
                    <td colSpan={3} className="py-2 px-2 text-right text-[10px] text-muted-foreground">{totalLineas} variantes</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              // Vista detallada: una fila por (modelo, color, talla)
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-2 px-2">Modelo</th>
                    <th className="text-left py-2 px-2 w-24">Color</th>
                    <th className="text-left py-2 px-2 w-16">Talla</th>
                    <th className="text-right py-2 px-2 w-20">Unidades</th>
                    <th className="text-right py-2 px-2 w-28">Ventas</th>
                    <th className="text-left py-2 px-2 w-32">Última venta</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={`${it.modelo}-${it.color}-${it.talla}-${i}`}
                        className={`border-b hover:bg-muted/30 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                      <td className="py-1.5 px-2 font-medium truncate max-w-[260px]">{it.modelo}</td>
                      <td className="py-1.5 px-2 text-muted-foreground">{it.color}</td>
                      <td className="py-1.5 px-2 tabular-nums">{it.talla}</td>
                      <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(it.unidades)}</td>
                      <td className="text-right tabular-nums py-1.5 px-2">{formatSoles(it.ventas)}</td>
                      <td className="py-1.5 px-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{fmtFecha(it.ultima_venta)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/40 font-semibold">
                  <tr>
                    <td colSpan={3} className="py-2 px-2 text-xs uppercase text-muted-foreground">Total ({totalLineas} variantes)</td>
                    <td className="text-right tabular-nums py-2 px-2">{formatNum(totalUnidades)}</td>
                    <td className="text-right tabular-nums py-2 px-2">{formatSoles(totalVentas)}</td>
                    <td className="py-2 px-2"></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// =================================================================
// Dialog: timeline de ventas de UN modelo (recharts).
// Muestra dos gráficos: ventas por mes (línea) y acumulado (área).
// Sirve para diagnosticar rotación lenta vs estacionalidad.
// =================================================================
function ModeloTimelineDialog({ open, onClose, state, tiendaSel, onReabrir }) {
  const { tmpl_id, modelo, loading, data, onlyTienda } = state || {};
  const [granularidad, setGranularidad] = useState('semana'); // dia | semana | mes
  const [metricaChart, setMetricaChart] = useState('unidades'); // unidades | ventas

  // Agrupar serie según granularidad
  const seriePorPeriodo = useMemo(() => {
    if (!data?.serie) return [];
    const acum = {};
    for (const r of data.serie) {
      let bucket;
      if (granularidad === 'dia') {
        bucket = r.dia;
      } else if (granularidad === 'semana') {
        // Lunes de esa semana
        const d = new Date(r.dia + 'T12:00:00');
        const day = d.getDay() || 7;  // domingo=0 → 7
        d.setDate(d.getDate() - day + 1);
        bucket = d.toISOString().slice(0, 10);
      } else { // mes
        bucket = r.dia.slice(0, 7) + '-01';
      }
      if (!acum[bucket]) acum[bucket] = { periodo: bucket, unidades: 0, ventas: 0, tickets: 0 };
      acum[bucket].unidades += r.unidades;
      acum[bucket].ventas += r.ventas;
      acum[bucket].tickets += r.tickets;
    }
    const arr = Object.values(acum).sort((a, b) => a.periodo.localeCompare(b.periodo));
    // Acumulado
    let acumU = 0, acumV = 0;
    for (const r of arr) {
      acumU += r.unidades;
      acumV += r.ventas;
      r.acum_unidades = acumU;
      r.acum_ventas = acumV;
    }
    return arr;
  }, [data, granularidad]);

  // Formato eje X según granularidad
  const fmtX = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    if (granularidad === 'mes') return d.toLocaleDateString('es-PE', { month: 'short', year: '2-digit' });
    if (granularidad === 'semana') return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
    return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
  };

  // Formato Y según métrica
  const fmtY = (v) => metricaChart === 'ventas' ? `S/${(v / 1000).toFixed(0)}k` : `${v}`;
  const fmtTooltipValue = (v) => metricaChart === 'ventas' ? formatSoles(v) : `${formatNum(v)} und`;

  const seriaKey = metricaChart === 'ventas' ? 'ventas' : 'unidades';
  const acumKey = metricaChart === 'ventas' ? 'acum_ventas' : 'acum_unidades';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" /> Timeline de ventas
          </DialogTitle>
          <DialogDescription>
            <b>{modelo || data?.modelo || '...'}</b>
            {tiendaSel && onlyTienda && <span className="ml-2 text-primary">· Solo {tiendaSel}</span>}
            {tiendaSel && !onlyTienda && <span className="ml-2 text-muted-foreground">· Todas las tiendas</span>}
          </DialogDescription>
        </DialogHeader>

        {/* Toggle solo si hay filtro de tienda activo */}
        {tiendaSel && (
          <div className="flex gap-1 text-xs bg-muted/30 p-1 rounded w-fit">
            <button
              onClick={() => onlyTienda || (onReabrir && onReabrir(tmpl_id, modelo, true))}
              className={`px-3 py-1 rounded ${onlyTienda ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}
            >Solo {tiendaSel}</button>
            <button
              onClick={() => !onlyTienda || (onReabrir && onReabrir(tmpl_id, modelo, false))}
              className={`px-3 py-1 rounded ${!onlyTienda ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}
            >Todas las tiendas</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-60"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : !data || seriePorPeriodo.length === 0 ? (
          <div className="text-center text-sm py-12 space-y-3">
            <div className="text-muted-foreground">
              Sin ventas en los últimos 18 meses{tiendaSel && onlyTienda ? ` en ${tiendaSel}` : ''}.
            </div>
            {tiendaSel && onlyTienda && (
              <button
                onClick={() => onReabrir && onReabrir(tmpl_id, modelo, false)}
                className="text-primary hover:underline text-sm"
              >→ Ver ventas globales (todas las tiendas)</button>
            )}
          </div>
        ) : (
          <>
            {/* KPIs rápidos */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs border-b pb-3">
              <div className="p-2 bg-muted/30 rounded">
                <div className="text-muted-foreground">Unidades vendidas</div>
                <div className="text-base font-semibold tabular-nums">{formatNum(data.total_unidades)}</div>
              </div>
              <div className="p-2 bg-muted/30 rounded">
                <div className="text-muted-foreground">Ventas totales</div>
                <div className="text-base font-semibold tabular-nums">{formatSoles(data.total_ventas)}</div>
              </div>
              <div className="p-2 bg-muted/30 rounded">
                <div className="text-muted-foreground">Stock actual</div>
                <div className="text-base font-semibold tabular-nums">{formatNum(data.stock_actual)} und</div>
              </div>
              <div className={`p-2 rounded ${
                data.dias_cobertura == null ? 'bg-muted/30' :
                data.dias_cobertura > 365 ? 'bg-red-100 dark:bg-red-950/30' :
                data.dias_cobertura > 180 ? 'bg-amber-100 dark:bg-amber-950/30' :
                'bg-emerald-100 dark:bg-emerald-950/30'
              }`}>
                <div className="text-muted-foreground">Días cobertura</div>
                <div className="text-base font-semibold tabular-nums">
                  {data.dias_cobertura == null ? '—' : `${data.dias_cobertura}d`}
                </div>
              </div>
            </div>

            {/* Toggles */}
            <div className="flex gap-2 flex-wrap items-center text-xs">
              <span className="text-muted-foreground">Granularidad:</span>
              {['dia', 'semana', 'mes'].map(g => (
                <button key={g} onClick={() => setGranularidad(g)}
                  className={`px-2 py-1 rounded border ${granularidad === g ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
                >{g === 'dia' ? 'Día' : g === 'semana' ? 'Semana' : 'Mes'}</button>
              ))}
              <span className="text-muted-foreground ml-3">Métrica:</span>
              {['unidades', 'ventas'].map(m => (
                <button key={m} onClick={() => setMetricaChart(m)}
                  className={`px-2 py-1 rounded border ${metricaChart === m ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
                >{m === 'ventas' ? 'Soles' : 'Unidades'}</button>
              ))}
              <span className="ml-auto text-[10px] text-muted-foreground">{seriePorPeriodo.length} períodos · 18 meses</span>
            </div>

            {/* Gráfico 1: Línea por período */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                {metricaChart === 'ventas' ? 'Ventas' : 'Unidades'} por {granularidad === 'dia' ? 'día' : granularidad}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={seriePorPeriodo} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="periodo" tick={{ fontSize: 10 }} tickFormatter={fmtX} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtY} width={50} />
                  <RTooltip
                    labelFormatter={fmtX}
                    formatter={(v) => [fmtTooltipValue(v), metricaChart === 'ventas' ? 'Ventas' : 'Unidades']}
                    contentStyle={{ fontSize: 11, padding: '6px 10px' }}
                  />
                  <Line type="monotone" dataKey={seriaKey} stroke="hsl(var(--primary))" strokeWidth={2}
                        dot={{ r: 2 }} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Gráfico 2: Acumulado */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                {metricaChart === 'ventas' ? 'Ventas acumuladas' : 'Unidades acumuladas'} (curva en S = ventas constantes; aplanada = se detuvo)
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={seriePorPeriodo} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="periodo" tick={{ fontSize: 10 }} tickFormatter={fmtX} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtY} width={50} />
                  <RTooltip
                    labelFormatter={fmtX}
                    formatter={(v) => [fmtTooltipValue(v), 'Acumulado']}
                    contentStyle={{ fontSize: 11, padding: '6px 10px' }}
                  />
                  <Area type="monotone" dataKey={acumKey} stroke="hsl(var(--primary))"
                        fill="hsl(var(--primary))" fillOpacity={0.2} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Stock por tienda (referencia) */}
            {data.stock_por_tienda && data.stock_por_tienda.length > 0 && (
              <div className="border-t pt-2 text-xs">
                <div className="text-muted-foreground mb-1">Stock actual por ubicación:</div>
                <div className="flex flex-wrap gap-1">
                  {data.stock_por_tienda.map(s => (
                    <Badge key={s.tienda} variant="outline" className={
                      tiendaSel && s.tienda === tiendaSel ? 'bg-primary/10 border-primary text-primary' : ''
                    }>
                      {s.tienda}: <b className="ml-0.5">{formatNum(s.stock)}</b>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
