// app/api/upload/route.ts
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Normaliza encabezados: quita BOM, acentos, espacios; sinónimos comunes a clave canónica
const normalizeHeader = (h: string) => {
  const raw = (h ?? "").toString().replace(/\uFEFF/g, "").trim().toLowerCase();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const key = noAccent.replace(/\s+/g, "_");
  if (key === "shift" || key === "turnos") return "turno";
  return key;
};

// Esquema por fila ya normalizada
const RowSchema = z.object({
  student_code: z.string().min(1),
  student_name: z.string().optional().nullable(),
  course_code: z.string().min(1),
  course_name: z.string().optional().nullable(),
  turno: z
    .enum(["matutino", "vespertino", "sabatino", "dominical"])
    .optional()
    .nullable(),
});
type Row = z.infer<typeof RowSchema>;

function chunk<T>(arr: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(req: Request) {
  try {
    // 1) Recibir archivo
    const form = await req.formData();
    const file = form.get("file");
    const filename = (form.get("filename") || "upload.csv") as string;
    if (!(file instanceof Blob)) {
      return NextResponse.json({ ok: false, error: "Archivo no recibido" }, { status: 400 });
    }

    // 2) Leer y parsear CSV con normalización de encabezados
    const text = await file.text();
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
    });

    const rawRows = (parsed.data as any[]) ?? [];
    let invalid = 0;
    const rows: Row[] = [];

    // 3) Limpiar y validar filas
    for (const r of rawRows) {
      // En algunos casos papaparse puede introducir filas vacías como {}
      if (!r || typeof r !== "object" || Object.keys(r).length === 0) {
        invalid++;
        continue;
      }

      const cleaned = {
        student_code: (r.student_code ?? "").toString().trim(),
        student_name: ((r.student_name ?? "") || "").toString().trim() || null,
        course_code: (r.course_code ?? "").toString().trim(),
        course_name: ((r.course_name ?? "") || "").toString().trim() || null,
        turno: (((r.turno ?? "") || "").toString().trim().toLowerCase() || null) as
          | "matutino"
          | "vespertino"
          | "sabatino"
          | "dominical"
          | null,
      };

      const res = RowSchema.safeParse(cleaned);
      if (res.success) {
        rows.push(res.data);
      } else {
        invalid++;
      }
    }

    // Si no hay filas válidas, abortar
    if (rows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No se encontraron filas válidas. Revisa encabezados requeridos: student_code, student_name, course_code, course_name, turno.",
        },
        { status: 400 }
      );
    }

    // 4) Deduplicar y preparar catálogos + elegibilidades
    type StudentBrief = { code: string; name: string | null; shift: string | null };
    const studentByCode = new Map<string, StudentBrief>();
    const courseByCode = new Map<string, { code: string; name: string | null }>();
    const eligSet = new Set<string>(); // "student_code|course_code"

    for (const r of rows) {
      // Students
      if (!studentByCode.has(r.student_code)) {
        studentByCode.set(r.student_code, {
          code: r.student_code,
          name: r.student_name ?? null,
          shift: r.turno ?? null,
        });
      } else {
        const prev = studentByCode.get(r.student_code)!;
        if (!prev.name && r.student_name) prev.name = r.student_name;
        if (!prev.shift && r.turno) prev.shift = r.turno;
      }

      // Courses
      if (!courseByCode.has(r.course_code)) {
        courseByCode.set(r.course_code, {
          code: r.course_code,
          name: r.course_name ?? null,
        });
      } else {
        const prev = courseByCode.get(r.course_code)!;
        if (!prev.name && r.course_name) prev.name = r.course_name;
      }

      // Eligibility
      eligSet.add(`${r.student_code}|${r.course_code}`);
    }

    const studentsToUpsert = Array.from(studentByCode.values())
      .filter((s) => typeof s.code === "string" && s.code.trim().length > 0)
      .map((s) => ({ code: s.code.trim(), name: s.name ?? null, shift: s.shift ?? null }));

    const coursesToUpsert = Array.from(courseByCode.values())
      .filter((c) => typeof c.code === "string" && c.code.trim().length > 0)
      .map((c) => ({ code: c.code.trim(), name: c.name ?? null }));

    if (studentsToUpsert.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No se encontraron códigos de alumno válidos (student_code)." },
        { status: 400 }
      );
    }
    if (coursesToUpsert.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No se encontraron códigos de materia válidos (course_code)." },
        { status: 400 }
      );
    }

    // 5) UPSERT students (defensivo)
    let studentRows: { id: string; code: string }[] = [];
    for (const part of chunk(studentsToUpsert)) {
      const { data, error } = await supabaseAdmin
        .from("students")
        .upsert(part, { onConflict: "code" })
        .select("id, code");
      if (error) throw new Error(`Error al guardar alumnos: ${error.message}`);
      studentRows = studentRows.concat(data || []);
    }

    // Fallback: re-consulta por ids si faltara alguno
    if (studentRows.length < studentsToUpsert.length) {
      const { data, error } = await supabaseAdmin
        .from("students")
        .select("id, code")
        .in(
          "code",
          studentsToUpsert.map((s) => s.code)
        );
      if (error) throw new Error(`Error al reconsultar alumnos: ${error.message}`);
      if (data?.length) studentRows = data;
    }
    const studentIdByCode = new Map(studentRows.map((r) => [r.code, r.id]));

    // Asegurar actualización de shift por id (sólo cuando existe id y shift no-nulo)
    const updatesShift = studentsToUpsert
      .filter((s) => !!s.shift)
      .map((s) => {
        const id = studentIdByCode.get(s.code);
        return id ? { id, shift: s.shift as string } : null;
      })
      .filter((x): x is { id: string; shift: string } => Boolean(x));

    for (const part of chunk(updatesShift, 1000)) {
      if (!part.length) continue;
      const { error } = await supabaseAdmin.from("students").upsert(part, { onConflict: "id" });
      if (error) throw new Error(`Error al actualizar turno de alumnos: ${error.message}`);
    }

    // 6) UPSERT courses (defensivo)
    let courseRows: { id: string; code: string }[] = [];
    for (const part of chunk(coursesToUpsert)) {
      const { data, error } = await supabaseAdmin
        .from("courses")
        .upsert(part, { onConflict: "code" })
        .select("id, code");
      if (error) throw new Error(`Error al guardar materias: ${error.message}`);
      courseRows = courseRows.concat(data || []);
    }

    if (courseRows.length < coursesToUpsert.length) {
      const { data, error } = await supabaseAdmin
        .from("courses")
        .select("id, code")
        .in(
          "code",
          coursesToUpsert.map((c) => c.code)
        );
      if (error) throw new Error(`Error al reconsultar materias: ${error.message}`);
      if (data?.length) courseRows = data;
    }
    const courseIdByCode = new Map(courseRows.map((r) => [r.code, r.id]));

    // 7) Preparar elegibilidades con ids (filtra cualquier par sin id)
    const eligRows = Array.from(eligSet.values())
      .map((k) => {
        const [sCode, cCode] = k.split("|");
        const sid = studentIdByCode.get(sCode);
        const cid = courseIdByCode.get(cCode);
        if (!sid || !cid) return null;
        return { student_id: sid, course_id: cid };
      })
      .filter(Boolean) as { student_id: string; course_id: string }[];

    for (const part of chunk(eligRows)) {
      const { error } = await supabaseAdmin
        .from("student_eligibilities")
        .upsert(part, { onConflict: "student_id,course_id" });
      if (error) throw new Error(`Error al guardar elegibilidades: ${error.message}`);
    }

    // 8) Guardar metadatos del archivo para Home
    const { data: rec, error: upErr } = await supabaseAdmin
      .from("file_uploads")
      .insert({
        filename,
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: studentsToUpsert.length,
        courses_upserted: coursesToUpsert.length,
        eligibilities_upserted: eligRows.length,
      })
      .select("id, filename, uploaded_at")
      .single();
    if (upErr) throw new Error(`Error al guardar metadatos de archivo: ${upErr.message}`);

    // 9) Respuesta
    return NextResponse.json({
      ok: true,
      file: { id: rec.id, filename: rec.filename, uploaded_at: rec.uploaded_at },
      summary: {
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: studentsToUpsert.length,
        courses_upserted: coursesToUpsert.length,
        eligibilities_upserted: eligRows.length,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error desconocido" }, { status: 500 });
  }
}
