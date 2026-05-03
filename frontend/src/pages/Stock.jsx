import { useEffect, useState, useCallback } from 'react';
import { api, formatNum } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Loader2, Boxes, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import ExportarStock from '../components/ExportarStock';

export default function Stock() {
  const [grupos, setGrupos] = useState([]);
  const [stockGlobal, setStockGlobal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [filtros, setFiltros] = useState({ marca: '', tipo: '', entalle: '', tela: '', hilo: '' });
  const [cat, setCat] = useState({ marcas: [], tipos: [], entalles: [], telas: [], hilos: [] });

  const [expandido, setExpandido] = useState(null);
  const [detalle, setDetalle] = useState({});
  const [loadingDet, setLoadingDet] = useState({});

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filtros.marca) params.marca_id = filtros.marca;
      if (filtros.tipo) params.tipo_id = filtros.tipo;
      if (filtros.entalle) params.entalle_id = filtros.entalle;
      if (filtros.tela) params.tela_id = filtros.tela;
      if (filtros.hilo) params.hilo_id = filtros.hilo;
      const res = await api.get('/stock/grupos', { params });
      setGrupos(res.data.items || []);
      setStockGlobal(res.data.stock_global || 0);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [filtros]);

  useEffect(() => {
    (async () => {
      try {
        const [m, t, e, tl, h] = await Promise.all([
          api.get('/catalogos/marcas'),
          api.get('/catalogos/tipos'),
          api.get('/catalogos/entalles'),
          api.get('/catalogos/telas'),
          api.get('/catalogos/hilos'),
        ]);
        setCat({ marcas: m.data, tipos: t.data, entalles: e.data, telas: tl.data, hilos: h.data });
      } catch {}
    })();
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const abrir = async (g) => {
    if (expandido === g.key) { setExpandido(null); return; }
    setExpandido(g.key);
    if (!detalle[g.key]) {
      setLoadingDet(p => ({ ...p, [g.key]: true }));
      try {
        const res = await api.get('/stock/grupo-detalle', {
          params: {
            marca_id: g.marca_id,
            tipo_id: g.tipo_id,
            entalle_id: g.entalle_id,
            tela_id: g.tela_id,
            hilo_id: g.hilo_id,
          },
        });
        setDetalle(p => ({ ...p, [g.key]: res.data }));
      } catch (e) { toast.error('Error al cargar detalle'); }
      finally { setLoadingDet(p => ({ ...p, [g.key]: false })); }
    }
  };

  const gruposFiltrados = q.trim()
    ? grupos.filter(g => `${g.marca} ${g.tipo} ${g.entalle} ${g.tela} ${g.hilo}`.toLowerCase().includes(q.toLowerCase().trim()))
    : grupos;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Boxes className="h-6 w-6 text-primary" /> Stock
          </h1>
          <p className="text-sm text-muted-foreground">
            Agrupado por <span className="font-medium">marca · tipo · entalle · tela · hilo</span> ·
            <span className="font-semibold text-foreground ml-1">{grupos.length}</span> combinaciones ·
            Stock global: <span className="font-semibold text-foreground">{formatNum(stockGlobal)}</span> und.
          </p>
        </div>
        <ExportarStock />
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar..." value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
        </div>
        {[
          { k: 'marca', label: 'Marca', list: cat.marcas },
          { k: 'tipo', label: 'Tipo', list: cat.tipos },
          { k: 'entalle', label: 'Entalle', list: cat.entalles },
          { k: 'tela', label: 'Tela', list: cat.telas },
          { k: 'hilo', label: 'Hilo', list: cat.hilos },
        ].map(f => (
          <Select key={f.k} value={filtros[f.k] || 'all'} onValueChange={v => setFiltros(prev => ({ ...prev, [f.k]: v === 'all' ? '' : v }))}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder={f.label} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas {f.label.toLowerCase()}s</SelectItem>
              {f.list.map(x => <SelectItem key={x.id} value={x.id}>{x.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : (
                        <div className="overflow-auto max-h-[calc(100vh-260px)]">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="w-8"></th>
                    <th className="text-left py-2 px-3">Marca</th>
                    <th className="text-left py-2 px-3">Tipo</th>
                    <th className="text-left py-2 px-3">Entalle</th>
                    <th className="text-left py-2 px-3">Tela</th>
                    <th className="text-left py-2 px-3">Hilo</th>
                    <th className="text-right py-2 px-3">Productos</th>
                    <th className="text-right py-2 px-3">Stock</th>
                    <th className="text-right py-2 px-3">Disponible</th>
                    <th className="text-right py-2 px-3">Reservado</th>
                  </tr>
                </thead>
                <tbody>
                  {gruposFiltrados.map(g => {
                    const abierto = expandido === g.key;
                    const det = detalle[g.key];
                    return (
                      <>
                        <tr key={g.key} className="border-b hover:bg-muted/20 cursor-pointer" onClick={() => abrir(g)}>
                          <td className="py-2 px-2 text-muted-foreground">
                            {abierto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="py-2 px-3 font-medium">{g.marca}</td>
                          <td className="py-2 px-3">{g.tipo}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.entalle}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.tela}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.hilo}</td>
                          <td className="text-right tabular-nums py-2 px-3 text-xs">{g.productos}</td>
                          <td className="text-right tabular-nums py-2 px-3 font-medium">{formatNum(g.stock_total)}</td>
                          <td className="text-right tabular-nums py-2 px-3 text-emerald-600">{formatNum(g.stock_disponible)}</td>
                          <td className="text-right tabular-nums py-2 px-3 text-amber-600">{formatNum(g.stock_reservado)}</td>
                        </tr>
                        {abierto && (
                          <tr key={g.key + '-d'}>
                            <td colSpan={10} className="bg-muted/20 p-0">
                              {loadingDet[g.key] ? (
                                <div className="flex items-center justify-center h-24"><Loader2 className="h-5 w-5 animate-spin" /></div>
                              ) : det && det.colores && det.colores.length > 0 ? (
                                <div className="px-4 py-3">
                                  <div className="text-xs text-muted-foreground mb-2">
                                    {det.total_colores} color{det.total_colores !== 1 ? 'es' : ''} · {det.tallas.length} talla{det.tallas.length !== 1 ? 's' : ''}
                                  </div>
                                  <table className="w-full text-xs">
                                    <thead className="text-muted-foreground border-b">
                                      <tr>
                                        <th className="text-left py-1.5 px-2">Color</th>
                                        {det.tallas.map(t => (
                                          <th key={t} className="text-right py-1.5 px-2 w-14">{t}</th>
                                        ))}
                                        <th className="text-right py-1.5 px-2 font-semibold">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {det.colores.map(c => (
                                        <tr key={c.color} className="border-b border-muted/40 hover:bg-background/50">
                                          <td className="py-1.5 px-2 font-medium">{c.color}</td>
                                          {det.tallas.map(t => (
                                            <td key={t} className={`text-right tabular-nums py-1.5 px-2 ${c.tallas[t] ? '' : 'text-muted-foreground/40'}`}>
                                              {c.tallas[t] ? formatNum(c.tallas[t]) : '—'}
                                            </td>
                                          ))}
                                          <td className="text-right tabular-nums py-1.5 px-2 font-semibold">{formatNum(c.total)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <div className="text-center text-xs text-muted-foreground py-3">Sin stock detallado</div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              {gruposFiltrados.length === 0 && <div className="p-6 text-center text-muted-foreground text-sm">Sin grupos</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
