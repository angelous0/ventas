import { useState, useEffect, useRef, useCallback } from 'react';
import { useFilters } from '../context/FilterContext';
import { api } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Send, Plus, Bot, User, Loader2, Settings, Check, X, Key } from 'lucide-react';

export default function Asistente() {
  const { getFilterParams, hasFilters, filters } = useFilters();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState({ has_key: false, masked: null });
  const [savingKey, setSavingKey] = useState(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const startNewChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setInput('');
    inputRef.current?.focus();
  }, []);

  // Load API key status on mount
  useEffect(() => {
    api.getApiKeyStatus().then(setApiKeyStatus).catch(() => {});
  }, []);

  const handleSaveKey = async () => {
    setSavingKey(true);
    try {
      await api.saveApiKey(apiKeyInput);
      const status = await api.getApiKeyStatus();
      setApiKeyStatus(status);
      setApiKeyInput('');
      setShowSettings(false);
    } catch {
      // ignore
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveKey = async () => {
    setSavingKey(true);
    try {
      await api.saveApiKey('');
      setApiKeyStatus({ has_key: false, masked: null });
      setApiKeyInput('');
    } catch {
      // ignore
    } finally {
      setSavingKey(false);
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const fp = getFilterParams();
      const res = await api.sendChatMessage({
        message: text,
        session_id: sessionId,
        filters: fp,
      });
      setSessionId(res.session_id);
      setMessages(prev => [...prev, { role: 'assistant', content: res.response }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Lo siento, hubo un error al procesar tu consulta. Intenta de nuevo.',
        error: true,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const filterLabels = [];
  if (filters.marcas.length) filterLabels.push(`Marca: ${filters.marcas.join(', ')}`);
  if (filters.tipos.length) filterLabels.push(`Tipo: ${filters.tipos.join(', ')}`);
  if (filters.stores.length) filterLabels.push(`Tienda: ${filters.stores.join(', ')}`);

  const suggestions = [
    '¿Cómo van las ventas este año comparado con el anterior?',
    '¿Cuál es la tienda con mejor rendimiento?',
    '¿Qué marca vende más unidades?',
    '¿Cuál fue el mejor mes de ventas?',
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-65px)]" data-testid="asistente-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Asistente IA</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Consulta tus datos de ventas en lenguaje natural
            {hasFilters && (
              <span className="ml-2 text-xs bg-muted px-2 py-0.5 rounded-sm">
                Filtros: {filterLabels.join(' | ')}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm text-xs h-8"
            onClick={() => setShowSettings(!showSettings)}
            data-testid="settings-btn"
          >
            <Settings size={14} className="mr-1.5" />
            {apiKeyStatus.has_key ? 'API Key configurada' : 'Configurar API Key'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm text-xs h-8"
            onClick={startNewChat}
            data-testid="new-chat-btn"
          >
            <Plus size={14} className="mr-1.5" /> Nueva conversacion
          </Button>
        </div>
      </div>

      {/* API Key Settings Panel */}
      {showSettings && (
        <Card className="rounded-sm mb-4 shrink-0" data-testid="api-key-panel">
          <CardContent className="py-4 px-5">
            <div className="flex items-start gap-3">
              <Key size={16} className="text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-medium">OpenAI API Key</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Pega tu API key de OpenAI para usar tu propia cuenta. Obtenla en{' '}
                    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                      platform.openai.com/api-keys
                    </a>
                  </p>
                </div>
                {apiKeyStatus.has_key ? (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 bg-muted rounded-sm px-3 py-2 text-xs font-mono flex-1">
                      <Check size={14} className="text-emerald-500 shrink-0" />
                      <span>{apiKeyStatus.masked}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-sm text-xs h-8 text-destructive hover:text-destructive"
                      onClick={handleRemoveKey}
                      disabled={savingKey}
                      data-testid="remove-key-btn"
                    >
                      <X size={14} className="mr-1" /> Quitar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="sk-..."
                      className="flex-1 bg-muted rounded-sm px-3 py-2 text-xs font-mono border-0 outline-none focus:ring-1 focus:ring-foreground/20 placeholder:text-muted-foreground/40"
                      data-testid="api-key-input"
                    />
                    <Button
                      size="sm"
                      className="rounded-sm text-xs h-8"
                      onClick={handleSaveKey}
                      disabled={!apiKeyInput.trim() || savingKey}
                      data-testid="save-key-btn"
                    >
                      {savingKey ? <Loader2 size={14} className="animate-spin" /> : 'Guardar'}
                    </Button>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/60">
                  {apiKeyStatus.has_key
                    ? 'Usando tu API key personal. Los costos se cobran en tu cuenta de OpenAI.'
                    : 'Sin key configurada — se usa la key por defecto de Emergent.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Messages area */}
      <Card className="flex-1 rounded-sm overflow-hidden flex flex-col min-h-0" data-testid="chat-card">
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-4" data-testid="chat-messages">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Bot size={24} className="text-muted-foreground" />
              </div>
              <h3 className="text-base font-semibold mb-1">Analista de Ventas IA</h3>
              <p className="text-sm text-muted-foreground max-w-md mb-6">
                Preguntame sobre ventas, tiendas, marcas, tendencias o cualquier dato de tu negocio.
                {hasFilters ? ' Los filtros activos se aplicaran automaticamente.' : ''}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg" data-testid="suggestions">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    className="text-left text-xs p-3 rounded-sm border border-border hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
                    data-testid={`suggestion-${i}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              data-testid={`msg-${msg.role}-${i}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-foreground/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot size={14} className="text-foreground" />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-foreground text-background'
                    : msg.error
                      ? 'bg-destructive/10 text-destructive border border-destructive/20'
                      : 'bg-muted text-foreground'
                }`}
              >
                {msg.content}
              </div>
              {msg.role === 'user' && (
                <div className="w-7 h-7 rounded-full bg-foreground flex items-center justify-center shrink-0 mt-0.5">
                  <User size={14} className="text-background" />
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex gap-3 justify-start" data-testid="loading-indicator">
              <div className="w-7 h-7 rounded-full bg-foreground/10 flex items-center justify-center shrink-0">
                <Bot size={14} className="text-foreground" />
              </div>
              <div className="bg-muted rounded-sm px-4 py-3 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Analizando datos...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </CardContent>

        {/* Input area */}
        <div className="border-t border-border p-3 shrink-0" data-testid="chat-input-area">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe tu consulta sobre ventas..."
              rows={1}
              className="flex-1 resize-none bg-muted rounded-sm px-3 py-2.5 text-sm border-0 outline-none focus:ring-1 focus:ring-foreground/20 placeholder:text-muted-foreground/50 min-h-[40px] max-h-[120px]"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={(e) => {
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              data-testid="chat-input"
            />
            <Button
              size="sm"
              className="rounded-sm h-10 w-10 shrink-0 p-0"
              onClick={sendMessage}
              disabled={!input.trim() || loading}
              data-testid="send-btn"
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
