import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, formatNum } from '../lib/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { MultiSelect } from '../components/ui/multi-select';
import { SearchableSelect } from '../components/ui/searchable-select';
import { Loader2, FileText, Search, X, Warehouse, Filter, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import ExportarStock from '../components/ExportarStock';

export default function ReporteStockDetallado() {
  // Filtros principales
  const [marca, setMarca] = useState('');
  const [tipo, setTipo] = useState('');
  const [entalle, setEntalle] = useState('');
  const [tela, setTela] = useState('');
  const [esLq, setEsLq] = useState('');
  const [esNegro, setEsNegro] = useState('');
  const [porArreglar, setPorArreglar] = useState(false);
  const [incluirPendientes, setIncluirPendientes] = useState(true);
  const [clasifEstricta, setClasifEstricta] = useState(true); // true=Producción, false=Auto-match Odoo
  const [tiendasSel, setTiendasSel] = useState([]);
  const [modeloQ, setModeloQ] = useState('');
  const [tallaSel, setTallaSel] = useState('');
  const [colorQ, setColorQ] = useState('');

  // Drill-down (cross-filter) — click en filas/columnas/celdas
  const [drill, setDrill] = useState({ modelo: '', color: '', talla: '', tienda: '' });
  const setDrillField = (field, value) => {
    // Toggle: si ya está seleccionado, lo limpia
    setDrill(d => ({ ...d, [field]: d[field] === value ? '' : value }));
  };
  const clearDrill = () => setDrill({ modelo: '', color: '', talla: '', tienda: '' });
  const drillCount = Object.values(drill).filter(Boolean).length;

  const [optMarcas, setOptMarcas] = useState([]);
  const [optTipos, setOptTipos] = useState([]);
  const [optEntalles, setOptEntalles] = useState([]);
  const [optTelas, setOptTelas] = useState([]);
  const [combos, setCombos] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/catalogos/marcas').then(r => setOptMarcas(r.data || [])).catch(() => {});
    api.get('/catalogos/tipos').then(r => setOptTipos(r.data || [])).catch(() => {});
    api.get('/catalogos/entalles').then(r => setOptEntalles(r.data || [])).catch(() => {});
    api.get('/catalogos/telas').then(r => setOptTelas(r.data || [])).catch(() => {});
    api.get('/produccion/combinaciones').then(r => setCombos(r.data || [])).catch(() => {});
  }, []);

  const filtrarPara = (dim) => {
    const sel = { marca_id: marca, tipo_id: tipo, entalle_id: entalle, tela_id: tela };
    const validas = combos.filter(c => Object.entries(sel).every(([k, v]) => k === dim || !v || c[k] === v));
    return new Set(validas.map(c => c[dim]).filter(Boolean));
  };
  const marcasIds = useMemo(() => filtrarPara('marca_id'), [combos, tipo, entalle, tela]);
  const tiposIds = useMemo(() => filtrarPara('tipo_id'), [combos, marca, entalle, tela]);
  const entallesIds = useMemo(() => filtrarPara('entalle_id'), [combos, marca, tipo, tela]);
  const telasIds = useMemo(() => filtrarPara('tela_id'), [combos, marca, tipo, entalle]);
  const optMarcasF = combos.length === 0 ? optMarcas : optMarcas.filter(m => marcasIds.has(String(m.id)));
  const optTiposF = combos.length === 0 ? optTipos : optTipos.filter(t => tiposIds.has(String(t.id)));
  const optEntallesF = combos.length === 0 ? optEntalles : optEntalles.filter(e => entallesIds.has(String(e.id)));
  const optTelasF = combos.length === 0 ? optTelas : optTelas.filter(t => telasIds.has(String(t.id)));

  useEffect(() => { if (marca && combos.length && !marcasIds.has(marca)) setMarca(''); }, [marca, marcasIds, combos.length]);
  useEffect(() => { if (tipo && combos.length && !tiposIds.has(tipo)) setTipo(''); }, [tipo, tiposIds, combos.length]);
  useEffect(() => { if (entalle && combos.length && !entallesIds.has(entalle)) setEntalle(''); }, [entalle, entallesIds, combos.length]);
  useEffect(() => { if (tela && combos.length && !telasIds.has(tela)) setTela(''); }, [tela, telasIds, combos.length]);

  // Modelo se debouncea (es input de texto), talla y color son selección directa
  const [modeloDeb, setModeloDeb] = useState('');
  useEffect(() => { const t = setTimeout(() => setModeloDeb(modeloQ.trim()), 350); return () => clearTimeout(t); }, [modeloQ]);

  // Si cambian los filtros padres, limpiar drill-down
  // eslint-disable-next-line
  useEffect(() => {
    if (drillCount > 0) clearDrill();
  }, [marca, tipo, entalle, tela, esLq, esNegro, porArreglar]);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (marca) params.marca_id = marca;
      if (tipo) params.tipo_id = tipo;
      if (entalle) params.entalle_id = entalle;
      if (tela) params.tela_id = tela;
      if (esLq) params.es_lq = esLq;
      if (esNegro) params.es_negro = esNegro;
      if (porArreglar) params.por_arreglar = true;
      params.incluir_pendientes = incluirPendientes;
      params.clasif_estricta = clasifEstricta;

      // Drill-down tiene prioridad sobre filtros del input
      // tienda: drill > tiendasSel
      if (drill.tienda) params.tiendas = drill.tienda;
      else if (tiendasSel.length) params.tiendas = tiendasSel.join(',');
      // modelo: drill exacto > búsqueda libre
      if (drill.modelo) params.modelo_exacto = drill.modelo;
      else if (modeloDeb) params.modelo = modeloDeb;
      // talla: drill > input
      if (drill.talla) params.talla = drill.talla;
      else if (tallaSel) params.talla = tallaSel;
      // color: drill > input
      if (drill.color) params.color = drill.color;
      else if (colorQ) params.color = colorQ;

      const res = await api.get('/produccion/reporte-detallado', { params });
      setData(res.data);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [marca, tipo, entalle, tela, esLq, esNegro, porArreglar, incluirPendientes, clasifEstricta, tiendasSel, drill, modeloDeb, tallaSel, colorQ]);

  useEffect(() => { cargar(); }, [cargar]);

  const limpiar = () => {
    setMarca(''); setTipo(''); setEntalle(''); setTela('');
    setEsLq(''); setEsNegro(''); setPorArreglar(false);
    setIncluirPendientes(true);
    setClasifEstricta(true);
    setTiendasSel([]); setModeloQ(''); setTallaSel(''); setColorQ('');
    clearDrill();
  };
  const algunFiltro = marca || tipo || entalle || tela || esLq || esNegro || porArreglar
    || tiendasSel.length || modeloDeb || tallaSel || colorQ || drillCount;
  const optTiendasMS = (data?.tiendas_disponibles || []).map(t => ({ value: t.tienda, label: `${t.tienda} (${formatNum(t.stock)})` }));

  // Opciones cascadeables de talla/color desde el response actual
  const optTallas = useMemo(() => {
    if (!data?.tallas) return [];
    return data.tallas.map(t => ({
      value: t,
      label: `${t} (${formatNum(data.pivot_total?.totales_talla?.[t] || 0)})`,
    }));
  }, [data]);
  const optColores = useMemo(() => {
    if (!data?.pivot_total?.colores) return [];
    return data.pivot_total.colores.map(c => ({
      value: c.color,
      label: `${c.color} (${formatNum(c.total)})`,
    }));
  }, [data]);

  // Orden preferido para el grid: GR238, GM209, GM218 (arriba) / GM207, BOOSH, AP (abajo)
  const ORDEN_TIENDAS = ['GR238', 'GM209', 'GM218', 'GM207', 'BOOSH', 'AP'];

  const { tallerPivot, tiendasComerciales } = useMemo(() => {
    if (!data) return { tallerPivot: null, tiendasComerciales: [] };
    const taller = data.pivot_tiendas.find(t => t.tienda === 'TALLER');
    const otras = data.pivot_tiendas.filter(t => t.tienda !== 'TALLER');
    // Ordenar por preferencia, las no listadas van al final por stock desc
    otras.sort((a, b) => {
      const ia = ORDEN_TIENDAS.indexOf(a.tienda);
      const ib = ORDEN_TIENDAS.indexOf(b.tienda);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return b.total - a.total;
    });
    return { tallerPivot: taller, tiendasComerciales: otras };
  }, [data]);

  return (
    <div className="h-screen flex flex-col p-3 gap-2 overflow-hidden">
      {/* Barra de filtros + KPIs */}
      <div className="flex items-center gap-2 flex-wrap shrink-0 border-b pb-2">
        <FileText className="h-5 w-5 text-primary shrink-0" />
        <h1 className="text-base font-bold mr-2">Reporte Stock</h1>

        <CompactSelect label="Marca" value={marca} setValue={setMarca} options={optMarcasF} />
        <CompactSelect label="Tipo" value={tipo} setValue={setTipo} options={optTiposF} />
        <CompactSelect label="Entalle" value={entalle} setValue={setEntalle} options={optEntallesF} />
        <CompactSelect label="Tela" value={tela} setValue={setTela} options={optTelasF} />

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input value={modeloQ} onChange={e => setModeloQ(e.target.value)}
            placeholder="Modelo" className="h-7 pl-6 w-32 text-xs" />
        </div>
        <SearchableSelect
          options={optTallas}
          value={tallaSel}
          onChange={setTallaSel}
          placeholder="Talla"
          emptyText="Sin tallas"
          className="w-24"
        />
        <SearchableSelect
          options={optColores}
          value={colorQ}
          onChange={setColorQ}
          placeholder="Color"
          emptyText="Sin colores"
          className="w-32"
        />

        <div className="w-40" title="Por defecto se excluyen ZAP, REMATE, Fallados Qepo, AP, GR55. Selecciona explícitamente para incluirlas.">
          <MultiSelect options={optTiendasMS} value={tiendasSel} onChange={setTiendasSel}
            placeholder="Tiendas (def. excl.)" className="h-7" />
        </div>

        <CompactTriToggle label="LQ" value={esLq} setValue={setEsLq} />
        <CompactTriToggle label="Negro" value={esNegro} setValue={setEsNegro} />
        <div className="flex items-center gap-1 px-2 py-1 rounded border">
          <Switch id="ap" checked={porArreglar} onCheckedChange={setPorArreglar} className="scale-75" />
          <Label htmlFor="ap" className="text-[10px] cursor-pointer">AP</Label>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded border" title="Incluye transferencias pendientes (assigned/waiting/confirmed). Si está apagado, solo stock físico real.">
          <Switch id="pend" checked={incluirPendientes} onCheckedChange={setIncluirPendientes} className="scale-75" />
          <Label htmlFor="pend" className="text-[10px] cursor-pointer">Pendientes</Label>
        </div>
        {/* Toggle Clasificación: Producción (estricta) vs Auto-match Odoo */}
        <div className="flex gap-0.5 p-0.5 rounded border bg-muted/30" title="Producción: solo productos clasificados en el módulo Producción. Odoo: incluye auto-match al texto crudo de Odoo.">
          <button onClick={() => setClasifEstricta(true)}
            className={`px-2 py-0.5 text-[10px] rounded ${clasifEstricta ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
            Producción
          </button>
          <button onClick={() => setClasifEstricta(false)}
            className={`px-2 py-0.5 text-[10px] rounded ${!clasifEstricta ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
            Odoo
          </button>
        </div>

        {algunFiltro && (
          <Button variant="ghost" size="sm" onClick={limpiar} className="h-7 px-2 text-xs">
            <X className="h-3 w-3 mr-0.5" />Limpiar
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={cargar}
          disabled={loading}
          className="h-7 px-2 text-xs gap-1"
          title="Re-consulta datos manteniendo filtros activos"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </Button>

        {/* Export CSV — preselecciona las tiendas filtradas en el reporte */}
        <ExportarStock defaultTiendas={tiendasSel} />


        {data && (
          <div className="ml-auto flex items-center gap-3 text-[11px]">
            <KPIInline label="Stock" value={formatNum(data.kpis.stock_total)} />
            <KPIInline label="Modelos" value={data.kpis.modelos} />
            <KPIInline label="Colores" value={data.kpis.colores} />
            <KPIInline label="Tiendas" value={data.kpis.tiendas_con_stock} />
          </div>
        )}
      </div>

      {/* Banner cross-filter activo */}
      {drillCount > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/30 rounded-md text-xs flex-wrap">
          <Filter className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-muted-foreground">Cross-filter activo:</span>
          {drill.modelo && <DrillTag label="Modelo" value={drill.modelo} onClear={() => setDrill(d => ({ ...d, modelo: '' }))} />}
          {drill.color && <DrillTag label="Color" value={drill.color} onClear={() => setDrill(d => ({ ...d, color: '' }))} />}
          {drill.talla && <DrillTag label="Talla" value={drill.talla} onClear={() => setDrill(d => ({ ...d, talla: '' }))} />}
          {drill.tienda && <DrillTag label="Tienda" value={drill.tienda} onClear={() => setDrill(d => ({ ...d, tienda: '' }))} />}
          <button onClick={clearDrill} className="ml-auto text-primary hover:underline">Limpiar todo</button>
        </div>
      )}

      {/* Grid principal */}
      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : data ? (
        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
          <div className="col-span-3 min-h-0">
            <PanelModelos data={data} drill={drill} setDrillField={setDrillField} />
          </div>

          <div className="col-span-6 min-h-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="text-[10px] font-semibold mb-1 px-1 text-muted-foreground uppercase tracking-wide">
                Tiendas · {tiendasComerciales.length}
              </div>
              <div className="grid grid-cols-3 gap-2 overflow-auto min-h-0 pr-1">
                {tiendasComerciales.map(tp => (
                  <PivotTienda key={tp.tienda} tp={tp} tallas={data.tallas}
                    drill={drill} setDrillField={setDrillField} />
                ))}
                {tiendasComerciales.length === 0 && (
                  <div className="col-span-3 text-center text-xs text-muted-foreground py-4">Sin tiendas con stock.</div>
                )}
              </div>
            </div>
            <div className="h-48 shrink-0">
              <PanelTotal data={data} drill={drill} setDrillField={setDrillField} />
            </div>
          </div>

          <div className="col-span-3 min-h-0">
            <PanelTaller tallerPivot={tallerPivot} tallas={data.tallas}
              drill={drill} setDrillField={setDrillField} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============ Helpers ============

function DrillTag({ label, value, onClear }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary text-primary-foreground rounded-full text-[10px] font-semibold">
      {label}: {value}
      <button onClick={onClear} className="hover:bg-primary-foreground/20 rounded-full p-0.5">
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

function CompactSelect({ label, value, setValue, options }) {
  return (
    <div className="flex items-center gap-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Select value={value || 'all'} onValueChange={v => setValue(v === 'all' ? '' : v)}>
        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="Todas" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todas ({options.length})</SelectItem>
          {options.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.nombre}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function CompactTriToggle({ label, value, setValue }) {
  return (
    <div className="flex items-center gap-1 px-1 rounded border h-7">
      <Label className="text-[10px] text-muted-foreground px-1">{label}</Label>
      <Select value={value || 'all'} onValueChange={v => setValue(v === 'all' ? '' : v)}>
        <SelectTrigger className="h-6 w-16 text-[11px] border-0 bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos</SelectItem>
          <SelectItem value="si">Sí</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function KPIInline({ label, value }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );
}

// ============ Estilos comunes para clickeable ============
const cellSelectedClass = 'bg-primary/30 ring-1 ring-primary';
const rowSelectedClass = 'bg-primary/20 font-semibold';
const headerSelectedClass = 'bg-primary text-primary-foreground';

// ============ Paneles ============

function PanelModelos({ data, drill, setDrillField }) {
  const items = data.pivot_modelos?.items || [];
  return (
    <div className="h-full flex flex-col border rounded-lg overflow-hidden">
      <div className="px-2 py-1.5 bg-muted/50 border-b shrink-0">
        <div className="text-xs font-semibold">Stock por Modelo</div>
        <div className="text-[10px] text-muted-foreground">
          {items.length} modelos · {formatNum(data.pivot_modelos.total)} und · click fila/columna/celda
        </div>
      </div>
      <div className="overflow-auto flex-1 min-h-0">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">Sin datos</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground border-b bg-muted/70 sticky top-0 z-10">
              <tr>
                <th className="text-left py-1.5 px-2 sticky left-0 bg-muted/70 z-20 border-r">Modelo</th>
                {data.tallas.map(t => (
                  <th key={t}
                      onClick={() => setDrillField('talla', t)}
                      className={`text-right py-1.5 px-1.5 w-9 cursor-pointer hover:bg-primary/30 ${
                        drill.talla === t ? headerSelectedClass : 'bg-muted/70'
                      }`}>
                    {t}
                  </th>
                ))}
                <th className="text-right py-1.5 px-2 border-l bg-muted/70 font-bold">TOT</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, i) => {
                const isSelRow = drill.modelo === m.modelo;
                return (
                  <tr key={m.modelo} className={`border-b ${
                    isSelRow ? rowSelectedClass :
                    i % 2 === 0 ? 'bg-muted/10 hover:bg-accent/40' : 'hover:bg-accent/40'
                  }`}>
                    <td onClick={() => setDrillField('modelo', m.modelo)}
                        className={`py-1 px-2 font-medium sticky left-0 border-r z-10 truncate max-w-[120px] cursor-pointer hover:bg-primary/20 ${
                          isSelRow ? 'bg-primary/30' : 'bg-background'
                        }`} title={m.modelo}>
                      {isSelRow && '▶ '}{m.modelo}
                    </td>
                    {data.tallas.map(t => {
                      const val = m.tallas_stock[t] || 0;
                      const isSelCell = isSelRow && drill.talla === t;
                      const isSelTalla = drill.talla === t;
                      return (
                        <td key={t}
                            onClick={() => {
                              // Click en celda: si ya tiene este modelo+talla seleccionados, limpia
                              if (drill.modelo === m.modelo && drill.talla === t) {
                                setDrillField('modelo', m.modelo); // toggle off modelo
                                setDrillField('talla', t);          // toggle off talla
                              } else {
                                if (drill.modelo !== m.modelo) setDrillField('modelo', m.modelo);
                                if (drill.talla !== t) setDrillField('talla', t);
                              }
                            }}
                            className={`text-right tabular-nums py-1 px-1.5 cursor-pointer hover:bg-primary/20 ${
                              isSelCell ? cellSelectedClass : isSelTalla ? 'bg-primary/10' : ''
                            }`}>
                          {val ? formatNum(val) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                      );
                    })}
                    <td className={`text-right tabular-nums py-1 px-2 font-bold border-l ${isSelRow ? 'bg-primary/30' : 'bg-muted/10'}`}>
                      {formatNum(m.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="font-semibold sticky bottom-0 bg-card z-20 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
              <tr className="border-t-2 border-primary/40">
                <td className="py-1.5 px-2 text-[10px] uppercase sticky left-0 bg-card z-30 border-r">Total</td>
                {data.tallas.map(t => (
                  <td key={t} className={`text-right tabular-nums py-1.5 px-1.5 ${drill.talla === t ? 'bg-primary/20' : 'bg-card'}`}>
                    {formatNum(data.pivot_modelos.totales_talla[t] || 0)}
                  </td>
                ))}
                <td className="text-right tabular-nums py-1.5 px-2 border-l bg-card font-bold">{formatNum(data.pivot_modelos.total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

function PanelTotal({ data, drill, setDrillField }) {
  const colores = data.pivot_total?.colores || [];
  return (
    <div className="h-full flex flex-col border rounded-lg overflow-hidden">
      <div className="px-2 py-1.5 bg-muted/50 border-b shrink-0">
        <div className="text-xs font-semibold">Total global · color × talla</div>
        <div className="text-[10px] text-muted-foreground">
          {colores.length} colores · {formatNum(data.pivot_total.total)} und
        </div>
      </div>
      <div className="overflow-auto flex-1 min-h-0">
        {colores.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">Sin datos</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground border-b bg-muted/70 sticky top-0 z-10">
              <tr>
                <th className="text-left py-1 px-2 sticky left-0 bg-muted/70 z-20 border-r">Color</th>
                {data.tallas.map(t => (
                  <th key={t}
                      onClick={() => setDrillField('talla', t)}
                      className={`text-right py-1 px-1.5 w-9 cursor-pointer hover:bg-primary/30 ${
                        drill.talla === t ? headerSelectedClass : 'bg-muted/70'
                      }`}>
                    {t}
                  </th>
                ))}
                <th className="text-right py-1 px-2 border-l bg-muted/70 font-bold">TOT</th>
              </tr>
            </thead>
            <tbody>
              {colores.map((c, i) => {
                const isSelRow = drill.color === c.color;
                return (
                  <tr key={c.color} className={`border-b ${
                    isSelRow ? rowSelectedClass :
                    i % 2 === 0 ? 'bg-muted/10 hover:bg-accent/40' : 'hover:bg-accent/40'
                  }`}>
                    <td onClick={() => setDrillField('color', c.color)}
                        className={`py-0.5 px-2 font-medium sticky left-0 border-r z-10 truncate max-w-[120px] cursor-pointer hover:bg-primary/20 ${
                          isSelRow ? 'bg-primary/30' : 'bg-background'
                        }`} title={c.color}>
                      {c.color}
                    </td>
                    {data.tallas.map(t => {
                      const val = c.tallas_stock[t] || 0;
                      const isSelCell = isSelRow && drill.talla === t;
                      const isSelTalla = drill.talla === t;
                      return (
                        <td key={t}
                            onClick={() => {
                              if (drill.color === c.color && drill.talla === t) {
                                setDrillField('color', c.color);
                                setDrillField('talla', t);
                              } else {
                                if (drill.color !== c.color) setDrillField('color', c.color);
                                if (drill.talla !== t) setDrillField('talla', t);
                              }
                            }}
                            className={`text-right tabular-nums py-0.5 px-1.5 cursor-pointer hover:bg-primary/20 ${
                              isSelCell ? cellSelectedClass : isSelTalla ? 'bg-primary/10' : ''
                            }`}>
                          {val ? formatNum(val) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                      );
                    })}
                    <td className={`text-right tabular-nums py-0.5 px-2 font-bold border-l ${isSelRow ? 'bg-primary/30' : 'bg-muted/10'}`}>
                      {formatNum(c.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="font-semibold sticky bottom-0 bg-card z-20 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
              <tr className="border-t-2 border-primary/40">
                <td className="py-1 px-2 text-[10px] uppercase sticky left-0 bg-card z-30 border-r">Total</td>
                {data.tallas.map(t => (
                  <td key={t} className={`text-right tabular-nums py-1 px-1.5 ${drill.talla === t ? 'bg-primary/20' : 'bg-card'}`}>
                    {formatNum(data.pivot_total.totales_talla[t] || 0)}
                  </td>
                ))}
                <td className="text-right tabular-nums py-1 px-2 border-l bg-card font-bold">{formatNum(data.pivot_total.total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

function PanelTaller({ tallerPivot, tallas, drill, setDrillField }) {
  const colores = tallerPivot?.colores || [];
  const isSelTienda = drill.tienda === 'TALLER';
  return (
    <div className={`h-full flex flex-col border-2 ${
      isSelTienda ? 'border-primary' : 'border-amber-400 dark:border-amber-700'
    } rounded-lg overflow-hidden bg-amber-50/30 dark:bg-amber-950/10`}>
      <div onClick={() => setDrillField('tienda', 'TALLER')}
           className={`px-3 py-2 border-b shrink-0 flex items-center justify-between cursor-pointer hover:opacity-80 ${
             isSelTienda
               ? 'bg-primary text-primary-foreground'
               : 'bg-gradient-to-r from-amber-100 to-amber-50 dark:from-amber-950/50 dark:to-amber-900/30'
           }`}>
        <div className="flex items-center gap-2">
          <Warehouse className={`h-5 w-5 ${isSelTienda ? '' : 'text-amber-700 dark:text-amber-400'}`} />
          <div>
            <div className="text-sm font-bold">TALLER · Almacén {isSelTienda && '✓'}</div>
            <div className={`text-[10px] ${isSelTienda ? 'opacity-80' : 'text-amber-700 dark:text-amber-400'}`}>
              {colores.length} colores · {formatNum(tallerPivot?.total || 0)} und · click para filtrar
            </div>
          </div>
        </div>
      </div>
      <div className="overflow-auto flex-1 min-h-0">
        {!tallerPivot || colores.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">Sin stock en TALLER para los filtros activos.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b bg-amber-100/70 dark:bg-amber-950/40 sticky top-0 z-10">
              <tr>
                <th className="text-left py-1.5 px-2 sticky left-0 bg-amber-100/70 dark:bg-amber-950/40 z-20 border-r">Color</th>
                {tallas.map(t => (
                  <th key={t}
                      onClick={() => setDrillField('talla', t)}
                      className={`text-right py-1.5 px-2 w-12 cursor-pointer hover:bg-primary/30 ${
                        drill.talla === t ? headerSelectedClass : 'bg-amber-100/70 dark:bg-amber-950/40'
                      }`}>
                    {t}
                  </th>
                ))}
                <th className="text-right py-1.5 px-3 border-l bg-amber-100/70 dark:bg-amber-950/40 font-bold">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {colores.map((c, i) => {
                const isSelRow = drill.color === c.color;
                return (
                  <tr key={c.color} className={`border-b ${
                    isSelRow ? rowSelectedClass :
                    i % 2 === 0 ? 'bg-amber-50/30 dark:bg-amber-950/10 hover:bg-amber-100/40 dark:hover:bg-amber-950/30' : 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
                  }`}>
                    <td onClick={() => setDrillField('color', c.color)}
                        className={`py-1 px-2 font-medium sticky left-0 border-r z-10 truncate max-w-[160px] cursor-pointer hover:bg-primary/20 ${
                          isSelRow ? 'bg-primary/30' : 'bg-background'
                        }`} title={c.color}>
                      {c.color}
                    </td>
                    {tallas.map(t => {
                      const val = c.tallas_stock[t] || 0;
                      const isSelCell = isSelRow && drill.talla === t;
                      const isSelTalla = drill.talla === t;
                      return (
                        <td key={t}
                            onClick={() => {
                              if (drill.color === c.color && drill.talla === t) {
                                setDrillField('color', c.color);
                                setDrillField('talla', t);
                              } else {
                                if (drill.color !== c.color) setDrillField('color', c.color);
                                if (drill.talla !== t) setDrillField('talla', t);
                              }
                            }}
                            className={`text-right tabular-nums py-1 px-2 cursor-pointer hover:bg-primary/20 ${
                              isSelCell ? cellSelectedClass : isSelTalla ? 'bg-primary/10' : ''
                            }`}>
                          {val ? formatNum(val) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                      );
                    })}
                    <td className={`text-right tabular-nums py-1 px-3 font-bold border-l ${isSelRow ? 'bg-primary/30' : 'bg-amber-100/30 dark:bg-amber-950/20'}`}>
                      {formatNum(c.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="font-semibold sticky bottom-0 bg-card z-20 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
              <tr className="border-t-2 border-amber-500">
                <td className="py-2 px-2 text-xs uppercase sticky left-0 bg-card z-30 border-r">Total</td>
                {tallas.map(t => (
                  <td key={t} className={`text-right tabular-nums py-2 px-2 ${drill.talla === t ? 'bg-primary/20' : 'bg-card'}`}>
                    {formatNum(tallerPivot?.totales_talla?.[t] || 0)}
                  </td>
                ))}
                <td className="text-right tabular-nums py-2 px-3 border-l bg-card font-bold text-amber-700 dark:text-amber-400">
                  {formatNum(tallerPivot?.total || 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

function PivotTienda({ tp, tallas, drill, setDrillField }) {
  const isSelTienda = drill.tienda === tp.tienda;
  const esAP = tp.tienda === 'AP'; // Tienda de arreglos — color distinto
  return (
    <div className={`border rounded-lg overflow-hidden flex flex-col ${
      isSelTienda ? 'ring-2 ring-primary' :
      esAP ? 'border-amber-400 dark:border-amber-700/60' : ''
    }`}>
      <div onClick={() => setDrillField('tienda', tp.tienda)}
           className={`px-2 py-1 border-b flex items-center justify-between shrink-0 cursor-pointer hover:opacity-80 ${
             isSelTienda
               ? 'bg-primary text-primary-foreground'
               : esAP
                 ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
                 : 'bg-primary/10'
           }`}>
        <span className="font-semibold text-xs flex items-center gap-1">
          {tp.tienda} {isSelTienda && '✓'}
          {esAP && <span className="text-[9px] font-normal opacity-70">· arreglos</span>}
        </span>
        <span className={`text-[10px] tabular-nums ${isSelTienda ? '' : esAP ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
          {formatNum(tp.total)}
        </span>
      </div>
      <div className="overflow-auto max-h-[260px]">
        <table className="w-full text-[11px]">
          <thead className="text-[10px] text-muted-foreground border-b sticky top-0 bg-muted/70 z-10">
            <tr>
              <th className="text-left py-1 px-1.5 sticky left-0 bg-muted/70 z-20 border-r">Color</th>
              {tallas.map(t => (
                <th key={t}
                    onClick={() => setDrillField('talla', t)}
                    className={`text-right py-1 px-1 w-8 cursor-pointer hover:bg-primary/30 ${
                      drill.talla === t ? headerSelectedClass : 'bg-muted/70'
                    }`}>
                  {t}
                </th>
              ))}
              <th className="text-right py-1 px-1.5 border-l bg-muted/70 font-bold">T</th>
            </tr>
          </thead>
          <tbody>
            {tp.colores.map((c, i) => {
              const isSelRow = drill.color === c.color;
              return (
                <tr key={c.color} className={`border-b ${
                  isSelRow ? rowSelectedClass :
                  i % 2 === 0 ? 'bg-muted/10 hover:bg-accent/40' : 'hover:bg-accent/40'
                }`}>
                  <td onClick={() => setDrillField('color', c.color)}
                      className={`py-0.5 px-1.5 truncate max-w-[100px] sticky left-0 border-r z-10 cursor-pointer hover:bg-primary/20 ${
                        isSelRow ? 'bg-primary/30' : 'bg-background'
                      }`} title={c.color}>
                    {c.color}
                  </td>
                  {tallas.map(t => {
                    const val = c.tallas_stock[t] || 0;
                    const isSelCell = isSelRow && drill.talla === t;
                    const isSelTalla = drill.talla === t;
                    return (
                      <td key={t}
                          onClick={() => {
                            if (drill.color === c.color && drill.talla === t) {
                              setDrillField('color', c.color);
                              setDrillField('talla', t);
                            } else {
                              if (drill.color !== c.color) setDrillField('color', c.color);
                              if (drill.talla !== t) setDrillField('talla', t);
                            }
                          }}
                          className={`text-right tabular-nums py-0.5 px-1 cursor-pointer hover:bg-primary/20 ${
                            isSelCell ? cellSelectedClass : isSelTalla ? 'bg-primary/10' : ''
                          }`}>
                        {val ? formatNum(val) : <span className="text-muted-foreground/30">—</span>}
                      </td>
                    );
                  })}
                  <td className={`text-right tabular-nums py-0.5 px-1.5 font-semibold border-l ${isSelRow ? 'bg-primary/30' : ''}`}>
                    {formatNum(c.total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="font-semibold sticky bottom-0 z-20 shadow-[0_-2px_4px_rgba(0,0,0,0.1)]">
            <tr className="border-t-2 border-primary/40">
              <td className="py-1 px-1.5 text-[10px] uppercase sticky left-0 bg-card z-30 border-r">T</td>
              {tallas.map(t => (
                <td key={t} className={`text-right tabular-nums py-1 px-1 bg-card ${drill.talla === t ? 'bg-primary/20' : ''}`}>
                  {formatNum(tp.totales_talla[t] || 0)}
                </td>
              ))}
              <td className="text-right tabular-nums py-1 px-1.5 border-l bg-card font-bold">{formatNum(tp.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
