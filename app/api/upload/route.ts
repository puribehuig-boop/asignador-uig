// app/api/upload/route.ts
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Utilidades de normalización
function stripDiacritics(s: string) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}
function normCode(raw: string | null | undefined) {
  if (!raw) return "";
  const s = stripDiacritics(String(raw))
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  // normaliza guiones: sin espacios a los lados y colapsa múltiples
  return s.replace(/\s*-\s*/g, "-").replace(/-+/g, "-");
}

type Turno = "matutino" | "vespertino" | "sabatino" | "dominical";
type Row = {
  student_code: string;
  student_name?: string | null;
  course_code: string;
  course_name?: string | null;
  turno?: Turno | null;
};

export async function POST(req: Request) {
  try {
    // 1) Leer archivo
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) throw new Error("Falta archivo CSV (campo 'file').");
    const fileName = (file as any)?.name ?? null;

    const buf = Buffer.from(await file.arrayBuffer());
    const text = buf.toString("utf-8");

    // 2) Parse CSV con headers normalizados
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) =>
        stripDiacritics(String(h))
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_"),
    });

    if (parsed.errors?.length) {
      const msg = parsed.errors.map(e => `${e.type}@${e.row}:${e.message}`).slice(0, 3).join(" | ");
      throw new Error("Error al parsear CSV: " + msg);
    }

    // 3) Normalizar filas al esquema
    const rawRows = (parsed.data as any[]).filter(Boolean);
    const rows: Row[] = [];
    for (const r of rawRows) {
      const student_code = normCode(r.student_code || r.alumno || r.codigo || "");
      const student_name = (r.student_name ?? r.nombre ?? "")?.toString().trim() || null;
      const course_code = normCode(r.course_code || r.materia || r.clave || "");
      const course_name = (r.course_name ?? r.nombre_materia ?? "")?.toString().trim() || null;
      const turnoRaw = (r.turno ?? "")?.toString().trim().toLowerCase();

      if (!student_code || !course_code) continue;

      let turno: Row["turno"] = null;
      if (turnoRaw && ["matutino", "vespertino", "sabatino", "dominical"].includes(turnoRaw)) {
        turno = turnoRaw as Turno;
      }

      rows.push({ student_code, student_name, course_code, course_name, turno });
    }

    if (rows.length === 0) throw new Error("CSV sin filas válidas.");

    // =========================================================
    // RESET DURO (destructivo): deja BD exactamente como el CSV
    // =========================================================
    {
      const delElig = await supabaseAdmin
        .from("student_eligibilities")
        .delete()
        .not("student_id", "is", null);
      if (delElig.error) throw delElig.error;

      const delStudents = await supabaseAdmin
        .from("students")
        .delete()
        .not("id", "is", null);
      if (delStudents.error) throw delStudents.error;

      const delCourses = await supabaseAdmin
        .from("courses")
        .delete()
        .not("id", "is", null);
      if (delCourses.error) throw delCourses.error;
    }

    // =========================================================
    // Insertar COURSES y STUDENTS (deduplicados desde el CSV)
    // =========================================================
    const courseMap = new Map<string, { code: string; name: string | null }>();
    for (const r of rows) {
      if (!courseMap.has(r.course_code)) {
        courseMap.set(r.course_code, { code: r.course_code, name: r.course_name || null });
      }
    }

    const studentMap = new Map<string, { code: string; name: string | null; shift: Row["turno"] }>();
    for (const r of rows) {
      if (!studentMap.has(r.student_code)) {
        studentMap.set(r.student_code, { code: r.student_code, name: r.student_name || null, shift: r.turno || null });
      } else {
        const prev = studentMap.get(r.student_code)!;
        if (!prev.name && r.student_name) prev.name = r.student_name;
        if (!prev.shift && r.turno) prev.shift = r.turno;
      }
    }

    const { error: insCoursesErr } = await supabaseAdmin
      .from("courses")
      .insert(Array.from(courseMap.values()));
    if (insCoursesErr) throw insCoursesErr;

    const { error: insStudentsErr } = await supabaseAdmin
      .from("students")
      .insert(Array.from(studentMap.values()));
    if (insStudentsErr) throw insStudentsErr;

    // =========================================================
    // Mapear IDs y construir parejas únicas (student_id, course_id)
    // =========================================================
    const { data: sRows, error: sSelErr } = await supabaseAdmin
      .from("students")
      .select("id, code");
    if (sSelErr) throw sSelErr;

    const { data: cRows, error: cSelErr } = await supabaseAdmin
      .from("courses")
      .select("id, code");
    if (cSelErr) throw cSelErr;

    const studentIdByCode = new Map<string, string>(
      (sRows ?? []).map((x: any) => [x.code as string, x.id as string] as const)
    );
    const courseIdByCode = new Map<string, string>(
      (cRows ?? []).map((x: any) => [x.code as string, x.id as string] as const)
    );

    const pairsSet = new Set<string>();
    const pairs: { student_id: string; course_id: string }[] = [];
    let skippedNoStudent = 0, skippedNoCourse = 0, inputPairs = 0;

    for (const r of rows) {
      const sid = studentIdByCode.get(r.student_code);
      const cid = courseIdByCode.get(r.course_code);
      if (!sid) { skippedNoStudent++; continue; }
      if (!cid) { skippedNoCourse++; continue; }
      inputPairs++;
      const key = `${sid}|${cid}`;
      if (pairsSet.has(key)) continue;
      pairsSet.add(key);
      pairs.push({ student_id: sid, course_id: cid });
    }

    // =========================================================
    // Insertar ELEGIBILIDADES
    // =========================================================
    const { error: insEligErr, count: insertedCount } = await supabaseAdmin
      .from("student_eligibilities")
      .insert(pairs, { count: "exact" });
    if (insEligErr) throw insEligErr;

    // =========================================================
    // Summary + auditoría (upload_audit)
    // =========================================================
    const summary = {
      destructive_reset: true,
      students_inserted: studentMap.size,
      courses_inserted: courseMap.size,
      input_rows: rows.length,
      input_pairs_built: inputPairs,
      unique_pairs_inserted: pairs.length,
      inserted_count_from_db: insertedCount ?? null,
      skipped_no_student: skippedNoStudent,
      skipped_no_course: skippedNoCourse,
    };

    // Registrar auditoría (requiere tabla upload_audit creada)
    await supabaseAdmin.from("upload_audit").insert({
      file_name: fileName,
      students_count: studentMap.size,
      courses_count: courseMap.size,
      eligibilities_count: pairs.length,
      input_rows: rows.length,
      summary, // jsonb
    });

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
