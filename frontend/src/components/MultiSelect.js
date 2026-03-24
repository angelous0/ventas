import { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function MultiSelect({ options, selected, onChange, placeholder, testId }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const toggle = (val) => {
    if (selected.includes(val)) {
      onChange(selected.filter(v => v !== val));
    } else {
      onChange([...selected, val]);
    }
  };

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options;

  const label = selected.length === 0
    ? placeholder
    : selected.length <= 2
      ? selected.join(', ')
      : `${selected.length} selec.`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-8 text-xs rounded-sm justify-between min-w-[140px] max-w-[200px] font-normal"
          data-testid={testId}
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="ml-1 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0 rounded-sm" align="start">
        <div className="p-2 border-b border-border">
          <input
            type="text"
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-7 px-2 text-xs bg-transparent border border-border rounded-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid={`${testId}-search`}
          />
        </div>
        {selected.length > 0 && (
          <div className="px-2 py-1.5 border-b border-border">
            <button
              onClick={() => { onChange([]); setSearch(''); }}
              className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              data-testid={`${testId}-clear`}
            >
              <X size={10} /> Limpiar seleccion
            </button>
          </div>
        )}
        <div className="max-h-60 overflow-auto p-1">
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground p-2 text-center">No encontrado</p>
          )}
          {filtered.map(opt => (
            <button
              key={opt}
              onClick={() => toggle(opt)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-muted cursor-pointer text-left"
              data-testid={`${testId}-option-${opt}`}
            >
              <div className={`w-3.5 h-3.5 border rounded-sm flex items-center justify-center shrink-0 ${
                selected.includes(opt) ? 'bg-foreground border-foreground' : 'border-border'
              }`}>
                {selected.includes(opt) && <Check size={10} className="text-background" />}
              </div>
              <span className="truncate">{opt}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
