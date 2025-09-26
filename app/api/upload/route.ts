import { NextResponse } from "next/server";
import Papa from "papaparse";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Normalización de headers: BOM, acentos, espacios -> underscore; sinónimos a clave canónica
const normalizeHeader = (h: string) => {
  const raw = (h ?? "").toString().replace(/\uFEFF/g, "").trim().toLowerCase();
  const noAccent = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const key = noAccent.replace(/\s+/g, "_");
  if (key === "shift" || key === "turnos") return "turno";
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

function chunk<T>(arr: T[], size = 800): T[][] {
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

    // 2) Parseo CSV con normalización de encabezados
    const text = await file.text();
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
    });

    const rawRows = (parsed.data as any[]) ?? [];
    const rows: Row[] = [];
    let invalid = 0;

    for (const r of rawRows) {
      if (!r || typeof r !== "object" || Object.keys(r).length === 0) { invalid++; continue; }
      const cleaned: Row = {
        student_code: (r.student_code ?? "").toString().trim(),
        student_name: ((r.student_name ?? "") || "").toString().trim() || null,
        course_code: (r.course_code ?? "").toString().trim(),
        course_name: ((r.course_name ?? "") || "").toString().trim() || null,
        turno: (((r.turno ?? "") || "").toString().trim().toLowerCase() || null) as any,
      };
      const ok = RowSchema.safeParse(cleaned);
      if (ok.success) rows.push(ok.data); else invalid++;
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No se encontraron filas válidas. Encabezados requeridos: student_code, student_name, course_code, course_name, turno." },
        { status: 400 }
      );
    }

    // 3) Catálogos y elegibilidades
    type StudentBrief = { code: string; name: string | null; shift: string | null };
    const studentByCode = new Map<string, StudentBrief>();
    const courseByCode = new Map<string, { code: string; name: string | null }>();
    const eligSet = new Set<string>(); // "student_code|course_code"

    for (const r of rows) {
      // students
      if (!studentByCode.has(r.student_code)) {
        studentByCode.set(r.student_code, { code: r.student_code, name: r.student_name ?? null, shift: r.turno ?? null });
      } else {
        const prev = studentByCode.get(r.student_code)!;
        if (!prev.name && r.student_name) prev.name = r.student_name;
        if (!prev.shift && r.turno) prev.shift = r.turno;
      }
      // courses
      if (!courseByCode.has(r.course_code)) {
        courseByCode.set(r.course_code, { code: r.course_code, name: r.course_name ?? null });
      } else {
        const prev = courseByCode.get(r.course_code)!;
        if (!prev.name && r.course_name) prev.name = r.course_name;
      }
      // elig
      eligSet.add(`${r.student_code}|${r.course_code}`);
    }

    // upsert students SOLO con {code,name} (sin shift aún)
    const studentsCatalog = Array.from(studentByCode.values())
      .filter(s => s.code && s.code.trim().length > 0)
      .map(s => ({ code: s.code.trim(), name: s.name ?? null }));

    if (studentsCatalog.length === 0) {
      return NextResponse.json({ ok: false, error: "No se encontraron códigos de alumno válidos (student_code)." }, { status: 400 });
    }

    let studentRows: { id: string; code: string }[] = [];
    for (const part of chunk(studentsCatalog)) {
      const { data, error } = await supabaseAdmin
        .from("students")
        .upsert(part, { onConflict: "code" })
        .select("id, code");
      if (error) throw new Error(`Error al guardar alumnos: ${error.message}`);
      if (data?.length) studentRows = studentRows.concat(data);
    }
    // re-consulta por si faltó algún id
    if (studentRows.length < studentsCatalog.length) {
      const { data, error } = await supabaseAdmin
        .from("students")
        .select("id, code")
        .in("code", studentsCatalog.map(s => s.code));
      if (error) throw new Error(`Error al reconsultar alumnos: ${error.message}`);
      if (data?.length) studentRows = data;
    }
    const studentIdByCode = new Map(studentRows.map(r => [r.code, r.id]));

    // ACTUALIZAR shift SOLO donde viene (update por id, nunca upsert)
    const shiftPairs = Array.from(studentByCode.values())
      .filter(s => !!s.shift)
      .map(s => ({ code: s.code, id: studentIdByCode.get(s.code), shift: s.shift as string }))
      .filter(x => !!x.id) as { code: string; id: string; shift: string }[];

    for (const part of chunk(shiftPairs, 200)) {
      for (const row of part) {
        const { error } = await supabaseAdmin
          .from("students")
          .update({ shift: row.shift })
          .eq("id", row.id);
        if (error) throw new Error(`Error al actualizar turno de alumnos: ${error.message}`);
      }
    }

    // upsert courses
    const coursesCatalog = Array.from(courseByCode.values())
      .filter(c => c.code && c.code.trim().length > 0)
      .map(c => ({ code: c.code.trim(), name: c.name ?? null }));

    if (coursesCatalog.length === 0) {
      return NextResponse.json({ ok: false, error: "No se encontraron códigos de materia válidos (course_code)." }, { status: 400 });
    }

    let courseRows: { id: string; code: string }[] = [];
    for (const part of chunk(coursesCatalog)) {
      const { data, error } = await supabaseAdmin
        .from("courses")
        .upsert(part, { onConflict: "code" })
        .select("id, code");
      if (error) throw new Error(`Error al guardar materias: ${error.message}`);
      if (data?.length) courseRows = courseRows.concat(data);
    }
    if (courseRows.length < coursesCatalog.length) {
      const { data, error } = await supabaseAdmin
        .from("courses")
        .select("id, code")
        .in("code", coursesCatalog.map(c => c.code));
      if (error) throw new Error(`Error al reconsultar materias: ${error.message}`);
      if (data?.length) courseRows = data;
    }
    const courseIdByCode = new Map(courseRows.map(r => [r.code, r.id]));

    // elegibilidades
    const eligRows = Array.from(eligSet.values())
      .map(k => {
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

    // metadatos archivo
    const { data: rec, error: upErr } = await supabaseAdmin
      .from("file_uploads")
      .insert({
        filename,
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: studentsCatalog.length,
        courses_upserted: coursesCatalog.length,
        eligibilities_upserted: eligRows.length,
      })
      .select("id, filename, uploaded_at")
      .single();
    if (upErr) throw new Error(`Error al guardar metadatos de archivo: ${upErr.message}`);

    return NextResponse.json({
      ok: true,
      file: { id: rec.id, filename: rec.filename, uploaded_at: rec.uploaded_at },
      summary: {
        rows_total: rawRows.length,
        rows_valid: rows.length,
        rows_invalid: invalid,
        students_upserted: studentsCatalog.length,
        courses_upserted: coursesCatalog.length,
        eligibilities_upserted: eligRows.length,
      },
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error desconocido" }, { status: 500 });
  }
}
