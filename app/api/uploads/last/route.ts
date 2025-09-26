import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("file_uploads")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const last = data?.[0];
  if (!last) return NextResponse.json({ ok: true, last: null });

  return NextResponse.json({
    ok: true,
    last: {
      filename: last.filename,
      uploaded_at: last.uploaded_at,
      rows_total: last.rows_total,
      rows_valid: last.rows_valid,
      rows_invalid: last.rows_invalid,
      students_upserted: last.students_upserted,
      courses_upserted: last.courses_upserted,
      eligibilities_upserted: last.eligibilities_upserted,
    },
  });
}
