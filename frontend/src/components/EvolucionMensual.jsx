import { useEffect, useState, useMemo } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { useFilters } from '../context/FiltersContext';
import { LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { DollarSign, Package } from 'lucide-react';

/**
 * EvolucionMensual: LineChart de 3 años (2024 / 2025 / 2026) con 12 meses cada uno.
 *
 * - Una sola call al endpoint /api/dashboard/evolucion-mensual (1 query SQL agregada)
 * - Tooltip muestra los 3 valores del mes hovereado + variación YoY
 * - Toggle Soles / Unidades arriba a la derecha
 * - Se suscribe a FiltersContext (tiendas/marcas/tipos)
 *
 * NOTA: Ignora el filtro `periodo` porque siempre muestra el año completo
 * — son 3 años de comparación temporal.
 */

const MESES_LABELS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

export function EvolucionMensual() {
  const { filters } = useFilters();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [metrica, setMetrica] = useState('ventas'); // 'ventas' | 'unidades'

  const apiParams = useMemo(() => {
    const hoyAnio = new Date().getFullYear();
    const p = { anios: `${hoyAnio - 2},${hoyAnio - 1},${hoyAnio}` };
    if (filters.tiendas.length) p.tienda = filters.tiendas.join(',');
    if (filters.marcas.length) p.marca_id = filters.marcas.join(',');
    if (filters.tipos.length) p.tipo_id = filters.tipos.join(',');
    return p;
  }, [filters.tiendas, filters.marcas, filters.tipos]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/dashboard/evolucion-mensual', { params: apiParams })
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiParams]);

  // Pivotear data: { mes: 'Ene', '2024': X, '2025': Y, '2026': Z }
  const chartData = useMemo(() => {
    if (!data?.series) return [];
    const anios = data.anios || [];
    return MESES_LABELS.map((label, i) => {
      const row = { mes: label };
      anios.forEach(a => {
        const v = data.series[String(a)]?.[i];
        row[String(a)] = v ? v[metrica] : 0;
      });
      return row;
    });
  }, [data, metrica]);

  const anios = data?.anios || [];
  const anioActual = anios[anios.length - 1];

  // Para que la línea del año actual no muestre puntos en meses futuros
  const mesActual = new Date().getMonth() + 1;

  const fmtY = (v) => metrica === 'ventas' ? `S/${(v / 1000).toFixed(0)}K` : formatNum(v);
  const fmtTooltipValue = (v) => metrica === 'ventas' ? formatSoles(v) : `${formatNum(v)} und`;

  // Colores por año
  const colors = {
    [anios[0]]: '#94a3b8', // slate-400
    [anios[1]]: '#60a5fa', // blue-400
    [anios[2]]: 'hsl(var(--primary))', // primary
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Evolución mensual</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {anios.length > 0 ? `${anios.join(' · ')}` : 'Cargando…'}
            {filters.tiendas.length > 0 && ` · ${filters.tiendas.length} tienda${filters.tiendas.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex gap-0.5 p-0.5 rounded border bg-muted/30">
          <ToggleBtn active={metrica === 'ventas'}    onClick={() => setMetrica('ventas')}    icon={DollarSign} label="Soles" />
          <ToggleBtn active={metrica === 'unidades'}  onClick={() => setMetrica('unidades')}  icon={Package}    label="Unidades" />
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        {loading && !data ? (
          <Skeleton className="h-72 w-full" />
        ) : !data || chartData.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-12">Sin datos para los filtros activos.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtY} width={60} />
              <RTooltip
                content={<CustomTooltip anios={anios} anioActual={anioActual} mesActual={mesActual} fmt={fmtTooltipValue} metrica={metrica} />}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="line" />
              {anios.map(a => (
                <Line key={a}
                  type="monotone"
                  dataKey={String(a)}
                  name={String(a)}
                  stroke={colors[a] || '#888'}
                  strokeWidth={a === anioActual ? 2.5 : 1.5}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 5 }}
                  // Año actual: cortar en mes actual para no dibujar futuro
                  connectNulls={false}
                  data={a === anioActual
                    ? chartData.map((d, i) => ({ ...d, [String(a)]: i + 1 <= mesActual ? d[String(a)] : null }))
                    : undefined}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function ToggleBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button onClick={onClick}
      className={`px-2 py-1 text-xs rounded inline-flex items-center gap-1 ${
        active ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'
      }`}>
      <Icon className="h-3 w-3" />{label}
    </button>
  );
}

function CustomTooltip({ active, payload, label, anios, anioActual, mesActual, fmt, metrica }) {
  if (!active || !payload || payload.length === 0) return null;

  // Encontrar valores por año
  const byAnio = {};
  payload.forEach(p => { byAnio[p.dataKey] = p.value; });

  // Calcular variación YoY: año actual vs anterior
  const anteAnioActual = anios[anios.indexOf(anioActual) - 1];
  const vActual = byAnio[String(anioActual)];
  const vAnterior = byAnio[String(anteAnioActual)];
  const yoy = (vActual != null && vAnterior > 0)
    ? ((vActual - vAnterior) / vAnterior) * 100
    : null;

  return (
    <div className="bg-popover border rounded-md shadow-md p-2.5 text-xs space-y-1">
      <div className="font-semibold border-b pb-1 mb-1">{label} · {metrica === 'ventas' ? 'Ventas' : 'Unidades'}</div>
      {anios.map(a => {
        const v = byAnio[String(a)];
        const isActual = a === anioActual;
        return (
          <div key={a} className="flex items-center justify-between gap-3">
            <span className={isActual ? 'font-semibold' : 'text-muted-foreground'}>{a}{isActual && ' (actual)'}</span>
            <span className="tabular-nums">{v == null ? '—' : fmt(v)}</span>
          </div>
        );
      })}
      {yoy != null && (
        <div className="border-t pt-1 mt-1 flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-[10px]">YoY {anioActual} vs {anteAnioActual}</span>
          <span className={`text-[11px] font-semibold tabular-nums ${
            yoy > 0 ? 'text-emerald-600 dark:text-emerald-400' :
            yoy < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
          }`}>{formatPct(yoy)}</span>
        </div>
      )}
    </div>
  );
}
