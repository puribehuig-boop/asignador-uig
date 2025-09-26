"use client";
import { useState } from "react";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setResult(null);
    if (!file) return setError("Selecciona un archivo CSV.");
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("filename", file.name);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Error al subir");
      setResult(json);
    } catch (err: any) { setError(err.message || "Error desconocido"); }
    finally { setLoading(false); }
  };

  return (
    <main style={{ padding: 24, lineHeight: 1.4, maxWidth: 720 }}>
      <h1>Subir CSV de ELEGIBILIDADES (alumno → materias posibles)</h1>
      <p>Este CSV <strong>NO</strong> asigna alumnos; solo registra elegibilidades y el <strong>turno del alumno</strong>.</p>
      <p>Encabezados requeridos (exactos): <code>student_code,student_name,course_code,course_name,turno</code></p>
      <pre style={{ background: "#f5f5f5", padding: 12, overflow: "auto" }}>
{`student_code,student_name,course_code,course_name,turno
A001,María López,MAT101,Álgebra I,matutino
A001,María López,PHY100,Física,matutino
A002,Juan Pérez,MAT101,Álgebra I,vespertino
A003,Ana Ruiz,ENG110,Inglés I,sabatino`}
      </pre>

      <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <div style={{ marginTop: 12 }}>
          <button disabled={loading || !file} type="submit">{loading ? "Subiendo..." : "Subir CSV"}</button>
        </div>
      </form>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>⚠️ {error}</p>}

      {result?.ok && (
        <div style={{ marginTop: 16, background: "#eefbf0", padding: 12 }}>
          <h3>Resumen de carga</h3>
          <ul>
            <li>Archivo: {result.file?.filename}</li>
            <li>Total filas: {result.summary.rows_total}</li>
            <li>Válidas: {result.summary.rows_valid} · Inválidas: {result.summary.rows_invalid}</li>
            <li>Alumnos upserted: {result.summary.students_upserted}</li>
            <li>Materias upserted: {result.summary.courses_upserted}</li>
            <li>Elegibilidades upserted: {result.summary.eligibilities_upserted}</li>
          </ul>
        </div>
      )}
    </main>
  );
}
