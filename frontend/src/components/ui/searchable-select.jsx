import { useState, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Button } from './button';
import { Input } from './input';
import { ChevronDown, X, Search, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Single-select con buscador (combobox).
 *
 * Props:
 *  - options: [{value, label}]
 *  - value: string (valor seleccionado, '' = ninguno)
 *  - onChange: (newValue) => void
 *  - placeholder: texto cuando no hay nada seleccionado
 *  - emptyText: texto cuando no hay opciones
 *  - className: clases extra para el botón
 *  - autoSearchAt: muestra el buscador solo si options.length >= N (default 6)
 */
export function SearchableSelect({
  options = [],
  value = '',
  onChange,
  placeholder = 'Seleccionar...',
  emptyText = 'Sin opciones',
  className,
  autoSearchAt = 6,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    return options.filter(o => String(o.label).toLowerCase().includes(t));
  }, [options, q]);

  const selectedLabel = useMemo(() => {
    if (!value) return null;
    const f = options.find(o => o.value === value);
    return f ? f.label : value;
  }, [value, options]);

  const select = (v) => {
    onChange(v === value ? '' : v);
    setOpen(false);
    setQ('');
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={cn(
            'h-7 justify-between gap-1 px-2 text-xs font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selectedLabel || placeholder}</span>
          <span className="flex items-center shrink-0">
            {value && (
              <X className="h-3 w-3 opacity-60 hover:opacity-100 mr-0.5" onClick={clear} />
            )}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        {options.length >= autoSearchAt && (
          <div className="relative border-b">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar..."
              className="h-8 border-0 pl-8 focus-visible:ring-0 rounded-none text-xs"
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map(o => {
              const isSel = o.value === value;
              return (
                <div
                  key={o.value}
                  onClick={() => select(o.value)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer hover:bg-accent',
                    isSel && 'bg-accent/50 font-semibold',
                  )}
                >
                  <Check className={cn('h-3 w-3', isSel ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{o.label}</span>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
