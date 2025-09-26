"use client";

import React, { useEffect, useState } from "react";

type LastUpload = {
  filename: string;
  uploaded_at: string;
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  students_upserted: number;
  courses_upserted: number;
  eligibilities_upserted: number;
} | null;

export default function Home() {
  const [last, setLast] = useState<LastUpload>(null);
  const [loading, setLoading] = useState(false);

  const loadLast = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/uploads/last", { cache: "no-store" });
      const json = await res.json();
      if (json?.ok) setLast(json.last as LastUpload);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLast();
  }, []);

  return (
    <main style={{ padding: 24, lineHeight: 1.4 }}>
      <h1>Asignador UIG</h1>
      <p style={{ color: "#555" }}>Flujo recomendado</p>

      <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: 12, maxWidth: 900 }}>
        {/* Paso 1 */}
        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 1</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Cargar elegibilidades</div>
          <p>Sube el CSV de alumno &rarr; materias posibles con columna "turno".</p>
          <a href="/upload">Ir a /upload &rarr;</a>

          <div style={{ marginTop: 12, background: "#f9fafc", padding: 12, borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong>Estado de carga:</strong>
              <button
                type="button"
                onClick={loadLast}
                disabled={loading}
                style={{ padding: "4px 8px", fontSize: 12 }}
              >
                {loading ? "Actualizando..." : "Actualizar"}
              </button>
            </div>

            {last ? (
              <div style={{ marginTop: 6 }}>
                <div>Archivo: {last.filename}</div>
                <div>
                  Filas: {last.rows_valid}/{last.rows_total} validas (invalidas: {last.rows_invalid})
                </div>
                <div>
                  Alumnos: {last.students_upserted} · Materias: {last.courses_upserted} · Elegibilidades: {last.eligibilities_upserted}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 6, color: "#888" }}>Sin carga de archivo</div>
            )}
          </div>
        </li>

        {/* Paso 2 */}
        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 2</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Revisar salones y restricciones</div>
          <p>Administra salones y define hora de inicio, duracion y descansos por turno.</p>
          <a href="/settings">Ir a Ajustes (General) &rarr;</a>
        </li>

        {/* Paso 3 */}
        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 3</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Asignar y ver vista previa</div>
          <p>Genera grupos, horarios y asignacion propuesta (sin escribir en DB).</p>
          <a href="/assign">Ir a Vista previa &rarr;</a>
        </li>
      </ol>
    </main>
  );
}
