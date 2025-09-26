"use client";
import { useEffect, useState } from "react";

type Room = { id: string; code: string; name: string | null; capacity: number };

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<{ code: string; name: string; capacity: number }>({
    code: "",
    name: "",
    capacity: 30,
  });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Error");
      setRooms(json.rooms as Room[]);
    } catch (e: any) {
      setError(e?.message || "Error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createOrUpdate = async (payload: Partial<Room> & { code: string; capacity: number }) => {
    setError(null);
    const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error");
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar salón?")) return;
    const res = await fetch(`/api/rooms/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error");
    await load();
  };

  return (
    <main style={{ padding: 24, maxWidth: 900, lineHeight: 1.4 }}>
      <h1>Salones</h1>
      <p>Administra el catálogo de salones. <em>Grupos y horarios se generan automáticamente en la vista de Asignación.</em></p>

      <h3 style={{ marginTop: 16 }}>Agregar/Actualizar</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
        <div>
          <label>Código</label><br />
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="A-101" />
        </div>
        <div>
          <label>Nombre</label><br />
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Edificio A 101" />
        </div>
        <div>
          <label>Capacidad</label><br />
          <input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: parseInt(e.target.value || "1", 10) })} />
        </div>
        <button
          onClick={async () => {
            if (!form.code || !form.capacity) { setError("Falta código/capacidad"); return; }
            try {
              await createOrUpdate({ code: form.code.trim(), name: form.name?.trim() || null, capacity: Math.max(1, form.capacity) });
              setForm({ code: "", name: "", capacity: 30 });
            } catch (e: any) { setError(e?.message || "Error"); }
          }}
        >
          Guardar
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>⚠️ {error}</p>}

      <h3 style={{ marginTop: 24 }}>Salones existentes</h3>
      {loading ? <p>Cargando...</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                  <button onClick={() => setForm({ code: r.code, name: r.name || "", capacity: r.capacity })}>Editar</button>
                  <button style={{ marginLeft: 8 }} onClick={() => remove(r.id)}>Eliminar</button>
                </td>
              </tr>
            ))}
            {rooms.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 6 }}>No hay salones aún.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
