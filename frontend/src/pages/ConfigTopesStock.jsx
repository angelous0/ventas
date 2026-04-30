/**
 * Configuración de TOPES de stock por (tienda × tipo).
 * Ruta: /config/topes-stock
 *
 * Matriz editable: filas = tiendas (codigo), columnas = tipos (nombre).
 * Cada celda es un input numérico (`stock_max_por_sku`) + toggle activo.
 *
 * Endpoints usados:
 *   GET  /api/catalogos/tiendas         — lista tiendas
 *   GET  /api/catalogos/tipos           — lista tipos
 *   GET  /api/config/stock-max          — valores actuales (incluye inactivos)
 *   GET  /api/config/stock-max/sugerencia — autopopular desde histórico (P95)
 *   POST /api/config/stock-max/bulk     — guardar matriz completa
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatNum } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip';
import { Sliders, Save, Wand2, RotateCcw, Eye, EyeOff, ShieldAlert, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';


export default function ConfigTopesStock() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tiendaFiltro = searchParams.get('tienda') || '';

  const [tiendas, setTiendas] = useState([]);    // [{value,label}]
  const [tipos, setTipos] = useState([]);        // [{id,nombre}]
  const [config, setConfig] = useState({});      // {[tienda]: {[tipo]: {value, activo}}}
  const [original, setOriginal] = useState({});  // copia para detectar diff
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [sugiriendo, setSugiriendo] = useState(false);
  const [sugerencias, setSugerencias] = useState({}); // {[tienda]: {[tipo]: {sugerido, p_observado, max_observado}}}
  const [filtroTienda, setFiltroTienda] = useState(tiendaFiltro);

  // Cargar catálogos + config
  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const [rT, rTipos, rCfg] = await Promise.all([
        api.get('/catalogos/tiendas'),
        api.get('/catalogos/tipos'),
        api.get('/config/stock-max', { params: { incluir_inactivos: true } }),
      ]);
      const tList = (rT.data || []).map(t => ({ value: t.value || t.label, label: t.label || t.value }));
      const tipoList = (rTipos.data || []);

      // Construir matriz: defaults vacíos
      const matrix = {};
      for (const t of tList) {
        matrix[t.value] = {};
        for (const tipo of tipoList) {
          matrix[t.value][tipo.nombre] = { value: '', activo: true };
        }
      }
      // Merge con datos guardados
      for (const it of (rCfg.data?.items || [])) {
        if (!matrix[it.tienda_codigo]) matrix[it.tienda_codigo] = {};
        matrix[it.tienda_codigo][it.tipo_nombre] = {
          value: String(it.stock_max_por_sku),
          activo: it.activo,
        };
      }

      setTiendas(tList);
      setTipos(tipoList);
      setConfig(matrix);
      setOriginal(JSON.parse(JSON.stringify(matrix)));
    } catch (e) {
      toast.error('Error al cargar configuración: ' + (e.response?.data?.detail || e.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Helpers
  const setCell = (tienda, tipo, patch) => {
    setConfig(prev => ({
      ...prev,
      [tienda]: {
        ...prev[tienda],
        [tipo]: { ...prev[tienda]?.[tipo], ...patch },
      },
    }));
  };

  const isDirty = (tienda, tipo) => {
    const a = config[tienda]?.[tipo];
    const b = original[tienda]?.[tipo];
    if (!a || !b) return !!a?.value;
    return a.value !== b.value || a.activo !== b.activo;
  };

  // Conteo de cambios pendientes
  const cambiosPendientes = useMemo(() => {
    let n = 0;
    for (const t of tiendas) {
      for (const tipo of tipos) {
        if (isDirty(t.value, tipo.nombre)) n++;
      }
    }
    return n;
  }, [config, original, tiendas, tipos]);

  // Sugerir desde histórico
  const sugerir = async () => {
    setSugiriendo(true);
    try {
      const r = await api.get('/config/stock-max/sugerencia', { params: { meses: 12, percentil: 95 } });
      const map = {};
      for (const it of (r.data?.items || [])) {
        if (!map[it.tienda_codigo]) map[it.tienda_codigo] = {};
        map[it.tienda_codigo][it.tipo_nombre] = {
          sugerido: it.stock_max_sugerido,
          p_observado: it.p_observado,
          max_observado: it.max_observado,
          skus_observados: it.skus_observados,
        };
      }
      setSugerencias(map);

      // Aplicar sugerencias a celdas vacías o que NO han sido modificadas
      setConfig(prev => {
        const next = { ...prev };
        let aplicados = 0;
        for (const tienda of Object.keys(map)) {
          if (!next[tienda]) continue;
          for (const tipo of Object.keys(map[tienda])) {
            if (!next[tienda][tipo]) continue;
            const sug = map[tienda][tipo].sugerido;
            // Solo si no hay valor o si la celda no fue modificada respecto al original
            const orig = original[tienda]?.[tipo];
            const cur = next[tienda][tipo];
            const fueModificado = cur.value !== orig?.value;
            if (!cur.value || (!fueModificado && Number(cur.value) !== sug)) {
              next[tienda] = { ...next[tienda] };
              next[tienda][tipo] = { ...cur, value: String(sug) };
              aplicados++;
            }
          }
        }
        toast.success(`Sugerencias aplicadas a ${aplicados} celdas (P95 histórico, redondeado a 10)`);
        return next;
      });
    } catch (e) {
      toast.error('Error al obtener sugerencias: ' + (e.response?.data?.detail || e.message));
    } finally {
      setSugiriendo(false);
    }
  };

  // Resetear cambios
  const resetear = () => {
    setConfig(JSON.parse(JSON.stringify(original)));
    toast.info('Cambios descartados');
  };

  // Guardar todo (bulk)
  const guardar = async () => {
    // Validar: cada celda con value debe ser entero > 0
    const items = [];
    const errores = [];
    for (const t of tiendas) {
      for (const tipo of tipos) {
        const cell = config[t.value]?.[tipo.nombre];
        if (!cell || !cell.value) continue;
        const n = parseInt(cell.value, 10);
        if (!Number.isFinite(n) || n <= 0) {
          errores.push(`${t.value} × ${tipo.nombre}: "${cell.value}" no es un entero positivo`);
          continue;
        }
        // Solo enviar las que cambiaron (o son nuevas) — minimizar payload
        if (isDirty(t.value, tipo.nombre)) {
          items.push({
            tienda_codigo: t.value,
            tipo_nombre: tipo.nombre,
            stock_max_por_sku: n,
            activo: cell.activo !== false,
          });
        }
      }
    }
    if (errores.length) {
      toast.error('Hay valores inválidos: ' + errores[0] + (errores.length > 1 ? ` (+${errores.length - 1} más)` : ''));
      return;
    }
    if (items.length === 0) {
      toast.info('Nada que guardar');
      return;
    }

    setGuardando(true);
    try {
      const r = await api.post('/config/stock-max/bulk', { items });
      toast.success(`${r.data.guardados} cambios guardados`);
      // Refrescar para reflejar updated_at del servidor
      await cargar();
    } catch (e) {
      toast.error('Error al guardar: ' + (e.response?.data?.detail || e.message));
    } finally {
      setGuardando(false);
    }
  };

  const tiendasMostradas = filtroTienda
    ? tiendas.filter(t => t.value === filtroTienda)
    : tiendas;

  return (
    <TooltipProvider delayDuration={150}>
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sliders className="h-6 w-6 text-primary" /> Topes de stock por tienda × tipo
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define el <b>máximo de unidades por SKU lógico</b> (marca·tipo·entalle·tela) que entra en cada tienda.
            Aplica como cap duro a las sugerencias de <a href="/reposicion" className="text-primary underline">/reposicion</a>.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {cambiosPendientes > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium tabular-nums">
              ⚠ {cambiosPendientes} cambio{cambiosPendientes !== 1 && 's'} pendiente{cambiosPendientes !== 1 && 's'}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={sugerir} disabled={sugiriendo} className="gap-1">
            {sugiriendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            Sugerir desde histórico
          </Button>
          <Button variant="outline" size="sm" onClick={resetear} disabled={cambiosPendientes === 0} className="gap-1">
            <RotateCcw className="h-3.5 w-3.5" /> Descartar
          </Button>
          <Button size="sm" onClick={guardar} disabled={guardando || cambiosPendientes === 0} className="gap-1">
            {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Guardar todo
          </Button>
        </div>
      </div>

      {/* Filtro */}
      {tiendas.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Filtrar tienda:</span>
          <button
            onClick={() => { setFiltroTienda(''); setSearchParams({}); }}
            className={`px-2 py-1 rounded border ${!filtroTienda ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
          >Todas</button>
          {tiendas.map(t => (
            <button
              key={t.value}
              onClick={() => { setFiltroTienda(t.value); setSearchParams({ tienda: t.value }); }}
              className={`px-2 py-1 rounded border ${filtroTienda === t.value ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
            >{t.value}</button>
          ))}
        </div>
      )}

      {/* Matriz */}
      {loading ? (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              Matriz editable
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-md">
                  <div className="text-xs space-y-1">
                    <div>El tope se aplica al <b>grupo entero</b> (marca·tipo·entalle·tela), no por variante color×talla.</div>
                    <div>Cap duro: si stock + en_tránsito + sugerido superan el tope, la sugerencia se recorta.</div>
                    <div className="text-muted-foreground italic">Tip: usa "Sugerir desde histórico" para autopoblar con el P95 observado en los últimos 12m.</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
              <div className="overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 border-b sticky top-0 z-10">
                    <tr>
                      <th className="text-left py-2 px-3 sticky left-0 bg-muted/60 z-20 border-r min-w-[100px]">Tienda</th>
                      {tipos.map(tipo => (
                        <th key={tipo.id} className="text-center py-2 px-2 font-semibold tracking-tight whitespace-nowrap">
                          {tipo.nombre}
                        </th>
                      ))}
                      <th className="text-center py-2 px-2 w-16 text-muted-foreground">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tiendasMostradas.map(t => {
                      const allInactivos = tipos.every(ti => config[t.value]?.[ti.nombre]?.activo === false);
                      return (
                        <tr key={t.value} className="border-b hover:bg-muted/10">
                          <td className="py-1.5 px-3 font-mono font-bold sticky left-0 bg-background z-10 border-r">
                            {t.value}
                          </td>
                          {tipos.map(tipo => {
                            const cell = config[t.value]?.[tipo.nombre] || { value: '', activo: true };
                            const dirty = isDirty(t.value, tipo.nombre);
                            const sug = sugerencias[t.value]?.[tipo.nombre];
                            const inactivo = cell.activo === false;
                            return (
                              <td key={tipo.id} className="py-1.5 px-1.5 text-center">
                                <div className="flex flex-col items-center gap-0.5">
                                  <Input
                                    type="number"
                                    min={1}
                                    value={cell.value}
                                    onChange={e => setCell(t.value, tipo.nombre, { value: e.target.value })}
                                    disabled={inactivo}
                                    className={`h-7 text-xs text-center w-20 tabular-nums px-1
                                      ${dirty ? 'border-amber-400 ring-1 ring-amber-200 dark:ring-amber-900/40' : ''}
                                      ${inactivo ? 'opacity-40 line-through' : ''}`}
                                    title={sug ? `Sugerido P95: ${sug.sugerido} (max obs ${sug.max_observado}, ${sug.skus_observados} SKUs)` : undefined}
                                  />
                                  {sug && cell.value !== String(sug.sugerido) && (
                                    <button
                                      onClick={() => setCell(t.value, tipo.nombre, { value: String(sug.sugerido) })}
                                      className="text-[9px] text-primary hover:underline cursor-pointer"
                                      title={`Aplicar sugerencia (P95=${sug.p_observado}, max=${sug.max_observado})`}
                                    >
                                      sug {sug.sugerido}
                                    </button>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                          <td className="py-1.5 px-2 text-center">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => {
                                    const nuevoEstado = !allInactivos;
                                    setConfig(prev => {
                                      const next = { ...prev };
                                      next[t.value] = { ...next[t.value] };
                                      for (const tipo of tipos) {
                                        next[t.value][tipo.nombre] = {
                                          ...next[t.value][tipo.nombre],
                                          activo: !nuevoEstado,
                                        };
                                      }
                                      return next;
                                    });
                                  }}
                                  title={allInactivos ? 'Activar todos los tipos de esta tienda' : 'Desactivar todos los tipos de esta tienda'}
                                >
                                  {allInactivos ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : <Eye className="h-3.5 w-3.5" />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {allInactivos ? 'Activar fila' : 'Desactivar fila'}
                              </TooltipContent>
                            </Tooltip>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
          </CardContent>
        </Card>
      )}

      {/* Leyenda */}
      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0" />
            <span>El tope se interpreta como <b>"unidades máximas por grupo (marca·tipo·entalle·tela) en una tienda"</b>. Aplica como cap duro a /reposicion.</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-amber-400 rounded-sm shrink-0"></span>
            <span>Borde amarillo = celda modificada y no guardada.</span>
          </div>
          <div className="flex items-center gap-2">
            <Wand2 className="h-3.5 w-3.5 shrink-0" />
            <span>"Sugerir desde histórico" usa el percentil 95 del stock observado en los últimos 12m, redondeado al múltiplo de 10 más cercano.</span>
          </div>
        </CardContent>
      </Card>
    </div>
    </TooltipProvider>
  );
}
