import { useEffect, useMemo, useState } from 'react';
import { api, formatSoles, formatNum } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  Loader2, Clock, Search, X as XIcon, Download, ArrowUpDown, ArrowUp, ArrowDown,
  AlertTriangle, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

// Chips de antigüedad. Cada uno define el rango [min, max] de días.
const CHIPS_DIAS = [
  { value: '',         label: 'Todos',         min: null, max: null },
  { value: 'recientes',label: '≤ 3 días',      min: 0,    max: 3,    cls: 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-300' },
  { value: 'normal',   label: '4–7 días',      min: 4,    max: 7,    cls: 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950/30 dark:text-blue-300' },
  { value: 'urgente',  label: 'Urgentes (>7)', min: 8,    max: 30,   cls: 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/30 dark:text-amber-300' },
  { value: 'criticas', label: 'Críticas (>30)',min: 31,   max: 9999, cls: 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30 dark:text-red-300' },
];

// Configuración de columnas ordenables. key = campo del item, label = header,
// type = numérico vs texto para el comparador.
const COLUMNAS = [
  { key: 'date_order',     label: 'Fecha',       type: 'date',  align: 'left',  width: 'w-[88px]' },
  { key: 'dias_reserva',   label: 'Días',        type: 'num',   align: 'right', width: 'w-[60px]' },
  { key: 'cliente_nombre', label: 'Cliente',     type: 'text',  align: 'left' },
  { key: 'tienda',         label: 'Tienda',      type: 'text',  align: 'left',  width: 'w-[80px]' },
  { key: 'vendedor_nombre',label: 'Vendedor',    type: 'text',  align: 'left',  width: 'w-[140px]' },
  { key: 'num_comp',       label: 'Comprobante', type: 'text',  align: 'left',  width: 'w-[140px]' },
  { key: 'lineas',         label: 'Líneas',      type: 'num',   align: 'right', width: 'w-[60px]' },
  { key: 'unidades',       label: 'Unidades',    type: 'num',   align: 'right', width: 'w-[80px]' },
  { key: 'monto',          label: 'Monto',       type: 'num',   align: 'right', width: 'w-[100px]' },
];

export default function ReservasPendientes() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filtros
  const [q, setQ] = useState('');                  // búsqueda libre (cliente/vendedor/comprobante)
  const [chipDias, setChipDias] = useState('');    // antigüedad
  const [tiendaSel, setTiendaSel] = useState('');  // tienda
  const [vendedorSel, setVendedorSel] = useState(''); // vendedor

  // Sort
  const [sortKey, setSortKey] = useState('date_order');
  const [sortDir, setSortDir] = useState('desc');  // 'asc' | 'desc'

  const cargar = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await api.get('/reservas/pendientes');
      setData(res.data);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { cargar(); }, []);

  // Universos para los selects (computados del data)
  const tiendas = useMemo(() => {
    if (!data?.items) return [];
    const s = new Set(data.items.map(it => it.tienda).filter(Boolean));
    return Array.from(s).sort();
  }, [data]);

  const vendedores = useMemo(() => {
    if (!data?.items) return [];
    const s = new Set(data.items.map(it => it.vendedor_nombre).filter(Boolean));
    return Array.from(s).sort();
  }, [data]);

  // Items filtrados + ordenados
  const itemsView = useMemo(() => {
    if (!data?.items) return [];
    const qLow = q.trim().toLowerCase();
    const chipDef = CHIPS_DIAS.find(c => c.value === chipDias) || CHIPS_DIAS[0];

    let arr = data.items.filter(it => {
      // Búsqueda libre
      if (qLow) {
        const blob = [
          it.cliente_nombre, it.cliente_phone,
          it.vendedor_nombre, it.tienda,
          it.tipo_comp, it.num_comp,
          (it.tipo_comp || '') + ' ' + (it.num_comp || ''),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!blob.includes(qLow)) return false;
      }
      // Antigüedad
      if (chipDef.min != null && (it.dias_reserva ?? 0) < chipDef.min) return false;
      if (chipDef.max != null && (it.dias_reserva ?? 0) > chipDef.max) return false;
      // Tienda
      if (tiendaSel && it.tienda !== tiendaSel) return false;
      // Vendedor
      if (vendedorSel && it.vendedor_nombre !== vendedorSel) return false;
      return true;
    });

    // Sort
    const col = COLUMNAS.find(c => c.key === sortKey);
    const dir = sortDir === 'asc' ? 1 : -1;
    arr = [...arr].sort((a, b) => {
      let va = a[sortKey];
      let vb = b[sortKey];
      if (col?.type === 'num') {
        va = Number(va) || 0; vb = Number(vb) || 0;
        return (va - vb) * dir;
      }
      // text/date: ambos como string
      va = (va || '').toString().toLowerCase();
      vb = (vb || '').toString().toLowerCase();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return arr;
  }, [data, q, chipDias, tiendaSel, vendedorSel, sortKey, sortDir]);

  // Totales del subset filtrado
  const totales = useMemo(() => {
    const t = { count: itemsView.length, monto: 0, lineas: 0, unidades: 0 };
    for (const it of itemsView) {
      t.monto += Number(it.monto) || 0;
      t.lineas += Number(it.lineas) || 0;
      t.unidades += Number(it.unidades) || 0;
    }
    return t;
  }, [itemsView]);

  const algunFiltro = !!(q || chipDias || tiendaSel || vendedorSel);
  const limpiarFiltros = () => { setQ(''); setChipDias(''); setTiendaSel(''); setVendedorSel(''); };

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'monto' || key === 'dias_reserva' || key === 'unidades' ? 'desc' : 'asc');
    }
  };

  // Export CSV del subset filtrado
  const exportarCsv = () => {
    if (!itemsView.length) return;
    const headers = ['Fecha', 'Días', 'Cliente', 'Teléfono', 'Tienda', 'Vendedor', 'Origen vendedor',
                     'Tipo comp', 'Num comp', 'Líneas', 'Unidades', 'Monto'];
    const rows = itemsView.map(it => [
      (it.date_order || '').slice(0, 10),
      it.dias_reserva ?? '',
      it.cliente_nombre || '',
      it.cliente_phone || '',
      it.tienda || '',
      it.vendedor_nombre || '',
      it.vendedor_origen || '',
      it.tipo_comp || '',
      it.num_comp || '',
      it.lineas ?? '',
      Math.round(it.unidades || 0),
      it.monto ?? '',
    ]);
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reservas_pendientes_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`${itemsView.length} reservas exportadas`);
  };

  if (loading) return <div className="flex items-center justify-center h-96"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Clock className="h-6 w-6 text-primary" /> Reservas pendientes
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{totales.count}</span>
            {algunFiltro && <span className="text-muted-foreground"> de {data.total}</span>} reservas
            · Monto: <span className="font-semibold text-foreground">{formatSoles(totales.monto)}</span>
            {algunFiltro && <span className="text-muted-foreground"> (total {formatSoles(data.monto_total)})</span>}
            · <span className="font-semibold text-foreground">{formatNum(totales.unidades)}</span> und ·{' '}
            <span className="font-semibold text-foreground">{formatNum(totales.lineas)}</span> líneas
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => cargar(true)}
            disabled={refreshing}
            className="gap-1"
            title="Recargar"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Recargar
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={exportarCsv}
            disabled={!itemsView.length}
            className="gap-1"
          >
            <Download className="h-3.5 w-3.5" /> CSV ({itemsView.length})
          </Button>
        </div>
      </div>

      {/* Barra de filtros */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Búsqueda libre */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar cliente, vendedor, comprobante…"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="pl-9 pr-9 h-9"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
              title="Limpiar"
            >
              <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Tienda */}
        <Select value={tiendaSel || 'all'} onValueChange={v => setTiendaSel(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-9 w-[150px] text-xs"><SelectValue placeholder="Todas las tiendas" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las tiendas</SelectItem>
            {tiendas.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>

        {/* Vendedor */}
        <Select value={vendedorSel || 'all'} onValueChange={v => setVendedorSel(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-9 w-[180px] text-xs"><SelectValue placeholder="Todos los vendedores" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los vendedores</SelectItem>
            {vendedores.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>

        {algunFiltro && (
          <Button variant="ghost" size="sm" onClick={limpiarFiltros} className="h-9 gap-1 text-muted-foreground hover:text-foreground">
            <XIcon className="h-3.5 w-3.5" /> Limpiar
          </Button>
        )}
      </div>

      {/* Chips de antigüedad */}
      <div className="flex flex-wrap gap-1.5">
        {CHIPS_DIAS.map(c => {
          const active = chipDias === c.value;
          // Conteo del chip (cuántas reservas caen en ese rango, ignorando los OTROS filtros para guiar al usuario)
          let n = data.items?.length || 0;
          if (c.value !== '') {
            n = data.items.filter(it =>
              (c.min == null || (it.dias_reserva ?? 0) >= c.min) &&
              (c.max == null || (it.dias_reserva ?? 0) <= c.max)
            ).length;
          }
          return (
            <button
              key={c.value || 'all'}
              onClick={() => setChipDias(c.value)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-all
                ${active
                  ? c.cls || 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-muted'
                }`}
            >
              {c.value === 'urgente' && <AlertTriangle className="h-3 w-3 inline mr-1" />}
              {c.label}
              <span className={`ml-1.5 text-[10px] ${active ? 'opacity-80' : 'text-muted-foreground'}`}>
                ({n})
              </span>
            </button>
          );
        })}
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[calc(100vh-280px)]">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                <tr>
                  {COLUMNAS.map(col => {
                    const active = sortKey === col.key;
                    const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
                    return (
                      <th
                        key={col.key}
                        className={`py-2 px-3 ${col.width || ''} text-${col.align} cursor-pointer select-none hover:bg-muted/80`}
                        onClick={() => toggleSort(col.key)}
                      >
                        <span className={`inline-flex items-center gap-1 ${active ? 'text-foreground font-semibold' : ''}`}>
                          {col.label}
                          <Icon className={`h-3 w-3 ${active ? 'text-primary' : 'opacity-40'}`} />
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {itemsView.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNAS.length} className="text-center py-12 text-sm text-muted-foreground">
                      {algunFiltro
                        ? 'Ninguna reserva coincide con los filtros activos.'
                        : 'No hay reservas pendientes.'}
                    </td>
                  </tr>
                ) : itemsView.map(it => {
                  const dias = it.dias_reserva ?? 0;
                  const cls =
                    dias > 30 ? 'text-red-600 font-bold' :
                    dias > 7  ? 'text-amber-600 font-semibold' :
                    dias > 3  ? 'text-blue-600' :
                    'text-emerald-600';
                  const comprobante = (it.tipo_comp || it.num_comp)
                    ? [it.tipo_comp, it.num_comp].filter(Boolean).join(' ')
                    : null;
                  return (
                    <tr key={it.order_id} className="border-b hover:bg-muted/20">
                      <td className="py-2 px-3 tabular-nums text-xs">{(it.date_order || '').slice(0, 10)}</td>
                      <td className={`text-right tabular-nums py-2 px-3 ${cls}`}>{dias}d</td>
                      <td className="py-2 px-3">{it.cliente_nombre || <span className="text-muted-foreground/60">(sin cliente)</span>}</td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">{it.tienda || it.location_id}</td>
                      <td className="py-2 px-3 text-xs">
                        {it.vendedor_nombre ? (
                          <span title={it.vendedor_origen === 'cajero' ? 'Cajero (sin vendedor asignado)' : 'Vendedor'}>
                            {it.vendedor_nombre}
                            {it.vendedor_origen === 'cajero' && (
                              <span className="text-[9px] text-muted-foreground ml-1 italic">(caja)</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs tabular-nums">
                        {comprobante
                          ? <span className="font-mono">{comprobante}</span>
                          : <span className="text-muted-foreground/60">—</span>}
                      </td>
                      <td className="text-right tabular-nums py-2 px-3">{it.lineas}</td>
                      <td className="text-right tabular-nums py-2 px-3">{Math.round(it.unidades || 0)}</td>
                      <td className="text-right tabular-nums py-2 px-3 font-medium">{formatSoles(it.monto)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {itemsView.length > 0 && (
                <tfoot className="border-t-2 border-primary/20 bg-muted/50 font-semibold sticky bottom-0">
                  <tr>
                    <td colSpan={6} className="py-2 px-3 text-xs uppercase tracking-wide text-muted-foreground">
                      Total visible ({itemsView.length})
                    </td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(totales.lineas)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(totales.unidades)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatSoles(totales.monto)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
