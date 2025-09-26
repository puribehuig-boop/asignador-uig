"use client";
import { useEffect, useState } from "react";

type Settings = {
  max_courses_per_student: number;
  target_group_size: number;
  slot_length_minutes: number;
  day_start: string;
  day_end: string;
  days_active: number[];
};

type Room = { id: string; code: string; name: string | null; capacity: number };

const dayLabel = (d: number) => ["","Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][d] || `${d}`;

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings>({
    max_courses_per_student: 5,
    target_group_size: 30,
    slot_length_minutes: 90,
    day_start: "07:00",
    day_end: "21:00",
    days_active: [1,2,3,4,5],
  });

  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomForm, setRoomForm] = useState<{ code: string; name: string; capacity: number }>({
    code: "", name: "", capacity: 30
  });

  const loadAll = async () => {
    setLoading(true); setError(null);
    try {
      const [sRes, rRes] = await Promise.all([fetch("/api/settings"), fetch("/api/rooms")]);
      const sJson = await sRes.json();
      const rJson = await rRes.json();
      if (!sJson.ok) throw new Error(sJson.error || "Error al cargar ajustes");
      if (!rJson.ok) throw new Error(rJson.error || "Error al cargar salones");
      setSettings(sJson.settings);
      setRooms(rJson.rooms as Room[]);
    } catch (e: any) {
      setError(e?.message || "Error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const toggleDay = (d: number) => {
    setSettings((prev) => {
      const days = prev.days_active.includes(d)
        ? prev.days_active.filter(x => x !== d)
        : [...prev.days_active, d].sort((a,b) => a-b);
      return { ...prev, days_active: days };
    });
  };

  const saveSettings = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Error al guardar ajustes");
    } catch (e: any) {
      setError(e?.message || "Error");
    } finally {
      setSaving(false);
    }
  };

  const createOrUpdateRoom = async (payload: Partial<Room> & { code: string; capacity: number }) => {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error al guardar salón");
  };

  const removeRoom = async (id: string) => {
    if (!confirm("¿Eliminar salón?")) return;
    const res = await fetch(`/api/rooms/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error al eliminar salón");
  };

  return (
    <main style={{ padding: 24, maxWidth: 1100, lineHeight: 1.4 }}>
      <h1>Ajustes · General</h1>
      <p>Define aquí las <strong>restricciones globales</strong> y administra los <strong>salones</strong>.</p>

      {error && <p style={{ color: "crimson" }}>⚠️ {error}</p>}
      {loading ? <p>Cargando…</p> : (
        <>
          {/* RESTRICCIONES */}
          <section style={{ marginTop: 16, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
            <h2 style={{ marginTop: 0 }}>Restricciones</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 12 }}>
              <div>
                <label>Máx. materias por alumno</label>
                <input type="number" min={1}
                  value={settings.max_courses_per_student}
                  onChange={(e) => setSettings({ ...settings, max_courses_per_student: parseInt(e.target.value || "1", 10) })} />
              </div>
              <div>
                <label>Tamaño objetivo de grupo</label>
                <input type="number" min={5}
                  value={settings.target_group_size}
                  onChange={(e) => setSettings({ ...settings, target_group_size: parseInt(e.target.value || "5", 10) })} />
              </div>
              <div>
                <label>Duración de clase (min)</label>
                <input type="number" min={30} step={15}
                  value={settings.slot_length_minutes}
                  onChange={(e) => setSettings({ ...settings, slot_length_minutes: parseInt(e.target.value || "30", 10) })} />
              </div>
              <div>
                <label>Inicio del día</label>
                <input type="time"
                  value={settings.day_start}
                  onChange={(e) => setSettings({ ...settings, day_start: e.target.value })} />
              </div>
              <div>
                <label>Fin del día</label>
                <input type="time"
                  value={settings.day_end}
                  onChange={(e) => setSettings({ ...settings, day_end: e.target.value })} />
              </div>
              <div>
                <label>Días activos</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[1,2,3,4,5,6].map((d) => (
                    <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input type="checkbox" checked={settings.days_active.includes(d)} onChange={() => toggleDay(d)} />
                      {dayLabel(d)}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button onClick={saveSettings} disabled={saving}>{saving ? "Guardando…" : "Guardar ajustes"}</button>
            </div>
          </section>

          {/* SALONES */}
          <section style={{ marginTop: 16, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
            <h2 style={{ marginTop: 0 }}>Salones</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
              <div>
                <label>Código</label><br />
                <input value={roomForm.code} onChange={(e) => setRoomForm({ ...roomForm, code: e.target.value })} placeholder="A-101" />
              </div>
              <div>
                <label>Nombre</label><br />
                <input value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} placeholder="Edificio A 101" />
              </div>
              <div>
                <label>Capacidad</label><br />
                <input type="number" min={1} value={roomForm.capacity}
                  onChange={(e) => setRoomForm({ ...roomForm, capacity: parseInt(e.target.value || "1", 10) })} />
              </div>
              <button
                onClick={async () => {
                  try {
                    if (!roomForm.code || !roomForm.capacity) throw new Error("Falta código/capacidad");
                    await createOrUpdateRoom({ code: roomForm.code.trim(), name: roomForm.name?.trim() || null, capacity: Math.max(1, roomForm.capacity) });
                    setRoomForm({ code: "", name: "", capacity: 30 });
                    await loadAll();
                  } catch (e: any) { alert(e?.message || "Error"); }
                }}
              >
                Guardar salón
              </button>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Código</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Nombre</th>
                  <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Capacidad</th>
                  <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.id}>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{r.code}</td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{r.name}</td>
                    <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{r.capacity}</td>
                    <td style={{ padding: 6, textAlign: "center", borderBottom: "1px solid #f0f0f0" }}>
                      <button onClick={() => setRoomForm({ code: r.code, name: r.name || "", capacity: r.capacity })}>Editar</button>
                      <button style={{ marginLeft: 8 }} onClick={async () => { await removeRoom(r.id); await loadAll(); }}>Eliminar</button>
                    </td>
                  </tr>
                ))}
                {rooms.length === 0 && <tr><td colSpan={4} style={{ padding: 6 }}>No hay salones aún.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
