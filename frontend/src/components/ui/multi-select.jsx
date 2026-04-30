import { useState, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Checkbox } from './checkbox';
import { Button } from './button';
import { Input } from './input';
import { Badge } from './badge';
import { ChevronDown, X, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * MultiSelect con búsqueda y checkboxes.
 *
 * Props:
 *  - options: [{value, label}]
 *  - value:   array de values seleccionados
 *  - onChange: (newValues) => void
 *  - placeholder: texto cuando no hay nada seleccionado
 *  - emptyText:   texto cuando no hay opciones
 *  - className:   clases extra para el botón
 *  - showSearch:  default true; oculta el buscador si las opciones son pocas
 */
export function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = 'Seleccionar…',
  emptyText = 'Sin opciones',
  className,
  showSearch = true,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    return options.filter(o => String(o.label).toLowerCase().includes(t));
  }, [options, q]);

  const toggle = (v) => {
    const set = new Set(value);
    if (set.has(v)) set.delete(v); else set.add(v);
    onChange(Array.from(set));
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  const selectAll = () => onChange(filtered.map(o => o.value));

  const label = (() => {
    if (!value.length) return placeholder;
    if (value.length === 1) {
      const found = options.find(o => o.value === value[0]);
      return found ? found.label : value[0];
    }
    return `${value.length} seleccionados`;
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={cn(
            'h-9 justify-between gap-2 px-3 text-sm font-normal min-w-[200px]',
            !value.length && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <span className="flex items-center gap-1 shrink-0">
            {value.length > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold">
                {value.length}
              </Badge>
            )}
            {value.length > 0 && (
              <X className="h-3.5 w-3.5 opacity-60 hover:opacity-100" onClick={clear} />
            )}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        {showSearch && options.length > 6 && (
          <div className="relative border-b">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar…"
              className="h-9 border-0 pl-8 focus-visible:ring-0 rounded-none"
            />
          </div>
        )}
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map(o => {
              const selected = value.includes(o.value);
              return (
                <div
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent',
                    selected && 'bg-accent/50',
                  )}
                >
                  <Checkbox checked={selected} onCheckedChange={() => toggle(o.value)} onClick={(e) => e.stopPropagation()} />
                  <span className="flex-1 truncate">{o.label}</span>
                </div>
              );
            })
          )}
        </div>
        {filtered.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t p-2 text-xs">
            <button onClick={selectAll} className="text-muted-foreground hover:text-foreground underline">
              Seleccionar todo ({filtered.length})
            </button>
            {value.length > 0 && (
              <button onClick={() => onChange([])} className="text-muted-foreground hover:text-foreground underline">
                Limpiar
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
