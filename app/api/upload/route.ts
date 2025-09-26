import { NextResponse } from "next/server";
import Papa from "papaparse";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const normalizeHeader = (h: string) => {
  const raw = (h ?? "").toString().replace(/\uFEFF/g, "").trim().toLowerCase();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const key = noAccent.replace(/\s+/g, "_");
  if (key === "shift") return "turno";
  if (key === "turnos") return "turno";
  return key;
};

const RowSchema = z.object({
  student_code: z.string().min(1),
  student_name: z.string().optional().nullable(),
  course_code: z.string().min(1),
  course_name: z.string().optional().nullable(),
  turno: z.enum(["matutino","vespertino","sabatino","dominical"]).optional().nullable(),
});
type Row = z.infer<typeof RowSchema>;

function chunk<T>(arr: T[], size = 1000): T[][] { const out: T[][] = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const filename = (form.get("filename") || "upload.csv") as string;
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "Archivo no recibido" }, { status: 400 });
    }

    const text = await file.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: normalizeHeader });
    const rawRows = (parsed.data as any[]) ?? [];
    const rows: Row[] = [];
    let invalid = 0;

    for (const r of rawRows) {
      const cleaned = {
        student_code: (r.student_code ?? "").toString().trim(),
        student_name: (r.student_name ?? "").toString().trim() || null,
        course_code: (r.course_code ?? "").toString().trim(),
        course_name: (r.course_name ?? "").toString().trim() || null,
        turno: ((r.turno ?? "") || "").toString().trim().toLowerCase() || null,
      };
      const res = RowSchema.safeParse(cleaned);
      if (res.success) rows.push(res.data); else invalid++;
    }

    // Deduplicaciones y mapas
    const studentByCode = new Map<string, { code: string; name: string | null; shift: string | null }>();
    const courseByCode  = new Map<string, { code: string; name: string | null }>();
    const eligSet = new Set<string>(); // student_code|course_code

    for (const r of rows) {
      if (!studentByCode.has(r.student_code)) {
        studentByCode.set(r.student_code, { code: r.student_code, name: r.student_name ?? null, shift: r.turno ?? null });
      } else {
        const prev = studentByCode.get(r.student_code)!;
        if (!prev.name && r.student_name) prev.name = r.student_name;
        if (!prev.shift && r.turno) prev.shift = r.turno;
      }
      if (!courseByCode.has(r.course_code)) {
        courseByCode.set(r.course_code, { code: r.course_code, name: r.course_name ?? null });
      } else {
        const prev = courseByCode.get(r.course_code)!;
        if (!prev.name && r.course_name) prev.name = r.course_name;
      }
      eligSet.add(`${r.student_code}|${r.course_code}`);
    }

    const students = Array.from(studentByCode.values());
    const courses  = Array.from(courseByCode.values());
    const eligPairs = Array.from(eligSet.values()).map(k => {
      const [s,c] = k.split("|"); return { student_code: s, course_code: c };
    });

    // ========================= UPSERT students (defensivo) =========================
let studentsToUpsert = Array.from(studentByCode.values())
  .filter((s) => typeof s.code === "string" && s.code.trim().length > 0) // <-- filtro duro
  .map((s) => ({ code: s.code.trim(), name: s.name ?? null, shift: s.shift ?? null }));

if (studentsToUpsert.length === 0) {
  return NextResponse.json(
    { ok: false, error: "No se encontraron códigos de alumno válidos (student_code)." },
    { status: 400 }
  );
}

let studentRows: { id: string; code: string }[] = [];
for (const part of chunk(studentsToUpsert)) {
  const { data, error } = await supabaseAdmin
    .from("students")
    .upsert(part, { onConflict: "code" })
    .select("id, code");
  if (error) {
    // Mensaje explícito si llegara algo sin code
    throw new Error(`Error al guardar alumnos: ${error.message}`);
  }
  studentRows = studentRows.concat(data || []);
}

// Re-consulta por si faltó algún id devuelto
if (studentRows.length < studentsToUpsert.length) {
  const { data, error } = await supabaseAdmin
    .from("students")
    .select("id, code")
    .in("code", studentsToUpsert.map((s) => s.code));
  if (error) throw error;
  if (data) studentRows = data;
}

const studentIdByCode = new Map(studentRows.map((r) => [r.code, r.id]));

// Asegurar actualización de shift (null-safe, sólo filas con id)
const updatesShift = studentsToUpsert
  .filter((s) => !!s.shift)
  .map((s) => {
    const id = studentIdByCode.get(s.code);
    return id ? { id, shift: s.shift as string } : null;
  })
  .filter((x): x is { id: string; shift: string } => Boolean(x));

for (const part of chunk(updatesShift, 1000)) {
  if (!part.length) continue;
  const { error } = await supabaseAdmin
    .from("students")
    .upsert(part, { onConflict: "id" });
  if (error) throw error;
}
// ======================= FIN UPSERT students (defensivo) =======================


  // UPSERT courses
    let courseRows: { id: string; code: string }[] = [];
    for (const part of chunk(courses)) {
      const { data, error } = await supabaseAdmin
        .from("courses")
        .upsert(part, { onConflict: "code" })
        .select("id, code");
      if (error) throw error;
      courseRows = courseRows.concat(data || []);
    }
    if (courseRows.length < courses.length) {
      const { data, error } = await supabaseAdmin.from("courses").select("id, code").in("code", courses.map(c=>c.code));
      if (error) throw error;
      courseRows = data || courseRows;
    }
    const courseIdByCode = new Map(courseRows.map(r => [r.code, r.id]));

    // Inserta elegibilidades
    const eligRows = eligPairs.map(({ student_code, course_code }) => {
      const sid = studentIdByCode.get(student_code);
      const cid = courseIdByCode.get(course_code);
      if (!sid || !cid) return null;
      return { student_id: sid, course_id: cid };
    }).filter(Boolean) as { student_id: string; course_id: string }[];

    for (const part of chunk(eligRows)) {
      const { error } = await supabaseAdmin
        .from("student_eligibilities")
        .upsert(part, { onConflict: "student_id,course_id" });
      if (error) throw error;
    }

    // Guarda metadatos del archivo
    const { data: rec, error: upErr } = await supabaseAdmin
      .from("file_uploads")
      .insert({
        filename,
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: students.length,
        courses_upserted: courses.length,
        eligibilities_upserted: eligRows.length,
      })
      .select("id, filename, uploaded_at")
      .single();
    if (upErr) throw upErr;

    return NextResponse.json({
      ok: true,
      file: { id: rec.id, filename: rec.filename, uploaded_at: rec.uploaded_at },
      summary: {
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: students.length,
        courses_upserted: courses.length,
        eligibilities_upserted: eligRows.length,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e.message ?? "Error desconocido" }, { status: 500 });
  }
}
