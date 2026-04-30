import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, formatNum } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import { Loader2, Factory, AlertTriangle, Boxes, TrendingUp, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export default function Produccion() {
  // Filtros
  const [marca, setMarca] = useState('');
  const [tipo, setTipo] = useState('');
  const [entalle, setEntalle] = useState('');
  const [tela, setTela] = useState('');
  const [incluirTaller, setIncluirTaller] = useState(true);

  // Catálogos completos
  const [optMarcas, setOptMarcas] = useState([]);
  const [optTipos, setOptTipos] = useState([]);
  const [optEntalles, setOptEntalles] = useState([]);
  const [optTelas, setOptTelas] = useState([]);
  // Combinaciones reales (para cascading)
  const [combos, setCombos] = useState([]);

  // Datos
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [vista, setVista] = useState('reposicion'); // stock | comparativo | reposicion

  // Cargar catálogos + combinaciones reales (independientes)
  useEffect(() => {
    api.get('/catalogos/marcas').then(r => setOptMarcas(r.data || [])).catch(() => {});
    api.get('/catalogos/tipos').then(r => setOptTipos(r.data || [])).catch(() => {});
    api.get('/catalogos/entalles').then(r => setOptEntalles(r.data || [])).catch(() => {});
    api.get('/catalogos/telas').then(r => setOptTelas(r.data || [])).catch(() => {});
    api.get('/produccion/combinaciones').then(r => setCombos(r.data || [])).catch(() => {});
  }, []);

  // ===== Cascada: filtrar opciones según selecciones previas =====
  // Para cada dimensión, las opciones disponibles son las que aparecen
  // en alguna combinación que respeta los filtros padre.
  const filtrarOpcionesPara = (dim) => {
    // dim ∈ {marca_id, tipo_id, entalle_id, tela_id}
    const seleccion = { marca_id: marca, tipo_id: tipo, entalle_id: entalle, tela_id: tela };
    // Combinaciones que respetan TODAS las selecciones excepto la dim que estamos calculando
    const validas = combos.filter(c =>
      Object.entries(seleccion).every(([k, v]) => k === dim || !v || c[k] === v)
    );
    return new Set(validas.map(c => c[dim]).filter(Boolean));
  };

  const marcasIds = useMemo(() => filtrarOpcionesPara('marca_id'), [combos, tipo, entalle, tela]);
  const tiposIds = useMemo(() => filtrarOpcionesPara('tipo_id'), [combos, marca, entalle, tela]);
  const entallesIds = useMemo(() => filtrarOpcionesPara('entalle_id'), [combos, marca, tipo, tela]);
  const telasIds = useMemo(() => filtrarOpcionesPara('tela_id'), [combos, marca, tipo, entalle]);

  const optMarcasFiltradas = combos.length === 0 ? optMarcas : optMarcas.filter(m => marcasIds.has(String(m.id)));
  const optTiposFiltrados = combos.length === 0 ? optTipos : optTipos.filter(t => tiposIds.has(String(t.id)));
  const optEntallesFiltrados = combos.length === 0 ? optEntalles : optEntalles.filter(e => entallesIds.has(String(e.id)));
  const optTelasFiltradas = combos.length === 0 ? optTelas : optTelas.filter(t => telasIds.has(String(t.id)));

  // Si la selección actual ya no es válida (porque se cambió un filtro padre),
  // limpiarla automáticamente
  useEffect(() => {
    if (combos.length === 0) return;
    if (marca && !marcasIds.has(marca)) setMarca('');
  }, [marca, marcasIds, combos.length]);
  useEffect(() => {
    if (combos.length === 0) return;
    if (tipo && !tiposIds.has(tipo)) setTipo('');
  }, [tipo, tiposIds, combos.length]);
  useEffect(() => {
    if (combos.length === 0) return;
    if (entalle && !entallesIds.has(entalle)) setEntalle('');
  }, [entalle, entallesIds, combos.length]);
  useEffect(() => {
    if (combos.length === 0) return;
    if (tela && !telasIds.has(tela)) setTela('');
  }, [tela, telasIds, combos.length]);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const params = { incluir_taller: incluirTaller };
      if (marca) params.marca_id = marca;
      if (tipo) params.tipo_id = tipo;
      if (entalle) params.entalle_id = entalle;
      if (tela) params.tela_id = tela;
      const res = await api.get('/produccion/pivot-stock', { params });
      setData(res.data);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [marca, tipo, entalle, tela, incluirTaller]);

  useEffect(() => { cargar(); }, [cargar]);

  const limpiar = () => {
    setMarca(''); setTipo(''); setEntalle(''); setTela('');
  };
  const algunFiltro = marca || tipo || entalle || tela;

  // Heatmap por intensidad
  const maxCellStock = data?.colores?.reduce((max, c) => {
    const m = Math.max(...Object.values(c.tallas_stock || {}), 0);
    return Math.max(max, m);
  }, 0) || 1;

  // Detectar tallas con poca cobertura
  const tallasFaltantes = data?.tallas?.filter(t => (data.totales_talla[t] || 0) < 5) || [];

  // Calcular recomendaciones de reposición por celda
  // Lógica: días_cobertura proyectada = (stock + en_proceso) / venta_diaria
  // Si <30d urgente, <60d producir. Crítico si vendió pero stock+OP = 0.
  const recomendaciones = useMemo(() => {
    if (!data || !data.colores) return [];
    const dias = data.dias_ytd || 1;
    const items = [];
    for (const c of data.colores) {
      for (const t of data.tallas) {
        const stock = c.tallas_stock?.[t] || 0;
        const vendido = c.tallas_vendido?.[t] || 0;
        const enProceso = c.tallas_en_proceso?.[t] || 0;
        if (stock === 0 && vendido === 0 && enProceso === 0) continue;
        const ventaDiaria = vendido / dias;
        // Cobertura proyectada considerando lo que se está produciendo
        const stockProyectado = stock + enProceso;
        const diasCobertura = ventaDiaria > 0 ? stockProyectado / ventaDiaria : null;
        // Categorías de prioridad
        let prioridad = 'normal';
        let razon = '';
        if (vendido > 0 && stockProyectado === 0) {
          prioridad = 'critica';
          razon = `Vendió ${vendido} · sin stock ni OPs — oportunidad perdida`;
        } else if (diasCobertura !== null && diasCobertura < 30) {
          prioridad = 'urgente';
          razon = enProceso > 0
            ? `Solo ${Math.round(diasCobertura)}d incluyendo ${enProceso} en producción`
            : `Solo ${Math.round(diasCobertura)}d de cobertura · sin OP en curso`;
        } else if (diasCobertura !== null && diasCobertura < 60) {
          prioridad = 'producir';
          razon = `${Math.round(diasCobertura)}d cobertura proyectada`;
        } else if (stock > 0 && vendido === 0 && enProceso === 0) {
          prioridad = 'sobrestock';
          razon = `${stock} en stock, sin ventas YTD`;
        } else if (diasCobertura !== null && diasCobertura > 365) {
          prioridad = 'sobrestock';
          razon = `${Math.round(diasCobertura)}d cobertura — exceso`;
        }
        items.push({
          color: c.color, talla: t, stock, vendido,
          en_proceso: enProceso,
          stock_proyectado: stockProyectado,
          venta_diaria: ventaDiaria,
          dias_cobertura: diasCobertura,
          prioridad, razon,
          // sugerencia de reposición: cubrir 90d, RESTAR lo que ya está en proceso
          reponer: Math.max(0, Math.ceil(ventaDiaria * 90 - stockProyectado)),
        });
      }
    }
    // Ordenar: críticas → urgentes → producir → resto
    const orden = { critica: 0, urgente: 1, producir: 2, normal: 3, sobrestock: 4 };
    items.sort((a, b) => {
      const d = orden[a.prioridad] - orden[b.prioridad];
      if (d !== 0) return d;
      return (b.vendido - a.vendido); // dentro de cada nivel, los más vendidos primero
    });
    return items;
  }, [data]);

  const recomendacionesProducir = recomendaciones.filter(r =>
    r.prioridad === 'critica' || r.prioridad === 'urgente' || r.prioridad === 'producir'
  );
  const totalReponer = recomendacionesProducir.reduce((s, r) => s + r.reponer, 0);

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Factory className="h-6 w-6 text-primary" /> Producción · Stock por color × talla
        </h1>
        <p className="text-sm text-muted-foreground">
          Filtra por clasificación y revisa qué color/talla necesita reposición.
          Stock global de todas las tiendas e inventarios.
        </p>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Marca <span className="text-muted-foreground">({optMarcasFiltradas.length})</span></Label>
              <Select value={marca || 'all'} onValueChange={v => setMarca(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Todas" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas ({optMarcasFiltradas.length})</SelectItem>
                  {optMarcasFiltradas.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tipo <span className="text-muted-foreground">({optTiposFiltrados.length})</span></Label>
              <Select value={tipo || 'all'} onValueChange={v => setTipo(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos ({optTiposFiltrados.length})</SelectItem>
                  {optTiposFiltrados.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Entalle <span className="text-muted-foreground">({optEntallesFiltrados.length})</span></Label>
              <Select value={entalle || 'all'} onValueChange={v => setEntalle(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos ({optEntallesFiltrados.length})</SelectItem>
                  {optEntallesFiltrados.map(e => <SelectItem key={e.id} value={String(e.id)}>{e.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tela <span className="text-muted-foreground">({optTelasFiltradas.length})</span></Label>
              <Select value={tela || 'all'} onValueChange={v => setTela(v === 'all' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Todas" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas ({optTelasFiltradas.length})</SelectItem>
                  {optTelasFiltradas.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <div className="flex items-center gap-2">
              <Switch id="incluir-taller" checked={incluirTaller} onCheckedChange={setIncluirTaller} />
              <Label htmlFor="incluir-taller" className="text-xs cursor-pointer">
                Incluir TALLER y AP (almacenes)
              </Label>
            </div>
            {algunFiltro && (
              <button onClick={limpiar} className="text-xs text-muted-foreground hover:text-foreground underline">
                Limpiar filtros
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* KPIs rápidos */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="text-muted-foreground">Stock total</div>
            <div className="text-2xl font-bold tabular-nums">{formatNum(data.stock_total)}</div>
          </div>
          <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-900/50">
            <div className="text-muted-foreground">En producción</div>
            <div className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-300">
              {formatNum(data.en_proceso_total || 0)}
            </div>
            <div className="text-[10px] text-muted-foreground">OPs activas con color</div>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="text-muted-foreground">Vendido YTD</div>
            <div className="text-2xl font-bold tabular-nums">{formatNum(data.vendido_total || 0)}</div>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="text-muted-foreground">Colores</div>
            <div className="text-2xl font-bold tabular-nums">{data.total_colores}</div>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="text-muted-foreground">Tallas</div>
            <div className="text-2xl font-bold tabular-nums">{data.tallas?.length || 0}</div>
          </div>
        </div>
      )}

      {/* Pivot */}
      <Card>
        <CardHeader className="pb-2 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">
              Pivot · color × talla
              {!incluirTaller && <span className="text-xs font-normal text-muted-foreground ml-2">(sin TALLER/AP)</span>}
            </CardTitle>
            <div className="flex gap-1 text-xs bg-muted/30 p-0.5 rounded">
              <button onClick={() => setVista('stock')}
                className={`px-3 py-1 rounded gap-1 inline-flex items-center ${vista === 'stock' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                <Boxes className="h-3 w-3" /> Solo stock
              </button>
              <button onClick={() => setVista('comparativo')}
                className={`px-3 py-1 rounded gap-1 inline-flex items-center ${vista === 'comparativo' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                <TrendingUp className="h-3 w-3" /> Stock vs Vendido
              </button>
              <button onClick={() => setVista('reposicion')}
                className={`px-3 py-1 rounded gap-1 inline-flex items-center ${vista === 'reposicion' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                <Sparkles className="h-3 w-3" /> Reposición
              </button>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {vista === 'stock' && 'Stock actual por color × talla. Heatmap azul = más stock.'}
            {vista === 'comparativo' && 'Cada celda: stock arriba / vendido YTD abajo. Compara cobertura vs demanda real.'}
            {vista === 'reposicion' && (
              <>
                Cell color por prioridad de producción ·
                <span className="text-red-600 font-semibold mx-1">🔴 crítica</span> (vendió, sin stock) ·
                <span className="text-amber-600 font-semibold mx-1">🟠 urgente</span> (&lt;30d) ·
                <span className="text-yellow-600 font-semibold mx-1">🟡 producir</span> (&lt;60d) ·
                <span className="text-zinc-500 mx-1">⚪ sobrestock</span>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : !data || data.colores.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">
              {algunFiltro ? 'Sin stock para esa combinación de filtros.' : 'Sin datos de stock.'}
            </div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-380px)]">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b sticky top-0 z-20 shadow-[0_2px_4px_rgba(0,0,0,0.1)]">
                  <tr>
                    <th className="text-left py-2 px-3 sticky left-0 bg-muted border-r z-30">Color</th>
                    {data.tallas.map(t => {
                      const total = data.totales_talla[t] || 0;
                      const lowCoverage = total < 5;
                      return (
                        <th key={t} className={`text-right py-2 px-2 w-14 bg-muted ${lowCoverage ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                          {t}
                          {lowCoverage && <AlertTriangle className="inline h-3 w-3 ml-0.5" />}
                        </th>
                      );
                    })}
                    <th className="text-right py-2 px-3 font-bold border-l bg-muted">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  {data.colores.map((c, i) => (
                    <tr key={c.color} className={`border-b hover:bg-muted/30 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                      <td className="py-1.5 px-3 font-medium sticky left-0 bg-background z-10 border-r">
                        {c.color}
                      </td>
                      {data.tallas.map(t => {
                        const stock = c.tallas_stock?.[t] || 0;
                        const vendido = c.tallas_vendido?.[t] || 0;
                        const enProceso = c.tallas_en_proceso?.[t] || 0;
                        const dias = data.dias_ytd || 1;
                        const ventaDiaria = vendido / dias;
                        const stockProy = stock + enProceso;
                        const diasCobertura = ventaDiaria > 0 ? stockProy / ventaDiaria : null;

                        // Estilos según vista
                        let bgStyle = {};
                        let className = "text-right tabular-nums py-1.5 px-2";
                        let content = null;
                        let tooltipTxt = '';

                        if (vista === 'stock') {
                          const intensidad = maxCellStock > 0 ? stock / maxCellStock : 0;
                          if (stock > 0) bgStyle = { backgroundColor: `rgba(59, 130, 246, ${0.05 + intensidad * 0.4})` };
                          content = stock > 0 ? formatNum(stock) : <span className="text-muted-foreground/30">—</span>;
                          tooltipTxt = stock > 0 ? `${stock} und en stock` : 'Sin stock';
                        } else if (vista === 'comparativo') {
                          // Mostrar stock / vendido / en producción
                          if (stock === 0 && vendido === 0 && enProceso === 0) {
                            content = <span className="text-muted-foreground/30">—</span>;
                          } else {
                            content = (
                              <div className="leading-tight">
                                <div className="text-xs font-semibold">{stock > 0 ? formatNum(stock) : '0'}</div>
                                {enProceso > 0 && (
                                  <div className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">+{formatNum(enProceso)}</div>
                                )}
                                <div className="text-[10px] text-muted-foreground">{vendido > 0 ? `↘${formatNum(vendido)}` : '—'}</div>
                              </div>
                            );
                          }
                          if (vendido > 0 && stockProy === 0) bgStyle = { backgroundColor: 'rgba(239, 68, 68, 0.15)' };
                          else if (diasCobertura !== null && diasCobertura < 30) bgStyle = { backgroundColor: 'rgba(245, 158, 11, 0.15)' };
                          tooltipTxt = `Stock: ${stock}${enProceso > 0 ? ` · En producción: +${enProceso}` : ''} · Vendido YTD: ${vendido}` + (diasCobertura !== null ? ` · ${Math.round(diasCobertura)}d cobertura` : '');
                        } else { // reposicion
                          // Helper: pinta el indicador de "en producción" cuando aplica
                          const opBadge = enProceso > 0 ? (
                            <div className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">+{enProceso} OP</div>
                          ) : null;
                          if (stock === 0 && vendido === 0 && enProceso === 0) {
                            content = <span className="text-muted-foreground/20">—</span>;
                          } else if (vendido > 0 && stockProy === 0) {
                            bgStyle = { backgroundColor: 'rgba(239, 68, 68, 0.25)' };
                            content = <div className="font-bold text-red-700 dark:text-red-300">⚠ {formatNum(vendido)}</div>;
                            tooltipTxt = `🔴 CRÍTICA: vendió ${vendido}, stock 0, sin OP`;
                          } else if (diasCobertura !== null && diasCobertura < 30) {
                            bgStyle = { backgroundColor: 'rgba(245, 158, 11, 0.25)' };
                            content = (
                              <div className="leading-tight">
                                <div className="font-bold">{stock}</div>
                                {opBadge}
                                <div className="text-[10px] text-amber-700 dark:text-amber-400">{Math.round(diasCobertura)}d</div>
                              </div>
                            );
                            tooltipTxt = `🟠 URGENTE: ${Math.round(diasCobertura)}d cobertura proyectada`;
                          } else if (diasCobertura !== null && diasCobertura < 60) {
                            bgStyle = { backgroundColor: 'rgba(234, 179, 8, 0.18)' };
                            content = (
                              <div className="leading-tight">
                                <div>{stock}</div>
                                {opBadge}
                                <div className="text-[10px] text-yellow-700 dark:text-yellow-500">{Math.round(diasCobertura)}d</div>
                              </div>
                            );
                            tooltipTxt = `🟡 Producir: ${Math.round(diasCobertura)}d cobertura`;
                          } else if (stock > 0 && vendido === 0 && enProceso === 0) {
                            bgStyle = { backgroundColor: 'rgba(113, 113, 122, 0.1)' };
                            content = <span className="text-muted-foreground">{formatNum(stock)}</span>;
                            tooltipTxt = 'Sobrestock — sin ventas YTD';
                          } else if (diasCobertura !== null && diasCobertura > 365) {
                            bgStyle = { backgroundColor: 'rgba(113, 113, 122, 0.1)' };
                            content = (
                              <div className="leading-tight">
                                <span className="text-muted-foreground">{formatNum(stock)}</span>
                                {opBadge}
                              </div>
                            );
                            tooltipTxt = `Sobrestock — ${Math.round(diasCobertura)}d cobertura`;
                          } else {
                            bgStyle = { backgroundColor: 'rgba(34, 197, 94, 0.08)' };
                            content = (
                              <div className="leading-tight">
                                <span>{formatNum(stock)}</span>
                                {opBadge}
                              </div>
                            );
                            tooltipTxt = `Saludable${diasCobertura !== null ? ` · ${Math.round(diasCobertura)}d cobertura` : ''}`;
                          }
                        }

                        return (
                          <td key={t} className={className} style={bgStyle} title={tooltipTxt}>
                            {content}
                          </td>
                        );
                      })}
                      <td className="text-right tabular-nums py-1.5 px-3 font-bold border-l bg-muted/10">
                        {vista === 'comparativo' ? (
                          <div className="leading-tight">
                            <div>{formatNum(c.stock_total)}</div>
                            <div className="text-[10px] text-muted-foreground">↘{formatNum(c.vendido_total || 0)}</div>
                          </div>
                        ) : formatNum(c.stock_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="font-semibold sticky bottom-0 z-20 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
                  <tr className="border-t-2 border-primary/40">
                    <td className="py-2 px-3 text-xs uppercase tracking-wide sticky left-0 bg-card border-r z-30">Total</td>
                    {data.tallas.map(t => {
                      const stockT = data.totales_stock_talla?.[t] || 0;
                      const vendidoT = data.totales_vendido_talla?.[t] || 0;
                      return (
                        <td key={t} className={`text-right tabular-nums py-2 px-2 bg-card ${stockT < 5 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                          {vista === 'comparativo' ? (
                            <div className="leading-tight">
                              <div className="text-xs">{formatNum(stockT)}</div>
                              <div className="text-[10px] text-muted-foreground">↘{formatNum(vendidoT)}</div>
                            </div>
                          ) : formatNum(stockT)}
                        </td>
                      );
                    })}
                    <td className="text-right tabular-nums py-2 px-3 border-l bg-card font-bold">
                      {vista === 'comparativo' ? (
                        <div className="leading-tight">
                          <div>{formatNum(data.stock_total)}</div>
                          <div className="text-[10px] text-muted-foreground">↘{formatNum(data.vendido_total || 0)}</div>
                        </div>
                      ) : formatNum(data.stock_total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <div className="px-4 py-2 text-[10px] text-muted-foreground border-t flex flex-wrap gap-3">
                <span>🔵 Intensidad de azul = volumen relativo de stock</span>
                <span className="text-amber-600 dark:text-amber-400"><AlertTriangle className="inline h-3 w-3 mr-0.5" /> Talla con &lt; 5 unidades en total — candidata a producir</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recomendaciones de producción (basado en ventas YTD vs stock) */}
      {data && recomendacionesProducir.length > 0 && (
        <Card className="border-primary/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" /> Recomendaciones de producción
              <span className="text-xs font-normal text-muted-foreground ml-2">
                {recomendacionesProducir.length} celdas a reponer · ~{formatNum(totalReponer)} unidades sugeridas (cobertura 90d)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10">
                  <tr>
                    <th className="text-left py-2 px-3">Prioridad</th>
                    <th className="text-left py-2 px-3">Color</th>
                    <th className="text-left py-2 px-3 w-16">Talla</th>
                    <th className="text-right py-2 px-3 w-20">Stock</th>
                    <th className="text-right py-2 px-3 w-20 text-blue-600 dark:text-blue-400">En OP</th>
                    <th className="text-right py-2 px-3 w-20">Vendido</th>
                    <th className="text-right py-2 px-3 w-24">Cobertura</th>
                    <th className="text-right py-2 px-3 w-24 font-bold">Reponer</th>
                    <th className="text-left py-2 px-3">Razón</th>
                  </tr>
                </thead>
                <tbody>
                  {recomendacionesProducir.slice(0, 30).map((r, i) => {
                    const colorBadge = {
                      critica: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-300',
                      urgente: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-300',
                      producir: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300 border-yellow-300',
                    }[r.prioridad];
                    const label = { critica: '🔴 Crítica', urgente: '🟠 Urgente', producir: '🟡 Producir' }[r.prioridad];
                    return (
                      <tr key={`${r.color}-${r.talla}-${i}`} className="border-b hover:bg-muted/30">
                        <td className="py-1.5 px-3">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${colorBadge}`}>{label}</span>
                        </td>
                        <td className="py-1.5 px-3 font-medium">{r.color}</td>
                        <td className="py-1.5 px-3 tabular-nums">{r.talla}</td>
                        <td className="text-right tabular-nums py-1.5 px-3">{formatNum(r.stock)}</td>
                        <td className={`text-right tabular-nums py-1.5 px-3 ${r.en_proceso > 0 ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-muted-foreground/40'}`}>
                          {r.en_proceso > 0 ? `+${formatNum(r.en_proceso)}` : '—'}
                        </td>
                        <td className="text-right tabular-nums py-1.5 px-3">{formatNum(r.vendido)}</td>
                        <td className={`text-right tabular-nums py-1.5 px-3 ${r.dias_cobertura !== null && r.dias_cobertura < 30 ? 'text-amber-600 font-semibold' : 'text-muted-foreground'}`}>
                          {r.dias_cobertura === null ? '—' : `${Math.round(r.dias_cobertura)}d`}
                        </td>
                        <td className="text-right tabular-nums py-1.5 px-3 font-bold text-primary">{formatNum(r.reponer)}</td>
                        <td className="py-1.5 px-3 text-xs text-muted-foreground">{r.razon}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {recomendacionesProducir.length > 30 && (
                <div className="text-center text-[11px] text-muted-foreground py-2 border-t">
                  Mostrando 30 de {recomendacionesProducir.length} recomendaciones (priorizadas por urgencia y volumen).
                </div>
              )}
            </div>
            <div className="px-4 py-2 text-[10px] text-muted-foreground border-t bg-muted/20">
              💡 La columna <b>Reponer</b> sugiere cubrir 90 días de venta al ritmo actual: <code>(venta_diaria × 90) − stock</code>.
              Tallas vendidas con stock 0 se priorizan como críticas.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hint si hay tallas faltantes */}
      {data && tallasFaltantes.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-amber-700 dark:text-amber-300 mb-1">
                Tallas con poca cobertura: {tallasFaltantes.join(', ')}
              </div>
              <div className="text-amber-700/80 dark:text-amber-300/80 text-xs">
                Estas tallas tienen menos de 5 unidades en total dentro del filtro actual.
                Considera incluirlas en la siguiente orden de producción.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
