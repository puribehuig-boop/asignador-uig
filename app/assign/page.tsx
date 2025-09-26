"use client";
import { useState, useEffect } from "react";

export default function AssignPage() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/settings");
      const json = await res.json();
      if (json?.ok) setSettings(json.settings);
    })();
  }, []);

  const preview = async () => {
    setLoading(true); setError(null); setData(null);
    try {
      const res = await fetch("/api/assign/preview", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || "Error");
      setData(json);
    } catch (e: any) { setError(e?.message || "Error desconocido"); }
    finally { setLoading(false); }
  };

  return (
    <main style={{ padding: 24, lineHeight: 1.4, maxWidth: 1100 }}>
      <h1>Asignación · Vista previa</h1>
      <p>Usa <a href="/settings" style={{ textDecoration: "underline" }}>Ajustes (General)</a> para cambiar restricciones y salones.</p>

      {settings && (
        <div style={{ marginTop: 12, padding: 12, background: "#f7f9ff", borderRadius: 12 }}>
          <strong>Ajustes vigentes</strong>
          <ul style={{ margin: 0 }}>
            <li>Máx. materias por alumno: {settings.max_courses_per_student}</li>
            <li>Tamaño de grupo: {settings.target_group_size}</li>
            <li>Duración clase: {settings.slot_length_minutes} min</li>
            <li>Inicio Matutino: {settings.start_matutino} · Vespertino: {settings.start_vespertino} · Sabatino: {settings.start_sabatino} · Dominical: {settings.start_dominical}</li>
          </ul>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={preview} disabled={loading}>{loading ? "Calculando..." : "Generar vista previa"}</button>
      </div>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>⚠️ {error}</p>}

      {data?.ok && (
        <>
          <div style={{ marginTop: 16, background: "#eefbf0", padding: 12 }}>
            <h3>Resumen</h3>
            <ul>
              <li>Alumnos (con elegibilidades): {data.summary.students_total}</li>
              <li>Cursos con demanda: {data.summary.courses_with_demand}</li>
              <li>Grupos programados: {data.summary.scheduled_groups}</li>
              <li>Asignaciones propuestas: {data.summary.proposed_assignments}</li>
            </ul>
          </div>

          <h3 style={{ marginTop: 24 }}>Grupos y horarios generados</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Curso</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Turno</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Grupo</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Salón</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Día</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Inicio</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Fin</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Cap</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Usados</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {data.scheduled_groups.map((g: any, i: number) => (
                <tr key={i}>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.course_code}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0", textTransform: "capitalize" }}>{g.turno}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>G{g.group_index}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.room}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{["","Lun","Mar","Mié","Jue","Vie","Sáb","Dom"][g.day_of_week]}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.start_time.slice(0,5)}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.end_time.slice(0,5)}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.capacity}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.used}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{(g.fill_rate*100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 24 }}>No asignados por curso</h3>
          <ul>
            {data.unassigned_by_course?.map((u: any) => (
              <li key={u.course_id}>{u.course_code}: {u.count}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
