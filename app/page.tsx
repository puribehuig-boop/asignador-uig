"use client";
import { useEffect, useState } from "react";

export default function Home() {
  const [last, setLast] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/uploads/last", { cache: "no-store" }); // 👈 importante
        const json = await res.json();
        if (json?.ok) setLast(json.last);
      } catch {}
    })();
  }, []);

  return (
    <main style={{ padding: 24, lineHeight: 1.4 }}>
      <h1>Asignador UIG</h1>
      <p style={{ color: "#555" }}>Flujo recomendado</p>

      <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: 12, maxWidth: 900 }}>
        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 1</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Cargar elegibilidades</div>
          <p>Sube el CSV de <em>alumno → materias posibles</em> con columna <code>turno</code>.</p>
          <a href="/upload">Ir a /upload →</a>

          <div style={{ marginTop: 12, background: "#f9fafc", padding: 12, borderRadius: 8 }}>
            <strong>Estado de carga:</strong>
            {last ? (
              <div style={{ marginTop: 6 }}>
                <div>Archivo: {last.filename}</div>
                <div>Filas: {last.rows_valid}/{last.rows_total} válidas (inválidas: {last.rows_invalid})</div>
                <div>Alumnos: {last.students_upserted} · Materias: {last.courses_upserted} · Elegibilidades: {last.eligibilities_upserted}</div>
              </div>
            ) : (
              <div style={{ marginTop: 6, color: "#888" }}>Sin carga de archivo</div>
            )}
          </div>
        </li

        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 2</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Revisar salones y Restricciones</div>
          <p>Administra salones y define <em>hora de inicio</em> por turno (matutino, vespertino, sabatino, dominical).</p>
          <a href="/settings">Ir a Ajustes (General) →</a>
        </li>

        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 3</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Asignar y ver vista previa</div>
          <p>Genera grupos, horarios y asignación propuesta (sin escribir en DB).</p>
          <a href="/assign">Ir a Vista previa →</a>
        </li>
      </ol>
    </main>
  );
}
