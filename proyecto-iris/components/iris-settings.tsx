'use client'

import { useEffect, useMemo, useState } from 'react'
import { listKnowledgeItems, listMeetingData, listVentanaCelesteContent, saveKnowledgeItem, deleteKnowledgeItem, testVentanaCelesteConnection } from '@/app/actions/iris'
import { Button } from '@/components/ui/button'
import { IrisAnalyticsDashboard } from '@/components/iris-analytics-dashboard'

type Meeting = { id: string; title: string; status: string; startedAt: string }
type KnowledgeItem = { id: string; title: string; content: string; source?: unknown; sourceDate?: string | Date; validity?: string }
type ExternalItem = { id?: string; title: string; content: string; type?: string }
type Props = { user: { name: string; email: string }; meetings: Meeting[]; activeMeetingId: string | null; intensity: 'low' | 'medium' | 'high'; muted: boolean; onIntensityChange: (value: 'low' | 'medium' | 'high') => void; onMutedChange: (value: boolean) => void; onLogout: () => void; onOpenMeeting: (id: string) => void }

export function IrisSettings({ user, meetings, activeMeetingId, intensity, muted, onIntensityChange, onMutedChange, onLogout, onOpenMeeting }: Props) {
  const [section, setSection] = useState<'configuration' | 'analytics' | 'knowledge'>('configuration')
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([])
  const [external, setExternal] = useState<ExternalItem[]>([])
  const [externalStatus, setExternalStatus] = useState('not_configured')
  const [externalError, setExternalError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'ventana' | 'iris' | 'meetings'>('all')
  const [selected, setSelected] = useState<{ id?: string; title: string; content: string; meta?: string; validity?: string } | null>(null)
  const [draft, setDraft] = useState({ id: '', title: '', content: '' })
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function loadKnowledge() {
    setLoading(true)
    setLoadError(null)
    try {
      const [internal, ventana] = await Promise.all([listKnowledgeItems(), listVentanaCelesteContent()])
      setKnowledge(internal as KnowledgeItem[]); setExternal(ventana.items as ExternalItem[])
      setExternalStatus(ventana.status); setExternalError(ventana.error)
      if (ventana.error) setLoadError(ventana.error)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'No se pudieron cargar los datos.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void loadKnowledge() }, [])

  const meetingResults = useMemo(() => meetings.filter((meeting) => meeting.status === 'ended').map((meeting) => ({ id: meeting.id, title: meeting.title, content: `Reunión finalizada el ${new Date(meeting.startedAt).toLocaleDateString('es-CL')}`, meta: 'Reunión anterior' })), [meetings])
  const availableKnowledgeCount = knowledge.length + external.length + meetingResults.length
  const availableKnowledgeLabel = availableKnowledgeCount === 1 ? 'elemento' : 'elementos'
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    const rows = [
      ...(source === 'all' || source === 'ventana' ? external.map((item, index) => ({ id: item.id || `ventana-${index}-${item.title}`, title: item.title, content: item.content, meta: 'Ventana Celeste' })) : []),
      ...(source === 'all' || source === 'iris' ? knowledge.map((item) => ({ id: item.id, title: item.title, content: item.content, meta: 'Iris Knowledge', validity: item.validity })) : []),
      ...(source === 'all' || source === 'meetings' ? meetingResults : []),
    ]
    return term ? rows.filter((row) => `${row.title} ${row.content}`.toLocaleLowerCase().includes(term)) : rows
  }, [external, knowledge, meetingResults, query, source])

  async function refreshExternal() { setLoading(true); try { await loadKnowledge() } finally { setLoading(false) } }
  async function saveInternal() { if (!draft.title.trim() || !draft.content.trim()) return; const current = knowledge.find((item) => item.id === draft.id); await saveKnowledgeItem({ id: draft.id || crypto.randomUUID(), title: draft.title.trim(), content: draft.content.trim(), source: current?.source || { type: 'iris_manual' }, sourceDate: current?.sourceDate || new Date(), validity: current?.validity || 'current', permissions: { visibility: 'private' }, isDemo: false }); setDraft({ id: '', title: '', content: '' }); setAddFormOpen(false); await loadKnowledge() }
  function beginEdit(item: KnowledgeItem) { setDraft({ id: item.id, title: item.title, content: item.content }); setSelected({ id: item.id, title: item.title, content: item.content, meta: 'Iris Knowledge', validity: item.validity }); setAddFormOpen(true) }
  async function removeInternal(id: string) { if (!id || id.length > 512 || !window.confirm('¿Eliminar este conocimiento? Esta acción no se puede deshacer.')) return; await deleteKnowledgeItem(id); if (selected?.title) setSelected(null); await loadKnowledge() }

  return <section className="settings-view workspace-tool iris-settings" aria-labelledby="settings-title">
    <header className="settings-header"><div><span className="eyebrow accent">PREFERENCIAS</span><h1 id="settings-title">Settings</h1><p>Configura cómo Iris acompaña tus reuniones.</p></div></header>
    <nav className="settings-nav" aria-label="Secciones de Settings"><button className={section === 'configuration' ? 'active' : ''} onClick={() => setSection('configuration')}>Configuración</button><button className={section === 'analytics' ? 'active' : ''} onClick={() => setSection('analytics')}>Análisis</button><button className={section === 'knowledge' ? 'active' : ''} onClick={() => setSection('knowledge')}>Conocimiento</button></nav>
    {section === 'configuration' ? <div className="settings-layout">
      <section className="settings-card"><span className="eyebrow">INTERVENCIONES</span><h2>Cómo participa Iris</h2><div className="settings-control"><label htmlFor="iris-intensity">Intensidad</label><select id="iris-intensity" value={intensity} onChange={(event) => onIntensityChange(event.target.value as Props['intensity'])}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select></div><label className="settings-switch"><input type="checkbox" checked={muted} onChange={(event) => onMutedChange(event.target.checked)} /><span>Silenciar voz</span></label></section>
      <section className="settings-card"><span className="eyebrow">VENTANA CELESTE</span><h2>Fuente externa</h2><p className="settings-status"><strong>{loading ? 'Cargando…' : externalStatus === 'connected' ? 'Conectado' : externalStatus === 'error' ? 'Error de conexión' : 'No configurado'}</strong><span>{external.length} elementos disponibles</span></p><p className="settings-muted" role={loadError ? 'alert' : undefined}>{loadError || externalError || (external.length ? 'Contenido sincronizado desde la fuente externa.' : 'No hay elementos disponibles. Comprueba la conexión o actualiza la fuente.')}</p><Button type="button" variant="outline" onClick={refreshExternal} disabled={loading}>{loading ? 'Actualizando…' : 'Actualizar ahora'}</Button></section>
      <section className="settings-card"><span className="eyebrow">CUENTA</span><h2>{user.name || 'Cuenta'}</h2><p className="settings-muted">{user.email}</p><Button type="button" variant="outline" onClick={onLogout}>Cerrar sesión</Button></section>
    </div> : section === 'analytics' ? <IrisAnalyticsDashboard meetingId={activeMeetingId} intensity={intensity} muted={muted} onIntensityChange={onIntensityChange} onMutedChange={onMutedChange} /> : <div className="knowledge-explorer"><header className="knowledge-header"><div><span className="eyebrow">FUENTES DISPONIBLES PARA IRIS</span><h2>Base de conocimiento</h2><p>{availableKnowledgeCount} {availableKnowledgeLabel} entre conocimiento guardado, Ventana Celeste y reuniones anteriores.</p></div><Button type="button" variant="outline" onClick={() => { setDraft({ id: '', title: '', content: '' }); setAddFormOpen((open) => !open) }}>{addFormOpen ? 'Cerrar formulario' : 'Añadir conocimiento'}</Button></header><div className="knowledge-source-summary" aria-label="Elementos por fuente"><span>Iris Knowledge <strong>{knowledge.length}</strong></span><span>Ventana Celeste <strong>{external.length}</strong></span><span>Reuniones anteriores <strong>{meetingResults.length}</strong></span></div><div className="knowledge-toolbar"><input aria-label="Buscar conocimiento" placeholder="Buscar información" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="Filtrar fuente" value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">Todas las fuentes</option><option value="ventana">Ventana Celeste</option><option value="iris">Iris Knowledge</option><option value="meetings">Reuniones anteriores</option></select></div><div className="knowledge-columns"><div className="knowledge-results">{results.map((item) => <button className="knowledge-result" key={item.id} onClick={() => setSelected(item)}><strong>{item.title}</strong><span>{item.meta}{'validity' in item && item.validity ? ` · ${item.validity === 'current' ? 'ACTIVA' : item.validity === 'superseded' ? 'REEMPLAZADA' : 'SIN VALIDAR'}` : ''}</span><p>{item.content.slice(0, 150)}</p></button>)}{!results.length && <p className="empty-hint">No hay información disponible para este filtro.</p>}</div><aside className="knowledge-detail">{selected ? <><span className="eyebrow">{selected.meta}{selected.validity ? ` · ${selected.validity === 'current' ? 'ACTIVA' : selected.validity === 'superseded' ? 'REEMPLAZADA' : 'SIN VALIDAR'}` : ''}</span><h2>{selected.title}</h2><p>{selected.content}</p>{selected.meta === 'Iris Knowledge' && <div className="knowledge-actions"><button className="text-button" type="button" aria-label="Más acciones" onClick={() => setMenuOpen((open) => !open)}>•••</button>{menuOpen && <div className="knowledge-menu"><button type="button" onClick={() => { const item = knowledge.find((candidate) => candidate.id === selected.id); if (item) beginEdit(item); setMenuOpen(false) }}>Editar</button><button type="button" onClick={() => { setMenuOpen(false); void removeInternal(selected.id || '') }}>Eliminar</button></div>}</div>}</> : <p className="empty-hint">Selecciona un elemento para revisar su contenido completo.</p>}</aside></div>{addFormOpen && <form className="knowledge-editor" onSubmit={(event) => { event.preventDefault(); void saveInternal() }}><span className="eyebrow">IRIS KNOWLEDGE</span><input aria-label="Título del conocimiento" placeholder="Título" required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><textarea aria-label="Contenido del conocimiento" placeholder="Contenido" required maxLength={20000} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /><div className="knowledge-editor-actions"><Button type="submit" disabled={!draft.title.trim() || !draft.content.trim()}>{draft.id ? 'Guardar cambios' : 'Guardar conocimiento'}</Button><Button type="button" variant="ghost" onClick={() => { setAddFormOpen(false); setDraft({ id: '', title: '', content: '' }) }}>Cancelar</Button></div></form>}</div>}
  </section>
}
