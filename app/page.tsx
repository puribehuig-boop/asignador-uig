// app/page.tsx
export const revalidate = 0;
export const dynamic = "force-dynamic";

import Link from "next/link";
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

function Card({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        marginTop: 20,
        padding: 16,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280" }}>Paso {step}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{title}</div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

export default async function Home() {
  const last = await getLastUpload();

  return (
    <main style={{ padding: 24, lineHeight: 1.45, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Asignador UIG</h1>
      <p style={{ color: "#6b7280", marginTop: 4 }}>Flujo recomendado</p>

      {/* PASO 1: Cargar elegibilidades */}
      <Card step={1} title="Cargar elegibilidades">
        <p>
          Sube el CSV de <b>alumno → materias posibles</b> con la columna <code>turno</code>.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
          <Link href="/upload" style={{ color: "#2563eb", fontWeight: 600, textDecoration: "none" }}>
            Ir a /upload →
          </Link>
        </div>

        <div
          style={{
            marginTop: 12,
            background: "#f9fafb",
            padding: 12,
            borderRadius: 8,
            border: "1px dashed #e5e7eb",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Estado de carga</div>
          {last ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div>
                <b>Archivo:</b> {last.file_name ?? "—"}
              </div>
              <div>
                <b>Fecha:</b>{" "}
                {new Date(last.created_at).toLocaleString("es-MX", {
                  hour12: false,
                })}
              </div>
              <div>
                <b>Alumnos:</b> {last.students_count ?? 0} ·{" "}
                <b>Materias:</b> {last.courses_count ?? 0} ·{" "}
                <b>Elegibilidades:</b> {last.eligibilities_count ?? 0} ·{" "}
                <b>Filas CSV:</b> {last.input_rows ?? 0}
              </div>
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Sin carga de archivo</div>
          )}
        </div>
      </Card>

      {/* PASO 2: Ajustes */}
      <Card step={2} title="Revisar salones y restricciones">
        <p style={{ marginBottom: 8 }}>
          Configura <b>salones</b> y <b>parámetros por turno</b> (inicio, duración, número de slots, “sin descanso”, etc.).
        </p>
        <Link href="/settings" style={{ color: "#2563eb", fontWeight: 600, textDecoration: "none" }}>
          Ir a /settings →
        </Link>

        {/* Lista de restricciones fijas (solo informativas) */}
        <div style={{ marginTop: 12, background: "#f9fafb", padding: 12, borderRadius: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Restricciones (informativas)</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Ningún alumno puede tener dos clases a la misma hora.</li>
            <li>Clases se asignan en horarios seguidos (si “sin descanso” está activo).</li>
            <li>Un alumno no puede tomar la misma materia más de una vez.</li>
            <li>No hay solapamiento de grupos en el mismo salón.</li>
          </ul>
        </div>
      </Card>

      {/* PASO 3: Asignar y Previsualizar */}
      <Card step={3} title="Asignar y ver vista previa">
        <p style={{ marginBottom: 8 }}>
          Genera una asignación factible y revisa las pestañas <b>Materias</b>, <b>Alumnos</b> y <b>Horarios</b>.
        </p>
        <Link href="/assign" style={{ color: "#2563eb", fontWeight: 600, textDecoration: "none" }}>
          Ir a /assign →
        </Link>

        <div
          style={{
            marginTop: 12,
            background: "#f9fafb",
            padding: 12,
            borderRadius: 8,
            border: "1px dashed #e5e7eb",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Sugerencias</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Si hay poca cobertura, ajusta <b>slots por turno</b> o habilita “sin descanso” para más continuidad.
            </li>
            <li>
              Aumenta <b>secciones por curso y slot</b> en Ajustes si hay mucha demanda en un turno.
            </li>
          </ul>
        </div>
      </Card>
    </main>
  );
}
