// app/api/upload/route.ts
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

function normCode(raw: string | null | undefined) {
  if (!raw) return "";
  // Quita acentos, mayúsculas, colapsa espacios y normaliza guiones
  const s = raw
    .normalize("NFKD").replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  return s.replace(/\s*-\s*/g, "-").replace(/-+/g, "-");
}

type Row = {
  student_code: string;
  student_name?: string | null;
  course_code: string;
  course_name?: string | null;
  turno?: "matutino" | "vespertino" | "sabatino" | "dominical" | null;
};

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) throw new Error("Falta archivo CSV (campo 'file').");

    const buf = Buffer.from(await file.arrayBuffer());
    const text = buf.toString("utf-8");

    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) =>
        h
          .normalize("NFKD").replace(/\p{Diacritic}/gu, "")
          .trim().toLowerCase().replace(/\s+/g, "_"),
    });

    if (parsed.errors?.length) {
      const msg = parsed.errors.map(e => `${e.type}@${e.row}:${e.message}`).slice(0,3).join(" | ");
      throw new Error("Error al parsear CSV: " + msg);
    }

    // Normaliza filas del CSV a nuestro esquema
    const rawRows = (parsed.data as any[]).filter(Boolean);
    const rows: Row[] = [];
    for (const r of rawRows) {
      const student_code = normCode(r.student_code || r.alumno || r.codigo || "");
      const student_name = (r.student_name ?? r.nombre ?? "")?.toString().trim() || null;
      const course_code  = normCode(r.course_code  || r.materia || r.clave  || "");
      const course_name  = (r.course_name ?? r.nombre_materia ?? "")?.toString().trim() || null;
      const turno = (r.turno ?? "")?.toString().trim().toLowerCase() || null;

      if (!student_code || !course_code) continue;

      // valida turno si viene
      let t: Row["turno"] = null;
      if (turno) {
        if (["matutino","vespertino","sabatino","dominical"].includes(turno)) {
          t = turno as any;
        } else {
          // ignora valores no válidos
          t = null;
        }
      }

      rows.push({ student_code, student_name, course_code, course_name, turno: t });
    }

    if (rows.length === 0) throw new Error("CSV sin filas válidas.");

    // =========================================================
    // 0) RESET DURO: ELIMINA TODO (eligibilities -> students -> courses)
    //    Nota: no toca rooms ni system_settings
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
    // 1) INSERTA COURSES y STUDENTS (a partir del CSV normalizado)
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
// 2) MAPEA IDs y CREA PARES (student_id, course_id) SIN DUPLICADOS
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
    // 3) INSERTA ELEGIBILIDADES (tabla está vacía)
    // =========================================================
    const { error: insEligErr, count: insertedCount } = await supabaseAdmin
      .from("student_eligibilities")
      .insert(pairs, { count: "exact" });
    if (insEligErr) throw insEligErr;

    // ... ya calculaste 'summary', 'rows', 'studentMap', 'courseMap', 'pairs'

await supabaseAdmin.from("upload_audit").insert({
  file_name: (file as any)?.name ?? null,
  students_count: studentMap.size,
  courses_count: courseMap.size,
  eligibilities_count: pairs.length,
  input_rows: rows.length,
  summary, // jsonb
});


    // =========================================================
    // 4) RESPUESTA RESUMEN
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

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
