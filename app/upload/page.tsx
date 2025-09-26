"use client";
import { useState } from "react";
import Papa from "papaparse";

type PreviewRow = Record<string, string | number | null | undefined>;

const normalizeHeader = (h: string) => {
  const raw = (h ?? "").toString().replace(/\uFEFF/g, "").trim().toLowerCase();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const key = noAccent.replace(/\s+/g, "_");
  // sinónimos comunes
  if (key === "shift") return "turno";
  if (key === "turnos") return "turno";
  return key;
};

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);

  const parsePreview = async (f: File) => {
    setPreviewRows(null);
    setPreviewHeaders([]);
    await new Promise<void>((resolve, reject) => {
      Papa.parse<PreviewRow>(f, {
        header: true,
        skipEmptyLines: true,
        preview: 10,
        transformHeader: normalizeHeader,
        complete: (res) => {
          const rows = (res.data as PreviewRow[]) ?? [];
          const headers = rows.length ? Object.keys(rows[0]) : (res.meta.fields || []).map(String);
          setPreviewRows(rows);
          setPreviewHeaders(headers);
          resolve();
        },
        error: (err) => reject(err),
      });
    });
  };

  const onFileChange = async (f: File | null) => {
    setFile(f);
    setResult(null);
    setError(null);
    if (f) {
      try {
        await parsePreview(f);
      } catch (e: any) {
        setPreviewRows(null);
        setPreviewHeaders([]);
        setError(e?.message || "No se pudo leer el archivo para previsualización");
      }
    } else {
      setPreviewRows(null);
      setPreviewHeaders([]);
    }
  };

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
      if (!res.ok || !json.ok) throw new Error(json?.error || "Error al subir");
      setResult(json);
    } catch (err: any) {
      setError(err.message || "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const hasTurno = previewHeaders.includes("turno");

  return (
    <main style={{ padding: 24, lineHeight: 1.4, maxWidth: 900 }}>
      <h1>Subir CSV de ELEGIBILIDADES (alumno → materias posibles)</h1>
      <p>Encabezados esperados (normalizamos mayúsculas/espacios/acentos): <code>student_code, student_name, course_code, course_name, turno</code></p>

      <pre style={{ background: "#f5f5f5", padding: 12, overflow: "auto" }}>
{`student_code,student_name,course_code,course_name,turno
A001,María López,MAT101,Álgebra I,matutino
A001,María López,PHY100,Física,matutino
A002,Juan Pérez,MAT101,Álgebra I,vespertino
A003,Ana Ruiz,ENG110,Inglés I,sabatino`}
      </pre>

      <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFileChange(e.target.files?.[0] || null)} />
        <div style={{ marginTop: 12 }}>
          <button disabled={loading || !file} type="submit">{loading ? "Subiendo..." : "Subir CSV"}</button>
        </div>
      </form>

      {/* Preview local (primeras 10 filas) */}
      {previewRows && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Vista previa (10 primeras filas)</h3>

          {!hasTurno && (
            <p style={{ color: "crimson" }}>
              ⚠️ No se detectó la columna <code>turno</code> en los encabezados (encontrados: {previewHeaders.join(", ") || "ninguno"}).
              Aceptamos también <code>Shift</code> o <code>Turnos</code> (se mapean a <code>turno</code>).
            </p>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ minWidth: 700, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {previewHeaders.map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i}>
                    {previewHeaders.map((h) => (
                      <td key={h} style={{ borderBottom: "1px solid #f0f0f0", padding: 6 }}>
                        {String(r[h] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
                {previewRows.length === 0 && (
                  <tr><td colSpan={previewHeaders.length} style={{ padding: 6, color: "#888" }}>Sin filas</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && <p style={{ color: "crimson", marginTop: 12 }}>⚠️ {error}</p>}

      {result?.ok && (
        <div style={{ marginTop: 16, background: "#eefbf0", padding: 12, borderRadius: 8 }}>
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
      
      <div style={{ marginTop: 16 }}>
        <a href="/" style={{ textDecoration: "underline" }}>← Regresar a la página principal</a>
      </div>
      )}
    </main>
  );
}
