import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, formatSoles, formatNum } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip';
import { KPICard } from '../components/KPICard';
import { useFilters } from '../context/FiltersContext';
import {
  TrendingUp, AlertTriangle, Truck, PackageX, Activity, Package, Boxes, ArrowRight, ArrowLeftRight,
  Send, Tag, Info, Clock, Sliders, ShieldAlert, Loader2,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { toast } from 'sonner';

// =================================================================
// Reposición de Inventario por Tienda
// Ruta: /reposicion?tienda=...&periodo=30&nivel=grupo
// =================================================================

const PERIODOS_LOCAL = [
  { value: 7,  label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
];

const ESTADO_CONFIG = {
  crit:  { label: 'Crítico',     cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-300' },
  warn:  { label: 'Bajo',        cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-300' },
  ok:    { label: 'Saludable',   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-300' },
  over:  { label: 'Sobrestock',  cls: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-300' },
  dead:  { label: 'Muerto',      cls: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border-purple-300' },
};

const CONFIANZA_CONFIG = {
  alta:  { label: '🟢 Alta',  desc: '> 60 días de historia continua' },
  media: { label: '🟡 Media', desc: '14-60 días de historia' },
  baja:  { label: '🔴 Baja',  desc: '< 14 días — confianza limitada' },
};

const FILTROS_CHIP = [
  { value: '', label: 'Todos', estados: ['crit', 'warn', 'ok', 'over', 'dead'] },
  { value: 'crit', label: 'Críticos', estados: ['crit'] },
  { value: 'warn', label: 'Bajos', estados: ['warn'] },
  { value: 'dead', label: 'Muertos', estados: ['dead'] },
];

export default function Reposicion() {
  const { filters, setTiendas } = useFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Tienda seleccionada: del filtro global, o el query param, o vacío
  const tiendaParam = searchParams.get('tienda') || '';
  const tienda = filters.tiendas[0] || tiendaParam || '';

  const periodoParam = parseInt(searchParams.get('periodo') || '30', 10);
  const periodo = [7, 30, 90].includes(periodoParam) ? periodoParam : 30;

  const nivelParam = searchParams.get('nivel') || 'grupo';
  const nivel = ['grupo', 'modelo'].includes(nivelParam) ? nivelParam : 'grupo';

  const [filtroChip, setFiltroChip] = useState('');

  const [snapshot, setSnapshot] = useState(null);
  const [flujo, setFlujo] = useState(null);
  const [reposicion, setReposicion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(null);
  const [tiendasDisp, setTiendasDisp] = useState([]);

  const [confirmDialog, setConfirmDialog] = useState(null); // { tipo, item }

  // Cargar catálogo de tiendas
  useEffect(() => {
    api.get('/catalogos/tiendas')
      .then(r => setTiendasDisp((r.data || []).map(t => t.value || t.label)))
      .catch(() => {});
  }, []);

  // Default: si no hay tienda y ya cargaron las tiendas, tomar la primera
  useEffect(() => {
    if (!tienda && tiendasDisp.length > 0) {
      const def = tiendasDisp.find(t => t === 'GR238') || tiendasDisp[0];
      const np = new URLSearchParams(searchParams);
      np.set('tienda', def);
      setSearchParams(np, { replace: true });
    }
  }, [tienda, tiendasDisp]); // eslint-disable-line

  // Sincronizar tienda del URL con FiltersContext
  useEffect(() => {
    if (tienda && filters.tiendas[0] !== tienda) {
      setTiendas([tienda]);
    }
  }, [tienda]); // eslint-disable-line

  const setUrlParam = useCallback((k, v) => {
    const np = new URLSearchParams(searchParams);
    if (v === '' || v == null) np.delete(k); else np.set(k, String(v));
    setSearchParams(np, { replace: true });
  }, [searchParams, setSearchParams]);

  const setPeriodo = (v) => setUrlParam('periodo', v);
  const setNivel = (v) => setUrlParam('nivel', v);

  // Cargar 3 endpoints en paralelo
  const cargar = useCallback(async () => {
    if (!tienda) return;
    setLoading(true);
    try {
      const [snapR, flujoR, repoR] = await Promise.all([
        api.get('/inventario/snapshot',   { params: { tienda } }),
        api.get('/inventario/flujo',      { params: { tienda, dias: periodo } }),
        api.get('/inventario/reposicion', { params: { tienda, nivel, cobertura_objetivo: 30, incluir: 'crit,warn,ok,over,dead' } }),
      ]);
      setSnapshot(snapR.data);
      setFlujo(flujoR.data);
      setReposicion(repoR.data);
      setLastFetched(Date.now());
    } catch (e) {
      toast.error('Error al cargar reposición: ' + (e.response?.data?.detail || e.message));
    } finally {
      setLoading(false);
    }
  }, [tienda, periodo, nivel]);

  useEffect(() => { cargar(); }, [cargar]);

  // "Hace Xmin"
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const haceMin = lastFetched ? Math.floor((now - lastFetched) / 60000) : null;

  // Items filtrados por chip
  const itemsFiltrados = useMemo(() => {
    if (!reposicion?.items) return [];
    const chipDef = FILTROS_CHIP.find(f => f.value === filtroChip) || FILTROS_CHIP[0];
    return reposicion.items.filter(it => chipDef.estados.includes(it.estado));
  }, [reposicion, filtroChip]);

  // Si todavía no hay tienda seleccionada
  if (!tienda) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Selecciona una tienda en el filtro global o en la URL para ver la reposición.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading && !snapshot) return <ReposicionSkeleton />;

  return (
    <TooltipProvider delayDuration={150}>
      {/* Barra de carga indeterminada arriba: visible cuando refetch en curso. */}
      {loading && (
        <div className="sticky top-0 z-40 h-0.5 bg-primary/20 overflow-hidden">
          <div className="h-full w-1/3 bg-primary animate-[loading_1.2s_ease-in-out_infinite]"
               style={{ animation: 'reposicion-loading 1.2s ease-in-out infinite' }} />
          <style>{`
            @keyframes reposicion-loading {
              0%   { transform: translateX(-100%); }
              50%  { transform: translateX(200%); }
              100% { transform: translateX(400%); }
            }
          `}</style>
        </div>
      )}
      <div className={`p-6 space-y-5 transition-opacity ${loading ? 'opacity-60 pointer-events-none' : 'opacity-100'}`}>
        {/* TÍTULO + TOOLBAR LOCAL */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Truck className="h-6 w-6 text-primary" /> Reposición de inventario
              {loading && (
                <Loader2 className="h-4 w-4 animate-spin text-primary/60" />
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Tienda: <b className="text-foreground">{tienda}</b> · Período {periodo}D · {nivel === 'grupo' ? 'Por grupo' : 'Por modelo'}
              {loading ? (
                <span className="ml-2 text-[11px] text-primary font-medium">
                  <Loader2 className="h-3 w-3 inline mr-0.5 animate-spin" />Actualizando…
                </span>
              ) : haceMin != null && haceMin >= 1 && (
                <span className="ml-2 text-[10px] text-muted-foreground">
                  <Clock className="h-3 w-3 inline mr-0.5" />Actualizado hace {haceMin}min
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Período */}
            <div className="flex gap-0.5 p-0.5 rounded border bg-muted/30">
              {PERIODOS_LOCAL.map(p => (
                <button key={p.value} onClick={() => setPeriodo(p.value)}
                  className={`px-2.5 py-1 text-xs rounded ${periodo === p.value ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                  {p.label}
                </button>
              ))}
            </div>

            {/* Nivel */}
            <div className="flex gap-0.5 p-0.5 rounded border bg-muted/30">
              <button onClick={() => setNivel('grupo')}
                className={`px-2.5 py-1 text-xs rounded ${nivel === 'grupo' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                Por grupo
              </button>
              <button onClick={() => setNivel('modelo')}
                className={`px-2.5 py-1 text-xs rounded ${nivel === 'modelo' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
                Por modelo
              </button>
            </div>

            {/* Tienda quick-switcher (refleja filtros globales) */}
            {tiendasDisp.length > 0 && (
              <Select value={tienda} onValueChange={(v) => setTiendas([v])}>
                <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {tiendasDisp.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {/* Configurar topes (tienda × tipo) */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={() => navigate(`/config/topes-stock?tienda=${encodeURIComponent(tienda)}`)}
              title="Editar topes de stock por tipo para esta y todas las tiendas"
            >
              <Sliders className="h-3.5 w-3.5" /> Configurar topes
            </Button>
          </div>
        </div>

        {/* §01 KPIs */}
        <Section numero="01" titulo="Salud del inventario">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KPICard label="Stock total"      value={formatNum(snapshot?.stock_total || 0)}
              subtitle={snapshot?.valor_inventario ? formatSoles(snapshot.valor_inventario) : '—'}
              icon={Package} />
            <KPICard label="Críticos"         value={formatNum(snapshot?.items_criticos || 0)}
              subtitle="≤ 7 días cobertura" icon={AlertTriangle}
              accent={snapshot?.items_criticos > 0 ? 'red-600' : 'primary'} />
            <KPICard label="En tránsito"      value={formatNum(snapshot?.en_transito_unidades || 0)}
              subtitle="unidades llegando" icon={Truck} />
            <KPICard label="Sobrestock"       value={formatNum(snapshot?.items_sobrestock || 0)}
              subtitle="≥ 90 días cobertura" icon={Boxes} />
            <KPICard label="Cobertura prom"   value={snapshot?.cobertura_promedio_dias != null ? `${snapshot.cobertura_promedio_dias}d` : '—'}
              subtitle="ponderada por stock" icon={Activity} />
          </div>
          {/* Composición por tipo (barra apilada + chips) */}
          {snapshot?.por_tipo?.length > 0 && (
            <ComposicionPorTipo porTipo={snapshot.por_tipo} total={snapshot.stock_total || 0} />
          )}
        </Section>

        {/* §02 Flujo de inventario */}
        <Section numero="02" titulo={`Flujo de inventario · últimos ${periodo} días`}>
          <FlujoChart flujo={flujo} />
        </Section>

        {/* §03 Sugerencias de reposición */}
        <Section numero="03" titulo="Sugerencias de reposición">
          {/* Strip negro con mini-KPIs */}
          {reposicion?.resumen && (
            <div className="bg-zinc-900 dark:bg-zinc-950 text-white rounded-lg p-4 mb-3 grid grid-cols-2 md:grid-cols-4 gap-4">
              <MiniKPI label="SKUs en acción"      value={formatNum(reposicion.resumen.skus_en_accion)} />
              <MiniKPI label="Unidades sugeridas"  value={formatNum(reposicion.resumen.unidades_total_sugerido)} />
              <MiniKPI label="Valor estimado"      value={formatSoles(reposicion.resumen.valor_estimado_total)} />
              <MiniKPI
                label="Cómo obtenerlos"
                value={`${reposicion.resumen.transferibles_internos} transf · ${reposicion.resumen.a_pedir_almacen} almacén`}
                small
              />
            </div>
          )}

          {/* Filtros chip */}
          <div className="flex gap-1 mb-3 flex-wrap">
            {FILTROS_CHIP.map(c => (
              <button key={c.value} onClick={() => setFiltroChip(c.value)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  filtroChip === c.value
                    ? 'bg-primary text-primary-foreground border-primary font-semibold'
                    : 'bg-background hover:bg-accent border-border'
                }`}>
                {c.label}
                {c.value && reposicion?.items && (
                  <span className="ml-1 text-[10px] opacity-70">
                    ({reposicion.items.filter(it => c.estados.includes(it.estado)).length})
                  </span>
                )}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-muted-foreground self-center">
              Ordenado por margen perdido por día (mayor primero)
            </span>
          </div>

          <SugerenciasTable
            items={itemsFiltrados}
            nivel={nivel}
            tienda={tienda}
            onAction={(tipo, item) => setConfirmDialog({ tipo, item })}
          />
        </Section>

        {/* §04 Movimientos activos */}
        <Section numero="04" titulo="Movimientos activos">
          <MovimientosActivos flujo={flujo} reposicion={reposicion} />
        </Section>

        {/* §05 Sobrestock */}
        <Section numero="05" titulo="Sobrestock — candidatos a transferir">
          <SobrestockTable
            items={(reposicion?.items || []).filter(it => it.estado === 'over')}
            tiendaActual={tienda}
            onTransferir={(item) => setConfirmDialog({ tipo: 'transferir', item })}
          />
        </Section>

        {/* DIALOG CONFIRM */}
        <ConfirmDialog
          open={!!confirmDialog}
          onClose={() => setConfirmDialog(null)}
          dialog={confirmDialog}
          tienda={tienda}
        />
      </div>
    </TooltipProvider>
  );
}

// =====================================================
// Subcomponentes
// =====================================================

// Paleta para los tipos (cíclica si hay más de 8). Misma idea que Power BI.
const TIPO_COLORS = [
  'hsl(221 83% 53%)',  // azul (primary)
  'hsl(142 71% 45%)',  // verde
  'hsl(45 93% 47%)',   // amarillo
  'hsl(0 72% 51%)',    // rojo
  'hsl(262 83% 58%)',  // morado
  'hsl(199 89% 48%)',  // cyan
  'hsl(24 95% 53%)',   // naranja
  'hsl(330 81% 60%)',  // pink
];

function colorForTipo(idx) { return TIPO_COLORS[idx % TIPO_COLORS.length]; }

/**
 * Composición del inventario por tipo: barra apilada + chips clickeables.
 * Sirve para responder "¿qué tengo en esta tienda?" de un vistazo.
 * Tipos con <2% se agrupan en "Otros" para no saturar la barra.
 */
function ComposicionPorTipo({ porTipo, total }) {
  if (!porTipo?.length) return null;

  // Agrupar tipos pequeños (<2%) en "Otros" para legibilidad de la barra
  const grandes = porTipo.filter(t => t.pct >= 2);
  const chicos = porTipo.filter(t => t.pct < 2);
  const otrosStock = chicos.reduce((s, t) => s + t.stock, 0);
  const otrosModelos = chicos.reduce((s, t) => s + t.modelos, 0);
  const otrosPct = chicos.reduce((s, t) => s + t.pct, 0);

  const segmentos = [
    ...grandes.map((t, i) => ({ ...t, color: colorForTipo(i) })),
    ...(chicos.length > 0
      ? [{
          tipo: `Otros (${chicos.length})`,
          stock: otrosStock,
          modelos: otrosModelos,
          pct: Math.round(otrosPct * 10) / 10,
          color: 'hsl(220 9% 60%)',  // gris para "otros"
          _detalle: chicos,  // para tooltip extendido
        }]
      : []),
  ];

  return (
    <Card className="mt-3">
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Composición por tipo
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {formatNum(total)} und · {porTipo.length} tipos · {porTipo.reduce((s, t) => s + t.modelos, 0)} modelos
          </div>
        </div>

        {/* Barra apilada */}
        <TooltipProvider delayDuration={150}>
          <div className="flex h-7 w-full rounded-md overflow-hidden border bg-muted/40">
            {segmentos.map((s, idx) => (
              <Tooltip key={s.tipo + idx}>
                <TooltipTrigger asChild>
                  <div
                    className="h-full flex items-center justify-center text-[11px] font-semibold text-white cursor-help transition-opacity hover:opacity-80"
                    style={{ width: `${s.pct}%`, background: s.color, minWidth: s.pct >= 4 ? 'auto' : '0' }}
                  >
                    {s.pct >= 6 && <span className="px-1 truncate">{s.tipo}</span>}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="bg-popover text-popover-foreground border shadow-md">
                  <div className="text-xs space-y-0.5">
                    <div className="font-semibold">{s.tipo}</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
                      <span className="text-muted-foreground">Stock:</span>
                      <span className="text-right font-medium">{formatNum(s.stock)} und</span>
                      <span className="text-muted-foreground">Modelos:</span>
                      <span className="text-right font-medium">{formatNum(s.modelos)}</span>
                      <span className="text-muted-foreground">% del total:</span>
                      <span className="text-right font-medium">{s.pct.toFixed(1)}%</span>
                    </div>
                    {s._detalle && s._detalle.length > 0 && (
                      <div className="border-t pt-1 mt-1 space-y-0.5 max-h-32 overflow-auto">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Incluye:</div>
                        {s._detalle.map(d => (
                          <div key={d.tipo} className="flex justify-between gap-3">
                            <span>{d.tipo}</span>
                            <span className="text-muted-foreground tabular-nums">{formatNum(d.stock)} · {d.pct.toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>

        {/* Chips con leyenda */}
        <div className="flex flex-wrap gap-2 mt-3">
          {segmentos.map((s, idx) => (
            <div key={s.tipo + idx} className="flex items-center gap-1.5 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="font-medium">{s.tipo}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatNum(s.stock)} <span className="opacity-60">({s.pct.toFixed(1)}%)</span>
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Section({ numero, titulo, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-mono text-muted-foreground tracking-widest">§{numero}</span>
        <h2 className="text-base font-semibold">{titulo}</h2>
      </div>
      {children}
    </section>
  );
}

function MiniKPI({ label, value, small }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-400">{label}</div>
      <div className={`font-bold ${small ? 'text-sm' : 'text-xl'} mt-0.5`}>{value}</div>
    </div>
  );
}

function FlujoChart({ flujo }) {
  if (!flujo || !flujo.items?.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Sin movimientos en el período.
        </CardContent>
      </Card>
    );
  }

  // Recharts: barras stacked divergentes — entradas positivas, salidas negativas
  const chartData = flujo.items.map(it => ({
    fecha: it.fecha,
    'Compras/Trans IN': it.trans_in,
    'Devoluciones': it.devoluciones,
    'Ventas': -(it.ventas || 0),
    'Trans OUT': -(it.trans_out || 0),
    stock: it.stock_cierre,
  }));

  const fmtFecha = (s) => {
    if (!s) return s;
    const [, m, d] = s.split('-');
    return `${parseInt(d)}/${parseInt(m)}`;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Chart */}
      <Card className="lg:col-span-2">
        <CardContent className="pt-4">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="fecha" tick={{ fontSize: 10 }} tickFormatter={fmtFecha} />
              <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} stroke="hsl(var(--primary))" />
              <RTooltip contentStyle={{ fontSize: 11, padding: '6px 10px', borderRadius: 6 }}
                        labelFormatter={fmtFecha}
                        formatter={(v, k) => [Math.abs(v), k]} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} iconType="rect" />
              <ReferenceLine yAxisId="left" y={0} stroke="hsl(var(--border))" />
              <Bar yAxisId="left" dataKey="Compras/Trans IN" stackId="in"   fill="#10b981" />
              <Bar yAxisId="left" dataKey="Devoluciones"     stackId="in"   fill="#34d399" />
              <Bar yAxisId="left" dataKey="Ventas"           stackId="out"  fill="#ef4444" />
              <Bar yAxisId="left" dataKey="Trans OUT"        stackId="out"  fill="#fb923c" />
              <Line yAxisId="right" type="monotone" dataKey="stock" stroke="hsl(var(--primary))"
                    strokeWidth={2} dot={false} name="Stock cierre" />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Lateral: balance + interpretación */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Balance del período</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <BalanceRow label="Ventas"        value={`-${formatNum(flujo.totales.ventas)}`}        color="text-red-600" />
          <BalanceRow label="Trans OUT"     value={`-${formatNum(flujo.totales.trans_out)}`}     color="text-orange-500" sub="movimiento entre tiendas (no es pérdida real)" />
          <BalanceRow label="Trans IN"      value={`+${formatNum(flujo.totales.trans_in)}`}      color="text-emerald-600" />
          <BalanceRow label="Devoluciones"  value={`+${formatNum(flujo.totales.devoluciones)}`}  color="text-emerald-500" />
          <div className="border-t pt-2 mt-2">
            <BalanceRow
              label="Pérdida real (ventas netas)"
              value={`-${formatNum(flujo.totales.balance_neto)}`}
              color="text-red-700 font-semibold"
            />
          </div>
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 rounded-md p-2.5 text-xs mt-2">
            <Info className="h-3.5 w-3.5 inline mr-1 text-blue-600" />
            <b>Vendiste {formatNum(flujo.totales.ventas)} unidades</b> en {flujo.dias} días.
            Tu stock actual es <b>{formatNum(flujo.stock_actual)}</b>,
            que cubre <b>{flujo.totales.ventas > 0 ? Math.round((flujo.stock_actual / flujo.totales.ventas) * flujo.dias) : '∞'} días</b> al ritmo actual.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BalanceRow({ label, value, color, sub }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div>
        <div className="text-xs">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
      <div className={`tabular-nums text-sm ${color || ''}`}>{value}</div>
    </div>
  );
}

function SugerenciasTable({ items, nivel, tienda, onAction }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Sin sugerencias para los filtros activos.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[480px]">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground border-b bg-muted sticky top-0 z-10">
              <tr>
                <th className="text-left py-2 px-2 w-8">#</th>
                <th className="text-left py-2 px-2">Producto</th>
                <th className="text-right py-2 px-2 w-32">Stock</th>
                <th className="text-right py-2 px-2 w-16">Vel/día</th>
                <th className="text-right py-2 px-2 w-20">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted">Cobertura</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-left">
                      <div className="text-[11px] space-y-1">
                        <div><b>Cobertura actual</b>: stock / velocidad. Es lectura, no objetivo.</div>
                        <div className="border-t pt-1">
                          <b>Cobertura objetivo dinámica</b> (cuántos días queremos cubrir al pedir):
                          <ul className="list-disc list-inside mt-0.5 text-[10px]">
                            <li>vel &gt; 50 und/d → <b>14 días</b> (rápido, repongo seguido)</li>
                            <li>vel &gt; 5 und/d  → <b>30 días</b> (medio)</li>
                            <li>vel ≤ 5 und/d  → <b>60 días</b> (lento, evita pedidos chicos)</li>
                          </ul>
                          <div className="text-[10px] mt-1 italic">
                            Cap superior: el "cobertura_objetivo" pedido al endpoint manda como techo.
                          </div>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="text-right py-2 px-2 w-20">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted">Sug. teórico</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Calculado como (vel × cobertura efectiva) − stock proyectado. Antes de redondear al lote y antes de aplicar el tope físico.
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="text-right py-2 px-2 w-12">Lote</th>
                <th className="text-right py-2 px-2 w-24">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted font-bold">Pedir</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Sugerido teórico capado por el tope físico (tienda × tipo) y redondeado al múltiplo del lote mínimo.
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="text-left py-2 px-2 w-24">Origen</th>
                <th className="text-left py-2 px-2 w-16">Conf.</th>
                <th className="text-center py-2 px-2 w-20">Acción</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const cfg = ESTADO_CONFIG[it.estado] || ESTADO_CONFIG.ok;
                const cobLabel = it.cobertura_dias == null ? '∞' : `${Math.round(it.cobertura_dias)}d`;
                const stockMax = Math.max(it.stock_actual, it.sugerido_pedido, 1);
                const stockPct = (it.stock_actual / stockMax) * 100;

                const origenInterno = it.origen_sugerido && it.origen_sugerido !== 'ALMACEN' && it.origen_sugerido !== 'TALLER';
                const accionLabel = it.estado === 'dead' ? 'Liquidar' : (origenInterno ? 'Transferir' : 'Pedir');
                const accionTipo  = it.estado === 'dead' ? 'liquidar'  : (origenInterno ? 'transferir' : 'pedir');

                return (
                  <tr key={`${it.grupo_id}-${it.tmpl_id || ''}-${i}`}
                      className={`border-b hover:bg-accent/30 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                    <td className="py-2 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="py-2 px-2">
                      <div className="font-medium">{it.marca} · {it.tipo}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {it.entalle} · {it.tela}
                        {nivel === 'modelo' && it.modelo && ` · ${it.modelo}`}
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="tabular-nums">{formatNum(it.stock_actual)}</div>
                      <div className="h-1 bg-muted rounded-sm overflow-hidden mt-0.5">
                        <div className={`h-full ${
                          it.estado === 'crit' ? 'bg-red-500' :
                          it.estado === 'warn' ? 'bg-amber-500' :
                          it.estado === 'over' ? 'bg-zinc-400' :
                          it.estado === 'dead' ? 'bg-purple-400' :
                          'bg-emerald-500'
                        }`} style={{ width: `${stockPct}%` }} />
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{it.velocidad_dia.toFixed(1)}</td>
                    <td className="py-2 px-2 text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cfg.cls} cursor-help`}>
                            {cobLabel}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-[11px] space-y-0.5">
                            <div><b>Cobertura actual:</b> {cobLabel}</div>
                            {it.cobertura_objetivo != null && (
                              <div><b>Objetivo de pedido:</b> {it.cobertura_objetivo}d <span className="text-muted-foreground">({it.velocidad_dia > 50 ? 'rápido' : it.velocidad_dia > 5 ? 'medio' : 'lento'})</span></div>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                      {it.cobertura_objetivo != null && (
                        <div className="text-[9px] text-muted-foreground mt-0.5">obj {it.cobertura_objetivo}d</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{Math.round(it.sugerido_unidades_teorico)}</td>
                    <td className="py-2 px-2 text-right text-[10px] text-muted-foreground tabular-nums">{it.lote_minimo}</td>
                    <td className="py-2 px-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="font-bold text-primary tabular-nums">{formatNum(it.sugerido_pedido)}</span>
                        {it.tope_aplicado && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 cursor-help shrink-0" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="text-[11px] space-y-1">
                                <div className="font-semibold flex items-center gap-1">
                                  <ShieldAlert className="h-3 w-3" /> Tope aplicado
                                </div>
                                <div>
                                  Sugerencia capada por el tope <b>{formatNum(it.tope_valor)} und</b> de
                                  {' '}<b>{it.tipo}</b> en <b>{tienda}</b>.
                                </div>
                                {it.tope_skus_capados > 0 && (
                                  <div className="text-muted-foreground">
                                    {it.tope_skus_capados} SKU{it.tope_skus_capados !== 1 && 's'} del grupo recortado{it.tope_skus_capados !== 1 && 's'}
                                  </div>
                                )}
                                <div className="text-muted-foreground italic">
                                  Teórico era {formatNum(Math.round(it.sugerido_unidades_teorico))} und.
                                </div>
                                <div className="text-[10px] pt-1 border-t mt-1">
                                  ¿Te parece muy alto? <a href={`/config/topes-stock?tienda=${encodeURIComponent(tienda)}`} className="text-primary underline">Editar tope</a>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      {it.valor_estimado > 0 && (
                        <div className="text-[10px] text-muted-foreground">{formatSoles(it.valor_estimado)}</div>
                      )}
                      {it.tope_aplicado && (
                        <div className="text-[9px] text-amber-700 dark:text-amber-400 font-medium tabular-nums">
                          tope {formatNum(it.tope_valor)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {origenInterno ? (
                        <Badge variant="outline" className="bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 text-[10px]">
                          <ArrowLeftRight className="h-2.5 w-2.5 mr-0.5" />{it.origen_sugerido}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-blue-50 dark:bg-blue-950/30 border-blue-300 text-[10px]">
                          <Boxes className="h-2.5 w-2.5 mr-0.5" />{it.origen_sugerido}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 px-2 text-[10px]">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help">{CONFIANZA_CONFIG[it.confianza]?.label || '—'}</span>
                        </TooltipTrigger>
                        <TooltipContent>{CONFIANZA_CONFIG[it.confianza]?.desc}</TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="py-2 px-2 text-center">
                      <Button size="sm" variant={accionTipo === 'liquidar' ? 'outline' : 'default'}
                        className="h-7 text-[11px] px-2"
                        onClick={() => onAction(accionTipo, it)}
                        disabled={it.sugerido_pedido === 0 && accionTipo !== 'liquidar'}>
                        {accionLabel}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function MovimientosActivos({ flujo, reposicion }) {
  const enTransito = (reposicion?.items || []).filter(it => it.en_transito > 0).slice(0, 10);
  const topMovimiento = (flujo?.items || []).slice(-7).reverse(); // últimos 7 días

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* En tránsito */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Truck className="h-4 w-4" /> Transferencias en tránsito
          </CardTitle>
          <p className="text-[10px] text-muted-foreground">
            {(reposicion?.items || []).reduce((s, it) => s + (it.en_transito || 0), 0)} unidades llegando
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {enTransito.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin transferencias activas.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-1.5 px-3">Producto</th>
                  <th className="text-right py-1.5 px-3">Llegando</th>
                </tr>
              </thead>
              <tbody>
                {enTransito.map((it, i) => (
                  <tr key={`${it.grupo_id}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 px-3">
                      <div className="font-medium truncate">{it.marca} · {it.tipo}</div>
                      <div className="text-[10px] text-muted-foreground">{it.entalle} · {it.tela}</div>
                    </td>
                    <td className="text-right tabular-nums py-1.5 px-3 font-semibold text-emerald-600">
                      +{formatNum(it.en_transito)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Top movimiento del período (días con más actividad) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" /> Actividad reciente
          </CardTitle>
          <p className="text-[10px] text-muted-foreground">Últimos 7 días</p>
        </CardHeader>
        <CardContent className="p-0">
          {topMovimiento.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin movimientos.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-1.5 px-3">Fecha</th>
                  <th className="text-right py-1.5 px-3">Ventas</th>
                  <th className="text-right py-1.5 px-3">In</th>
                  <th className="text-right py-1.5 px-3">Out</th>
                </tr>
              </thead>
              <tbody>
                {topMovimiento.map((d, i) => (
                  <tr key={d.fecha} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 px-3 font-medium">{d.fecha}</td>
                    <td className="text-right tabular-nums py-1.5 px-3 text-red-600">-{d.ventas}</td>
                    <td className="text-right tabular-nums py-1.5 px-3 text-emerald-600">+{d.trans_in}</td>
                    <td className="text-right tabular-nums py-1.5 px-3 text-orange-500">-{d.trans_out}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SobrestockTable({ items, tiendaActual, onTransferir }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Sin productos con sobrestock en {tiendaActual}.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[300px]">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-muted-foreground border-b bg-muted sticky top-0">
              <tr>
                <th className="text-left py-2 px-3">Producto</th>
                <th className="text-right py-2 px-3">Stock acá</th>
                <th className="text-right py-2 px-3">Vel/día</th>
                <th className="text-right py-2 px-3">Cobertura</th>
                <th className="text-center py-2 px-3">Acción</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 20).map((it, i) => (
                <tr key={`${it.grupo_id}-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 px-3">
                    <div className="font-medium">{it.marca} · {it.tipo}</div>
                    <div className="text-[10px] text-muted-foreground">{it.entalle} · {it.tela}</div>
                  </td>
                  <td className="text-right tabular-nums py-2 px-3 font-semibold">{formatNum(it.stock_actual)}</td>
                  <td className="text-right tabular-nums py-2 px-3">{it.velocidad_dia.toFixed(1)}</td>
                  <td className="text-right py-2 px-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded border bg-zinc-100 dark:bg-zinc-800">
                      {it.cobertura_dias == null ? '∞' : `${Math.round(it.cobertura_dias)}d`}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-center">
                    <Button size="sm" variant="outline" className="h-7 text-[11px]"
                      onClick={() => onTransferir(it)}>
                      <ArrowLeftRight className="h-3 w-3 mr-1" /> Transferir
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfirmDialog({ open, onClose, dialog, tienda }) {
  // ATENCIÓN: este componente debe estar siempre montado para que los hooks
  // mantengan estabilidad de orden entre renders. La protección "!dialog"
  // se hace devolviendo null DESPUÉS de los hooks.
  const [surtido, setSurtido] = useState(null);
  const [loadingSurtido, setLoadingSurtido] = useState(false);
  const tipo = dialog?.tipo;
  const item = dialog?.item;

  const esAlmacen = item && (item.origen_sugerido === 'ALMACEN' || item.origen_sugerido === 'TALLER' || item.origen_sugerido === 'AP');
  const esTransferenciaInterna = tipo === 'transferir' && !esAlmacen;

  // Cargar surtido cuando se abre dialog con transferencia interna
  useEffect(() => {
    if (!open || !esTransferenciaInterna || !item) {
      setSurtido(null);
      return;
    }
    setLoadingSurtido(true);
    setSurtido(null);
    const params = {
      tienda_origen:  item.origen_sugerido,
      tienda_destino: tienda,
      marca:   item.marca,
      tipo:    item.tipo,
      entalle: item.entalle,
      tela:    item.tela,
    };
    api.get('/inventario/surtido', { params })
      .then(r => setSurtido(r.data))
      .catch(e => toast.error('Error al cargar surtido: ' + (e.response?.data?.detail || e.message)))
      .finally(() => setLoadingSurtido(false));
  }, [open, esTransferenciaInterna, item, tienda]);

  if (!dialog) return null;

  const titulos = {
    pedir:       { titulo: 'Confirmar pedido al almacén',  icon: Send,           color: 'text-primary' },
    transferir:  { titulo: 'Confirmar transferencia',      icon: ArrowLeftRight, color: 'text-emerald-600' },
    liquidar:    { titulo: 'Marcar para liquidación',      icon: Tag,            color: 'text-purple-600' },
  };
  const cfg = titulos[tipo] || titulos.pedir;
  const Icon = cfg.icon;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={esTransferenciaInterna ? 'max-w-4xl max-h-[88vh] overflow-y-auto' : 'max-w-md'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={`h-5 w-5 ${cfg.color}`} /> {cfg.titulo}
          </DialogTitle>
          <DialogDescription>
            La integración con Odoo se hará en el siguiente sprint. Por ahora esto solo confirma la decisión.
          </DialogDescription>
        </DialogHeader>

        {/* Resumen del item */}
        <div className="space-y-2 text-sm">
          <Row label="Tienda destino"  value={tienda} />
          <Row label="Producto"        value={`${item.marca} · ${item.tipo} · ${item.entalle} · ${item.tela}`} />
          {item.modelo && <Row label="Modelo" value={item.modelo} />}
          <Row label="Stock actual"    value={formatNum(item.stock_actual)} />
          <Row label="Velocidad/día"   value={item.velocidad_dia.toFixed(2)} />
          {tipo === 'pedir' || tipo === 'transferir' ? (
            <>
              <Row label="Origen"           value={item.origen_sugerido} highlight />
              <Row label="Cantidad sugerida" value={`${formatNum(item.sugerido_pedido)} unidades`} highlight />
              <Row label="Lote mínimo"      value={item.lote_minimo} />
              <Row label="Valor estimado"   value={formatSoles(item.valor_estimado)} />
            </>
          ) : (
            <Row label="Stock a liquidar" value={`${formatNum(item.stock_actual)} unidades`} highlight />
          )}
        </div>

        {/* Matriz de surtido color × talla (solo cuando es transferencia entre tiendas) */}
        {esTransferenciaInterna && (
          <div className="border-t pt-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
              <ArrowLeftRight className="h-3.5 w-3.5" />
              Surtido sugerido — talla × color
              <span className="text-[10px] font-normal normal-case text-muted-foreground ml-auto">
                Stock en <b>{item.origen_sugerido}</b> · Velocidad en <b>{tienda}</b>
              </span>
            </div>
            <SurtidoMatriz
              surtido={surtido}
              loading={loadingSurtido}
              tiendaOrigen={item.origen_sugerido}
              tiendaDestino={tienda}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => { toast.success(`${cfg.titulo} (próximamente integrado a Odoo)`); onClose(); }}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pivot color × talla para visualizar el surtido sugerido entre origen y destino.
 *
 * Cada celda muestra (formato compacto):
 *   - Stock disponible en origen (numerador)
 *   - Cuánto sugerimos traer (resaltado si > 0)
 *   - Tooltip con detalle de stock destino, velocidad, cobertura
 */
function SurtidoMatriz({ surtido, loading, tiendaOrigen, tiendaDestino }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Calculando surtido…
      </div>
    );
  }
  if (!surtido) return null;

  const items = surtido.items || [];
  const tallas = surtido.tallas || [];

  if (items.length === 0) {
    return (
      <div className="text-center py-6 text-xs text-muted-foreground">
        Sin variantes para este grupo en {tiendaOrigen}.
      </div>
    );
  }

  // Agrupar por color para tabla pivot
  const porColor = {};
  for (const it of items) {
    if (!porColor[it.color]) porColor[it.color] = {};
    porColor[it.color][it.talla] = it;
  }
  const colores = Object.keys(porColor);
  // Orden: por sum sugerido_traer DESC (los más urgentes arriba)
  colores.sort((a, b) => {
    const sa = Object.values(porColor[a]).reduce((s, x) => s + (x.sugerido_traer || 0), 0);
    const sb = Object.values(porColor[b]).reduce((s, x) => s + (x.sugerido_traer || 0), 0);
    return sb - sa;
  });

  return (
    <div className="space-y-2">
      {/* Resumen */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-muted/40 rounded px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stock origen</div>
          <div className="font-semibold tabular-nums">{formatNum(surtido.totales.stock_origen)} und</div>
        </div>
        <div className="bg-muted/40 rounded px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stock destino</div>
          <div className="font-semibold tabular-nums">{formatNum(surtido.totales.stock_destino)} und</div>
        </div>
        <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded px-2 py-1.5 border border-emerald-200 dark:border-emerald-900">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Sugerido traer</div>
          <div className="font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{formatNum(surtido.totales.sugerido_traer)} und</div>
        </div>
      </div>

      {/* Pivot color × talla */}
      <div className="overflow-auto max-h-[42vh] border rounded">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 border-b sticky top-0 z-10">
            <tr>
              <th className="text-left py-1.5 px-2 sticky left-0 bg-muted/60 z-20 border-r min-w-[110px]">Color</th>
              {tallas.map(t => (
                <th key={t} className="text-center py-1.5 px-1.5 font-semibold min-w-[58px]">{t}</th>
              ))}
              <th className="text-right py-1.5 px-2 bg-muted/60 border-l min-w-[60px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {colores.map(color => {
              const totalSug = tallas.reduce((s, t) => s + (porColor[color][t]?.sugerido_traer || 0), 0);
              const totalStkO = tallas.reduce((s, t) => s + (porColor[color][t]?.stock_origen || 0), 0);
              return (
                <tr key={color} className="border-b hover:bg-accent/20">
                  <td className="py-1 px-2 font-medium sticky left-0 bg-background z-10 border-r whitespace-nowrap">
                    {color}
                  </td>
                  {tallas.map(t => {
                    const cell = porColor[color][t];
                    if (!cell) {
                      return <td key={t} className="text-center text-muted-foreground/40 px-1">—</td>;
                    }
                    const traer = cell.sugerido_traer;
                    const stkO = cell.stock_origen;
                    const stkD = cell.stock_destino;
                    const vel = cell.vel_destino;
                    const cellCls = traer > 0
                      ? 'bg-emerald-100/60 dark:bg-emerald-950/30 font-semibold text-emerald-800 dark:text-emerald-300'
                      : stkO > 0
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/40';
                    return (
                      <td key={t} className={`text-center py-1 px-1.5 tabular-nums ${cellCls}`}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">
                              {traer > 0 ? (
                                <span className="block leading-tight">
                                  <span className="font-bold">{traer}</span>
                                  <span className="block text-[9px] opacity-60">/{stkO}</span>
                                </span>
                              ) : stkO > 0 ? (
                                <span className="text-[10px]">·{stkO}</span>
                              ) : '—'}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <div className="text-[11px] space-y-0.5">
                              <div className="font-semibold border-b pb-1">{color} · talla {t}</div>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
                                <span className="text-muted-foreground">Stock {tiendaOrigen}:</span>
                                <span className="text-right">{stkO}</span>
                                <span className="text-muted-foreground">Stock {tiendaDestino}:</span>
                                <span className="text-right">{stkD}</span>
                                <span className="text-muted-foreground">Vel. {tiendaDestino}:</span>
                                <span className="text-right">{vel.toFixed(2)} und/d</span>
                                {cell.cobertura_dias_destino != null && (
                                  <>
                                    <span className="text-muted-foreground">Cobertura {tiendaDestino}:</span>
                                    <span className="text-right">{cell.cobertura_dias_destino}d</span>
                                  </>
                                )}
                                <span className="text-muted-foreground">Necesita ({cell.cobertura_objetivo}d):</span>
                                <span className="text-right">{cell.necesita_destino}</span>
                              </div>
                              {traer > 0 && (
                                <div className="border-t pt-1 mt-1 text-emerald-700 dark:text-emerald-400 font-semibold">
                                  → Sugerido traer: {traer} und
                                </div>
                              )}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    );
                  })}
                  <td className="text-right py-1 px-2 bg-muted/30 border-l font-bold tabular-nums">
                    {totalSug > 0 ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {totalSug}
                        <span className="text-[9px] text-muted-foreground ml-0.5">/{totalStkO}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">{totalStkO}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-3">
        <span><b className="text-emerald-700 dark:text-emerald-400">N</b>/<span className="opacity-60">M</span> = sugerido / stock origen</span>
        <span>· <span className="opacity-60">·M</span> = solo stock origen (no se necesita traer)</span>
        <span>· — = sin disponibilidad</span>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${highlight ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

function ReposicionSkeleton() {
  return (
    <div className="p-6 space-y-5">
      <Skeleton className="h-9 w-72" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
