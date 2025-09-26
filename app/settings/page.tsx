"use client";
import { useEffect, useState } from "react";

type Settings = {
  max_courses_per_student: number;

  start_matutino: string;  duration_matutino: number;  allow_breaks_matutino: boolean;  slots_per_day_matutino: number;
  start_vespertino: string; duration_vespertino: number; allow_breaks_vespertino: boolean; slots_per_day_vespertino: number;
  start_sabatino: string;   duration_sabatino: number;   allow_breaks_sabatino: boolean;  slots_per_day_sabatino: number;
  start_dominical: string;  duration_dominical: number;  allow_breaks_dominical: boolean; slots_per_day_dominical: number;
};

type Room = { id: string; code: string; name: string | null; capacity: number };

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings>({
    max_courses_per_student: 5,

    start_matutino: "07:00", duration_matutino: 90, allow_breaks_matutino: true, slots_per_day_matutino: 5,
    start_vespertino: "16:00", duration_vespertino: 90, allow_breaks_vespertino: true, slots_per_day_vespertino: 4,
    start_sabatino: "08:00", duration_sabatino: 90, allow_breaks_sabatino: true, slots_per_day_sabatino: 4,
    start_dominical: "08:00", duration_dominical: 90, allow_breaks_dominical: true, slots_per_day_dominical: 4,
  });

  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomForm, setRoomForm] = useState({ code: "", name: "", capacity: 30 });

  const loadAll = async () => {
    setLoading(true); setError(null);
    try {
      const [sRes, rRes] = await Promise.all([fetch("/api/settings"), fetch("/api/rooms")]);
      const sJson = await sRes.json(); const rJson = await rRes.json();
      if (!sJson.ok) throw new Error(sJson.error || "Error al cargar ajustes");
      if (!rJson.ok) throw new Error(rJson.error || "Error al cargar salones");
      setSettings(sJson.settings); setRooms(rJson.rooms as Room[]);
    } catch (e: any) { setError(e?.message || "Error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadAll(); }, []);

  const saveSettings = async () => {
    setSaving(true); setSavedOk(false); setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Error al guardar ajustes");
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (e: any) { setError(e?.message || "Error"); }
    finally { setSaving(false); }
  };

  const createOrUpdateRoom = async (payload: Partial<Room> & { code: string; capacity: number }) => {
    const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const json = await res.json(); if (!json.ok) throw new Error(json.error || "Error al guardar salón");
  };
  const removeRoom = async (id: string) => {
    if (!confirm("¿Eliminar salón?")) return;
    const res = await fetch(`/api/rooms/${id}`, { method: "DELETE" });
    const json = await res.json(); if (!json.ok) throw new Error(json.error || "Error al eliminar salón");
  };

  const ShiftCard = ({
    title, startKey, durKey, breakKey, slotsKey
  }: {
    title: string; startKey: keyof Settings; durKey: keyof Settings; breakKey: keyof Settings; slotsKey: keyof Settings;
  }) => (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12 }}>
        <div>
          <label>Hora de inicio</label>
          <input type="time" value={(settings as any)[startKey]}
            onChange={(e) => setSettings({ ...settings, [startKey]: e.target.value } as Settings)} />
        </div>
        <div>
          <label>Duración de clase (min)</label>
          <input type="number" min={30} step={15} value={(settings as any)[durKey]}
            onChange={(e) => setSettings({ ...settings, [durKey]: parseInt(e.target.value || "30", 10) } as Settings)} />
        </div>
        <div>
          <label>Clases por día</label>
          <input type="number" min={1} max={12} value={(settings as any)[slotsKey]}
            onChange={(e) => setSettings({ ...settings, [slotsKey]: parseInt(e.target.value || "1", 10) } as Settings)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id={`${title}-breaks`}
            type="checkbox"
            checked={(settings as any)[breakKey]}
            onChange={(e) => setSettings({ ...settings, [breakKey]: e.target.checked } as Settings)}
          />
          <label htmlFor={`${title}-breaks`}>Permitir descansos</label>
        </div>
      </div>
    </div>
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100, lineHeight: 1.4 }}>
      {/* Botón volver */}
      <div style={{ marginBottom: 12 }}>
        <a href="/" style={{ textDecoration: "underline" }}>&larr; Regresar al inicio</a>
      </div>

      <h1>Ajustes · General</h1>
      <p>Define restricciones por turno y administra los salones.</p>

      {error && <p style={{ color: "crimson" }}>⚠️ {error}</p>}
      {savedOk && <p style={{ color: "green" }}>✓ Ajustes guardados</p>}

      {loading ? <p>Cargando…</p> : (
        <>
          {/* RESTRICCIONES */}
          <section style={{ marginTop: 16, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
            <h2 style={{ marginTop: 0 }}>Restricciones</h2>

            <div style={{ marginBottom: 12 }}>
              <label>Máx. materias por alumno</label><br />
              <input
                type="number" min={1}
                value={settings.max_courses_per_student}
                onChange={(e) => setSettings({ ...settings, max_courses_per_student: parseInt(e.target.value || "1", 10) })}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
              <ShiftCard title="Matutino"  startKey="start_matutino"  durKey="duration_matutino"  breakKey="allow_breaks_matutino"  slotsKey="slots_per_day_matutino" />
              <ShiftCard title="Vespertino" startKey="start_vespertino" durKey="duration_vespertino" breakKey="allow_breaks_vespertino" slotsKey="slots_per_day_vespertino" />
              <ShiftCard title="Sabatino"   startKey="start_sabatino"   durKey="duration_sabatino"   breakKey="allow_breaks_sabatino"  slotsKey="slots_per_day_sabatino" />
              <ShiftCard title="Dominical"  startKey="start_dominical"  durKey="duration_dominical"  breakKey="allow_breaks_dominical" slotsKey="slots_per_day_dominical" />
            </div>

            {/* Lista de restricciones no editables (legibilidad) */}
            <div style={{ marginTop: 16, background: "#f9fafc", padding: 12, borderRadius: 8 }}>
              <h4 style={{ margin: "0 0 8px 0" }}>Restricciones del sistema (no editables)</h4>
              <ul style={{ margin: 0 }}>
                <li>Clases se asignan en horarios seguidos (slots consecutivos desde la hora de inicio).</li>
                <li>Ningún alumno puede tener dos clases a la misma hora.</li>
                <li>Ningún aula puede tener dos clases a la misma hora.</li>
                <li>Ningún alumno puede tener clases repetidas.</li>
                <li>Ningún alumno puede tener mas clases asignadas que disponibles.</li>
              </ul>
            </div>

            <div style={{ marginTop: 12 }}>
              <button onClick={saveSettings} disabled={saving}>
                {saving ? "Guardando…" : "Guardar ajustes"}
              </button>
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
