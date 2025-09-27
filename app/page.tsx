// app/page.tsx
export const revalidate = 0;              // desactiva ISR
export const dynamic = "force-dynamic";   // fuerza contenido dinámico

import { supabaseAdmin } from "@/lib/supabase/server";

type UploadAudit = {
  file_name: string | null;
  students_count: number | null;
  courses_count: number | null;
  eligibilities_count: number | null;
  input_rows: number | null;
  created_at: string; // ISO
};

async function getLastUpload(): Promise<UploadAudit | null> {
  const { data, error } = await supabaseAdmin
    .from("upload_audit")
    .select("file_name, students_count, courses_count, eligibilities_count, input_rows, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data as any;
}

export default async function Home() {
  const last = await getLastUpload();

  return (
    <main style={{ padding: 24 }}>
      <h1>Asignador UIG</h1>

      <section style={{ marginTop: 20, padding: 16, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ fontSize: 12, color: "#888" }}>Paso 1</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Cargar elegibilidades</div>
        <p>Sube el CSV de alumno → materias posibles con columna “turno”.</p>
        <a href="/upload">Ir a /upload →</a>

        <div style={{ marginTop: 12, background: "#f9fafc", padding: 12, borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Estado de carga</div>

          {last ? (
            <div style={{ lineHeight: 1.6 }}>
              <div><b>Archivo:</b> {last.file_name ?? "—"}</div>
              <div>
                <b>Fecha:</b>{" "}
                {new Date(last.created_at).toLocaleString("es-MX", { hour12: false })}
              </div>
              <div>
                <b>Alumnos:</b> {last.students_count ?? 0} ·{" "}
                <b>Materias:</b> {last.courses_count ?? 0} ·{" "}
                <b>Elegibilidades:</b> {last.eligibilities_count ?? 0} ·{" "}
                <b>Filas CSV:</b> {last.input_rows ?? 0}
              </div>
            </div>
          ) : (
            <div style={{ color: "#666" }}>Sin carga de archivo</div>
          )}
        </div>
      </section>

      {/* ...resto de tu flujo (Ajustes, Asignar, etc.) */}
    </main>
  );
}
